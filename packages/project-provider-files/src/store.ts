import { randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  truncate,
} from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import {
  GeoResearchError,
  PROJECT_EVENT_SCHEMA_VERSION,
  PROJECT_REDUCER_VERSION,
  canonicalJson,
  digestJson,
  isSha256Digest,
  nowUtc,
  type JsonValue,
  type OperationErrorRecord,
  type OperationRecord,
  type ProjectEvent,
  type ProjectReducerState,
  type ProjectStateFile,
  type Sha256Digest,
  type WorkspaceBinding,
} from '@georesearch/dsh-contracts'
import { atomicWriteJson } from './atomic.js'
import { initialProjectBinding } from './binding.js'
import { assertId, projectPaths, projectRoot, type ProjectPaths } from './paths.js'
import { reduceProjectEvent } from './reducer.js'
import { acquireProjectMutex, type ProjectMutexLease } from './win32.js'

export interface ProjectStoreConfig {
  readonly home: string
  readonly lockTimeoutMs?: number
  readonly orphanGraceMs?: number
  readonly now?: () => string
  readonly mutexFactory?: (projectId: string, timeoutMs: number) => Promise<ProjectMutexLease>
}

export interface ProjectCommitRequest {
  readonly expectedGeneration: number
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly type: string
  readonly data: JsonValue
}

export interface ProjectMutationLease {
  readonly current: ProjectStateFile
  commit(request: ProjectCommitRequest): Promise<ProjectStateFile>
}

export interface ProjectRecoveryReport {
  readonly projectId: string
  readonly truncatedEventTail: boolean
  readonly rebuiltSnapshot: boolean
  readonly recoveredOperationKeys: readonly Sha256Digest[]
  readonly removedTempPaths: readonly string[]
  readonly removedOrphanObjects: readonly string[]
  readonly incompleteRunLaunchIds: readonly string[]
}

export interface OperationExecutionOptions<T extends JsonValue> {
  readonly recover?: (record: OperationRecord) => Promise<T>
  readonly classifyError?: (error: unknown) => OperationErrorRecord & {
    readonly state: 'failed-final' | 'recovery-required'
  }
}

interface ReadEventLogResult {
  readonly events: readonly ProjectEvent[]
  readonly truncatedTail: boolean
}

interface ConsistencyResult {
  readonly stateFile: ProjectStateFile
  readonly rebuiltSnapshot: boolean
  readonly truncatedTail: boolean
}

const PROJECT_WRITE_TAILS = new Map<string, Promise<void>>()
const ACTIVE_OPERATION_LEASES = new Set<string>()

export class ProjectFileStore {
  private readonly home: string
  private readonly lockTimeoutMs: number
  private readonly orphanGraceMs: number
  private readonly clock: () => string
  private readonly mutexFactory: (projectId: string, timeoutMs: number) => Promise<ProjectMutexLease>

  constructor(config: ProjectStoreConfig) {
    this.home = config.home
    this.lockTimeoutMs = config.lockTimeoutMs ?? 2_000
    this.orphanGraceMs = config.orphanGraceMs ?? 60 * 60 * 1_000
    this.clock = config.now ?? nowUtc
    this.mutexFactory = config.mutexFactory ?? acquireProjectMutex
  }

  paths(projectId: string): ProjectPaths {
    return projectPaths(this.home, projectId)
  }

  async createProject(
    projectId: string,
    binding: WorkspaceBinding,
    operationKey: Sha256Digest,
    requestDigest: Sha256Digest,
  ): Promise<ProjectStateFile> {
    assertId(projectId, 'projectId')
    if (binding.projectId !== projectId) throw new TypeError('workspace binding projectId does not match')
    return this.serial(projectId, async () => {
      const paths = this.paths(projectId)
      await this.ensureDirectories(paths)
      const mutex = await this.mutexFactory(projectId, this.lockTimeoutMs)
      try {
        if (await exists(paths.state) || (await this.readEventLog(paths)).events.length > 0) {
          throw new GeoResearchError('PROJECT_BINDING_MISMATCH', `project ${projectId} already exists`)
        }
        const time = this.clock()
        const event = createEvent({
          seq: 1,
          time,
          operationKey,
          requestDigest,
          type: 'project.created',
          data: {
            projectBinding: initialProjectBinding(projectId, binding.workspaceId, time),
            workspaceBinding: binding,
          } as unknown as JsonValue,
          previousHash: null,
        })
        const state = reduceProjectEvent(undefined, event)
        const stateFile = createStateFile(projectId, 1, event.seq, event.hash, state)
        await appendEvent(paths.events, event)
        await atomicWriteJson(paths.state, stateFile)
        return stateFile
      } finally {
        await mutex.release()
      }
    })
  }

  async load(projectId: string): Promise<ProjectStateFile> {
    return this.serial(projectId, async () => {
      const paths = this.paths(projectId)
      const mutex = await this.mutexFactory(projectId, this.lockTimeoutMs)
      try {
        if (mutex.abandoned) {
          try {
            await this.recoverLocked(projectId, paths)
          } catch (error) {
            throw new GeoResearchError(
              'PROJECT_RECOVERY_REQUIRED',
              `project ${projectId} failed recovery after an abandoned mutex`,
              { cause: error },
            )
          }
        }
        return (await this.readConsistentLocked(projectId, paths, true)).stateFile
      } finally {
        await mutex.release()
      }
    })
  }

  async listProjectStates(): Promise<ProjectStateFile[]> {
    const root = projectRoot(this.home)
    let entries
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const states: ProjectStateFile[] = []
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory()) continue
      try {
        assertId(entry.name, 'project directory')
      } catch {
        continue
      }
      states.push(await this.load(entry.name))
    }
    return states
  }

  async commit(projectId: string, request: ProjectCommitRequest): Promise<ProjectStateFile> {
    return this.withMutationLease(projectId, lease => lease.commit(request))
  }

  async withMutationLease<T>(
    projectId: string,
    action: (lease: ProjectMutationLease) => Promise<T>,
  ): Promise<T> {
    return this.serial(projectId, async () => {
      const paths = this.paths(projectId)
      const mutex = await this.mutexFactory(projectId, this.lockTimeoutMs)
      let active = true
      let committed = false
      try {
        if (mutex.abandoned) {
          try {
            await this.recoverLocked(projectId, paths)
          } catch (error) {
            throw new GeoResearchError(
              'PROJECT_RECOVERY_REQUIRED',
              `project ${projectId} failed recovery after an abandoned mutex`,
              { cause: error },
            )
          }
        }
        const current = (await this.readConsistentLocked(projectId, paths, true)).stateFile
        return await action({
          current,
          commit: async request => {
            if (!active) throw new Error('project mutation lease is no longer active')
            if (committed) throw new Error('project mutation lease permits exactly one commit')
            validateCommitRequest(request)
            const next = await this.commitLocked(projectId, paths, current, request)
            committed = true
            return next
          },
        })
      } finally {
        active = false
        await mutex.release()
      }
    })
  }

  private async commitLocked(
    projectId: string,
    paths: ProjectPaths,
    current: ProjectStateFile,
    request: ProjectCommitRequest,
  ): Promise<ProjectStateFile> {
    if (current.generation !== request.expectedGeneration) {
      throw new GeoResearchError(
        'PROJECT_GENERATION_CONFLICT',
        `expected generation ${request.expectedGeneration}, found ${current.generation}`,
      )
    }
    const event = createEvent({
      seq: current.lastEventSeq + 1,
      time: this.clock(),
      operationKey: request.operationKey,
      requestDigest: request.requestDigest,
      type: request.type,
      data: request.data,
      previousHash: current.lastEventHash,
    })
    const state = reduceProjectEvent(current.state, event)
    const next = createStateFile(
      projectId,
      current.generation + 1,
      event.seq,
      event.hash,
      state,
    )
    await appendEvent(paths.events, event)
    await atomicWriteJson(paths.state, next)
    return next
  }

  async recover(projectId: string): Promise<ProjectRecoveryReport> {
    return this.serial(projectId, async () => {
      const paths = this.paths(projectId)
      const mutex = await this.mutexFactory(projectId, this.lockTimeoutMs)
      try {
        return await this.recoverLocked(projectId, paths)
      } finally {
        await mutex.release()
      }
    })
  }

  async executeOperation<T extends JsonValue>(
    projectId: string,
    operationKey: Sha256Digest,
    requestDigest: Sha256Digest,
    operation: string,
    action: () => Promise<T>,
    options: OperationExecutionOptions<T> = {},
  ): Promise<T> {
    if (!isSha256Digest(operationKey) || !isSha256Digest(requestDigest)) throw new TypeError('operation digests are invalid')
    if (operation.trim().length === 0) throw new TypeError('operation must be non-empty')
    const activeKey = operationLeaseKey(this.home, projectId, operationKey)
    if (ACTIVE_OPERATION_LEASES.has(activeKey)) {
      throw new GeoResearchError('OPERATION_IN_PROGRESS', `${operationKey} is still in progress`)
    }
    ACTIVE_OPERATION_LEASES.add(activeKey)
    let mutex: ProjectMutexLease
    try {
      mutex = await this.mutexFactory(operationMutexId(projectId, operationKey), 0)
    } catch (error) {
      ACTIVE_OPERATION_LEASES.delete(activeKey)
      if (lockUnavailable(error)) {
        throw new GeoResearchError('OPERATION_IN_PROGRESS', `${operationKey} is still in progress`, { cause: error })
      }
      throw error
    }
    try {
      return await this.executeOperationLocked(projectId, operationKey, requestDigest, operation, action, options)
    } finally {
      try {
        await mutex.release()
      } finally {
        ACTIVE_OPERATION_LEASES.delete(activeKey)
      }
    }
  }

  private async executeOperationLocked<T extends JsonValue>(
    projectId: string,
    operationKey: Sha256Digest,
    requestDigest: Sha256Digest,
    operation: string,
    action: () => Promise<T>,
    options: OperationExecutionOptions<T>,
  ): Promise<T> {
    const paths = this.paths(projectId)
    await mkdir(paths.operations, { recursive: true })
    const path = operationPath(paths, operationKey)
    const time = this.clock()
    const initial: OperationRecord = {
      schemaVersion: 1,
      operationKey,
      requestDigest,
      operation,
      state: 'in-progress',
      createdAt: time,
      updatedAt: time,
    }
    let ownsOperation = false
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(initial, undefined, 2)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      ownsOperation = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    if (!ownsOperation) {
      let existing = await readOperation(path, operationKey)
      if (existing.requestDigest !== requestDigest) {
        throw new GeoResearchError('IDEMPOTENCY_CONFLICT', `${operationKey} was reused with a different request digest`)
      }
      if (existing.state === 'in-progress') {
        existing = { ...existing, state: 'recovery-required', updatedAt: this.clock() }
        await atomicWriteJson(path, existing)
      }
      switch (existing.state) {
        case 'committed':
          if (existing.exactResult === undefined || existing.exactResultDigest === undefined
            || digestJson(existing.exactResult) !== existing.exactResultDigest) {
            throw new GeoResearchError('PROJECT_RECOVERY_REQUIRED', `committed operation ${operationKey} lost its exact result`)
          }
          return existing.exactResult as T
        case 'recovery-required':
          if (options.recover === undefined) {
            throw new GeoResearchError('OPERATION_RECOVERY_REQUIRED', `${operationKey} requires operation-specific recovery`)
          }
          return this.commitRecoveredOperation(path, existing, await options.recover(existing))
        case 'failed-final':
          throw storedOperationError(existing)
      }
    }
    try {
      const result = await action()
      canonicalJson(result)
      const committed: OperationRecord = {
        ...initial,
        state: 'committed',
        updatedAt: this.clock(),
        exactResult: result,
        exactResultDigest: digestJson(result),
      }
      await atomicWriteJson(path, committed)
      return result
    } catch (error) {
      const classified = options.classifyError?.(error) ?? defaultOperationError(error)
      const failed: OperationRecord = {
        ...initial,
        state: classified.state,
        updatedAt: this.clock(),
        exactError: {
          code: classified.code,
          message: classified.message,
          retryable: classified.retryable,
        },
      }
      await atomicWriteJson(path, failed)
      throw error
    }
  }

  private async commitRecoveredOperation<T extends JsonValue>(
    path: string,
    record: OperationRecord,
    result: T,
  ): Promise<T> {
    canonicalJson(result)
    const committed: OperationRecord = {
      schemaVersion: 1,
      operationKey: record.operationKey,
      requestDigest: record.requestDigest,
      operation: record.operation,
      state: 'committed',
      createdAt: record.createdAt,
      updatedAt: this.clock(),
      exactResult: result,
      exactResultDigest: digestJson(result),
    }
    await atomicWriteJson(path, committed)
    return result
  }

  private async recoverLocked(projectId: string, paths: ProjectPaths): Promise<ProjectRecoveryReport> {
    await this.ensureDirectories(paths)
    const consistent = await this.readConsistentLocked(projectId, paths, true)
    const recoveredOperationKeys = await recoverOperations(
      projectId,
      this.home,
      paths.operations,
      this.clock,
      this.mutexFactory,
    )
    const removedTempPaths = await removeAgedFiles(paths.temp, this.orphanGraceMs)
    const referenced = new Set(Object.values(consistent.stateFile.state.artifacts).map(artifact => artifact.objectPath))
    const removedOrphanObjects = await removeOrphanObjects(paths, referenced, this.orphanGraceMs)
    await assertNoIncompleteContinuationAdvance(paths.continuations)
    const incompleteRunLaunchIds = await scanIncompleteRunLaunches(paths.runs)
    return {
      projectId,
      truncatedEventTail: consistent.truncatedTail,
      rebuiltSnapshot: consistent.rebuiltSnapshot,
      recoveredOperationKeys,
      removedTempPaths,
      removedOrphanObjects,
      incompleteRunLaunchIds,
    }
  }

  private async readConsistentLocked(
    projectId: string,
    paths: ProjectPaths,
    repair: boolean,
  ): Promise<ConsistencyResult> {
    const eventLog = await this.readEventLog(paths, repair)
    if (eventLog.events.length === 0) {
      throw new GeoResearchError('PROJECT_RECOVERY_REQUIRED', `project ${projectId} has no committed event`)
    }
    const replayed = replayEvents(projectId, eventLog.events)
    const latest = eventLog.events.at(-1) as ProjectEvent
    const rebuilt = createStateFile(projectId, eventLog.events.length, latest.seq, latest.hash, replayed)
    let snapshot: ProjectStateFile | undefined
    try {
      snapshot = parseStateFile(JSON.parse(await readFile(paths.state, 'utf8')) as unknown, projectId)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (snapshot === undefined || snapshot.lastEventSeq < latest.seq) {
      if (!repair) return { stateFile: rebuilt, rebuiltSnapshot: false, truncatedTail: eventLog.truncatedTail }
      await atomicWriteJson(paths.state, rebuilt)
      return { stateFile: rebuilt, rebuiltSnapshot: true, truncatedTail: eventLog.truncatedTail }
    }
    if (snapshot.lastEventSeq > latest.seq || snapshot.generation > eventLog.events.length) {
      throw new GeoResearchError('PROJECT_SNAPSHOT_INCONSISTENT', 'state.json is ahead of events.jsonl')
    }
    const eventIdentityMatches = snapshot.lastEventHash === latest.hash
      && snapshot.generation === eventLog.events.length
    if (eventIdentityMatches
      && canonicalJson(snapshot.state) !== canonicalJson(replayed)
      && repair
      && isLegacyAdditiveSnapshot(snapshot.state, replayed)) {
      await atomicWriteJson(paths.state, rebuilt)
      return { stateFile: rebuilt, rebuiltSnapshot: true, truncatedTail: eventLog.truncatedTail }
    }
    if (!eventIdentityMatches || canonicalJson(snapshot.state) !== canonicalJson(replayed)) {
      throw new GeoResearchError('PROJECT_SNAPSHOT_INCONSISTENT', 'state.json does not match the replayed event chain')
    }
    return { stateFile: snapshot, rebuiltSnapshot: false, truncatedTail: eventLog.truncatedTail }
  }

  private async readEventLog(paths: ProjectPaths, truncateTail = false): Promise<ReadEventLogResult> {
    let bytes
    try {
      bytes = await readFile(paths.events)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { events: [], truncatedTail: false }
      throw error
    }
    if (bytes.byteLength === 0) return { events: [], truncatedTail: false }
    const source = bytes.toString('utf8')
    const endsWithNewline = source.endsWith('\n')
    const lines = source.split('\n')
    if (endsWithNewline) lines.pop()
    let truncated = false
    if (!endsWithNewline) {
      const tail = lines.pop() as string
      try {
        JSON.parse(tail)
        lines.push(tail)
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        if (!truncateTail) throw new GeoResearchError('PROJECT_EVENT_LOG_CORRUPT', 'events.jsonl ends with incomplete JSON')
        const lastNewline = bytes.lastIndexOf(0x0a)
        await truncate(paths.events, lastNewline + 1)
        truncated = true
      }
    }
    const events: ProjectEvent[] = []
    let previous: Sha256Digest | null = null
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      if (line === undefined || line.trim().length === 0) {
        throw new GeoResearchError('PROJECT_EVENT_LOG_CORRUPT', `events.jsonl line ${index + 1} is empty`)
      }
      let value: unknown
      try {
        value = JSON.parse(line) as unknown
      } catch (error) {
        throw new GeoResearchError('PROJECT_EVENT_LOG_CORRUPT', `events.jsonl line ${index + 1} is invalid JSON`, { cause: error })
      }
      const event = parseEvent(value, index + 1, previous)
      events.push(event)
      previous = event.hash
    }
    return { events, truncatedTail: truncated }
  }

  private async ensureDirectories(paths: ProjectPaths): Promise<void> {
    await Promise.all([
      mkdir(paths.root, { recursive: true }),
      mkdir(paths.objectSha256, { recursive: true }),
      mkdir(paths.runs, { recursive: true }),
      mkdir(paths.continuations, { recursive: true }),
      mkdir(paths.temp, { recursive: true }),
      mkdir(paths.operations, { recursive: true }),
      mkdir(paths.attachments, { recursive: true }),
    ])
  }

  private serial<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const root = resolve(this.home)
    const key = `${process.platform === 'win32' ? root.toLowerCase() : root}\0${projectId}`
    const previous = PROJECT_WRITE_TAILS.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>(resolveGate => { release = resolveGate })
    const tail = previous.catch(() => undefined).then(() => gate)
    PROJECT_WRITE_TAILS.set(key, tail)
    return previous.catch(() => undefined).then(action).finally(() => {
      release()
      if (PROJECT_WRITE_TAILS.get(key) === tail) PROJECT_WRITE_TAILS.delete(key)
    })
  }
}

function createEvent(input: Omit<ProjectEvent, 'eventSchemaVersion' | 'reducerVersion' | 'hash'>): ProjectEvent {
  const body = {
    eventSchemaVersion: PROJECT_EVENT_SCHEMA_VERSION,
    reducerVersion: PROJECT_REDUCER_VERSION,
    ...input,
  }
  canonicalJson(body)
  return { ...body, hash: digestJson(body) }
}

function createStateFile(
  projectId: string,
  generation: number,
  lastEventSeq: number,
  lastEventHash: Sha256Digest,
  state: ProjectReducerState,
): ProjectStateFile {
  const body = {
    schemaVersion: 1 as const,
    projectId,
    generation,
    lastEventSeq,
    lastEventHash,
    state,
  }
  return { ...body, digest: digestJson(body) }
}

function isLegacyAdditiveSnapshot(snapshot: ProjectReducerState, replayed: ProjectReducerState): boolean {
  const additiveMaps = [
    'sources',
    'evidence',
    'repositoryAudits',
    'reproductionPlans',
    'reproductionTestSpecs',
    'reproductionReports',
    'geodataReports',
    'datasetManifests',
    'experimentSpecs',
    'experimentAmendments',
    'results',
    'validationPlans',
    'validationReports',
    'reviewRecords',
    'claims',
    'writingPackets',
    'manuscripts',
    'manuscriptAudits',
  ] as const
  const missing = additiveMaps.filter(key => !Object.hasOwn(snapshot, key))
  if (missing.length === 0) return false
  if (missing.some(key => Object.keys(replayed[key] ?? {}).length > 0)) {
    return false
  }
  // Later phases add only empty authoritative maps to reducer v1 snapshots.
  const migrated = { ...snapshot } as Record<string, unknown>
  for (const key of missing) migrated[key] = {}
  return canonicalJson(migrated) === canonicalJson(replayed)
}

function parseStateFile(value: unknown, projectId: string): ProjectStateFile {
  const record = objectRecord(value, 'state.json')
  if (record.schemaVersion !== 1 || record.projectId !== projectId) {
    throw new GeoResearchError('PROJECT_SNAPSHOT_INCONSISTENT', 'state.json header is invalid')
  }
  if (!Number.isSafeInteger(record.generation) || (record.generation as number) < 1
    || !Number.isSafeInteger(record.lastEventSeq) || (record.lastEventSeq as number) < 1
    || !isSha256Digest(record.lastEventHash) || !isSha256Digest(record.digest)) {
    throw new GeoResearchError('PROJECT_SNAPSHOT_INCONSISTENT', 'state.json sequence fields are invalid')
  }
  const state = objectRecord(record.state, 'state.json state') as unknown as ProjectReducerState
  const body = {
    schemaVersion: 1 as const,
    projectId,
    generation: record.generation as number,
    lastEventSeq: record.lastEventSeq as number,
    lastEventHash: record.lastEventHash,
    state,
  }
  if (digestJson(body) !== record.digest) {
    throw new GeoResearchError('PROJECT_SNAPSHOT_INCONSISTENT', 'state.json digest is invalid')
  }
  return { ...body, digest: record.digest }
}

function parseEvent(value: unknown, expectedSeq: number, previousHash: Sha256Digest | null): ProjectEvent {
  const record = objectRecord(value, `event ${expectedSeq}`)
  if (record.eventSchemaVersion !== PROJECT_EVENT_SCHEMA_VERSION
    || record.reducerVersion !== PROJECT_REDUCER_VERSION
    || record.seq !== expectedSeq
    || record.previousHash !== previousHash
    || typeof record.type !== 'string' || record.type.length === 0
    || !isSha256Digest(record.operationKey)
    || !isSha256Digest(record.requestDigest)
    || !isSha256Digest(record.hash)
    || typeof record.time !== 'string' || !canonicalUtc(record.time)) {
    throw new GeoResearchError('PROJECT_EVENT_LOG_CORRUPT', `event ${expectedSeq} has invalid metadata`)
  }
  canonicalJson(record.data)
  const body = {
    eventSchemaVersion: PROJECT_EVENT_SCHEMA_VERSION,
    reducerVersion: PROJECT_REDUCER_VERSION,
    seq: expectedSeq,
    time: record.time,
    operationKey: record.operationKey,
    requestDigest: record.requestDigest,
    type: record.type,
    data: record.data as JsonValue,
    previousHash,
  }
  if (digestJson(body) !== record.hash) {
    throw new GeoResearchError('PROJECT_EVENT_LOG_CORRUPT', `event ${expectedSeq} hash is invalid`)
  }
  return { ...body, hash: record.hash }
}

function replayEvents(projectId: string, events: readonly ProjectEvent[]): ProjectReducerState {
  let state: ProjectReducerState | undefined
  for (const event of events) state = reduceProjectEvent(state, event)
  if (state === undefined || state.projectId !== projectId) {
    throw new GeoResearchError('PROJECT_EVENT_LOG_CORRUPT', `event chain does not create project ${projectId}`)
  }
  return state
}

async function appendEvent(path: string, event: ProjectEvent): Promise<void> {
  const handle = await open(path, 'a+', 0o600)
  try {
    const info = await handle.stat()
    let separator = ''
    if (info.size > 0) {
      const tail = Buffer.allocUnsafe(1)
      const read = await handle.read(tail, 0, 1, info.size - 1)
      if (read.bytesRead !== 1) throw new Error(`could not read the event log tail: ${path}`)
      if (tail[0] !== 0x0a) separator = '\n'
    }
    await handle.writeFile(`${separator}${JSON.stringify(event)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function validateCommitRequest(request: ProjectCommitRequest): void {
  if (!Number.isSafeInteger(request.expectedGeneration) || request.expectedGeneration < 1) {
    throw new TypeError('expectedGeneration must be a positive integer')
  }
  if (!isSha256Digest(request.operationKey) || !isSha256Digest(request.requestDigest)) {
    throw new TypeError('operationKey and requestDigest must be SHA-256 digests')
  }
  if (request.type.trim().length === 0) throw new TypeError('event type must be non-empty')
  canonicalJson(request.data)
}

function operationPath(paths: ProjectPaths, operationKey: Sha256Digest): string {
  return join(paths.operations, `${operationKey.slice('sha256:'.length)}.json`)
}

function operationMutexId(projectId: string, operationKey: Sha256Digest): string {
  return `${projectId}:operation:${operationKey}`
}

function operationLeaseKey(home: string, projectId: string, operationKey: Sha256Digest): string {
  const root = resolve(home)
  return `${process.platform === 'win32' ? root.toLowerCase() : root}\0${projectId}\0${operationKey}`
}

async function readOperation(path: string, expectedKey?: Sha256Digest): Promise<OperationRecord> {
  const record = objectRecord(JSON.parse(await readFile(path, 'utf8')) as unknown, 'operation record')
  if (record.schemaVersion !== 1 || !isSha256Digest(record.operationKey) || !isSha256Digest(record.requestDigest)
    || typeof record.operation !== 'string' || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string'
    || (record.state !== 'in-progress' && record.state !== 'committed'
      && record.state !== 'failed-final' && record.state !== 'recovery-required')) {
    throw new GeoResearchError('PROJECT_RECOVERY_REQUIRED', `operation record ${basename(path)} is invalid`)
  }
  if (expectedKey !== undefined && record.operationKey !== expectedKey) {
    throw new GeoResearchError('PROJECT_RECOVERY_REQUIRED', `operation record ${basename(path)} has the wrong key`)
  }
  const result: OperationRecord = {
    schemaVersion: 1,
    operationKey: record.operationKey,
    requestDigest: record.requestDigest,
    operation: record.operation,
    state: record.state,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.exactResult === undefined ? {} : { exactResult: record.exactResult as JsonValue }),
    ...(isSha256Digest(record.exactResultDigest) ? { exactResultDigest: record.exactResultDigest } : {}),
    ...(record.exactError === undefined ? {} : { exactError: parseOperationError(record.exactError) }),
  }
  canonicalJson(result)
  return result
}

async function recoverOperations(
  projectId: string,
  home: string,
  directory: string,
  clock: () => string,
  mutexFactory: (projectId: string, timeoutMs: number) => Promise<ProjectMutexLease>,
): Promise<Sha256Digest[]> {
  const recovered: Sha256Digest[] = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !/^[0-9a-f]{64}\.json$/u.test(entry.name)) {
      throw new GeoResearchError('PROJECT_RECOVERY_REQUIRED', `unexpected operation store entry ${entry.name}`)
    }
    const path = join(directory, entry.name)
    const operationKey = `sha256:${entry.name.slice(0, -'.json'.length)}` as Sha256Digest
    if (ACTIVE_OPERATION_LEASES.has(operationLeaseKey(home, projectId, operationKey))) continue
    let mutex: ProjectMutexLease
    try {
      mutex = await mutexFactory(operationMutexId(projectId, operationKey), 0)
    } catch (error) {
      if (lockUnavailable(error)) continue
      throw error
    }
    try {
      const record = await readOperation(path)
      if (`${record.operationKey.slice('sha256:'.length)}.json` !== entry.name) {
        throw new GeoResearchError('PROJECT_RECOVERY_REQUIRED', `operation file ${entry.name} does not match its key`)
      }
      if (record.state === 'in-progress') {
        await atomicWriteJson(path, { ...record, state: 'recovery-required', updatedAt: clock() })
        recovered.push(record.operationKey)
      }
    } finally {
      await mutex.release()
    }
  }
  return recovered
}

function lockUnavailable(error: unknown): boolean {
  return error instanceof GeoResearchError && error.code === 'PROJECT_WRITE_LOCK_TIMEOUT'
}

async function removeAgedFiles(directory: string, graceMs: number): Promise<string[]> {
  const removed: string[] = []
  const cutoff = Date.now() - graceMs
  const visit = async (path: string): Promise<void> => {
    const entries = await readdir(path, { withFileTypes: true })
    for (const entry of entries) {
      const child = join(path, entry.name)
      if (entry.isSymbolicLink()) throw new GeoResearchError('PROJECT_RECOVERY_REQUIRED', `unsafe recovery symlink ${child}`)
      if (entry.isDirectory()) {
        await visit(child)
        continue
      }
      if (!entry.isFile()) throw new GeoResearchError('PROJECT_RECOVERY_REQUIRED', `unsafe recovery entry ${child}`)
      if ((await stat(child)).mtimeMs <= cutoff) {
        await rm(child, { force: true })
        removed.push(child)
      }
    }
  }
  await visit(directory)
  return removed.sort()
}

async function removeOrphanObjects(
  paths: ProjectPaths,
  referencedRelativePaths: ReadonlySet<string>,
  graceMs: number,
): Promise<string[]> {
  const removed: string[] = []
  const cutoff = Date.now() - graceMs
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const child = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new GeoResearchError('PROJECT_RECOVERY_REQUIRED', `unsafe object-store symlink ${child}`)
      if (entry.isDirectory()) {
        await visit(child)
        continue
      }
      if (!entry.isFile()) throw new GeoResearchError('PROJECT_RECOVERY_REQUIRED', `unsafe object-store entry ${child}`)
      const relativePath = relative(paths.root, child).replaceAll('\\', '/')
      if (!referencedRelativePaths.has(relativePath) && (await stat(child)).mtimeMs <= cutoff) {
        await rm(child, { force: true })
        removed.push(relativePath)
      }
    }
  }
  await visit(paths.objectSha256)
  return removed.sort()
}

async function assertNoIncompleteContinuationAdvance(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const record = objectRecord(JSON.parse(await readFile(join(directory, entry.name), 'utf8')) as unknown, 'continuation marker')
    if (record.state === 'in-progress' || record.state === 'dispatched-unknown') {
      throw new GeoResearchError('PROJECT_RECOVERY_REQUIRED', `continuation advance ${entry.name} is incomplete`)
    }
  }
}

async function scanIncompleteRunLaunches(directory: string): Promise<string[]> {
  const incomplete: string[] = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const root = join(directory, entry.name)
    if (await exists(join(root, 'launch-intent.json'))
      && !await exists(join(root, 'launch-receipt.json'))
      && !await exists(join(root, 'exit.json'))) {
      incomplete.push(entry.name)
    }
  }
  return incomplete.sort()
}

function defaultOperationError(error: unknown): OperationErrorRecord & {
  readonly state: 'failed-final' | 'recovery-required'
} {
  if (error instanceof GeoResearchError) {
    return { state: 'failed-final', code: error.code, message: error.message, retryable: false }
  }
  return {
    state: 'recovery-required',
    code: 'OPERATION_RECOVERY_REQUIRED',
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  }
}

function storedOperationError(record: OperationRecord): Error {
  const exact = record.exactError
  const error = new Error(exact?.message ?? `operation ${record.operationKey} failed`) as Error & { code?: string; retryable?: boolean }
  error.name = 'StoredOperationError'
  if (exact !== undefined) {
    error.code = exact.code
    error.retryable = exact.retryable
  }
  return error
}

function parseOperationError(value: unknown): OperationErrorRecord {
  const record = objectRecord(value, 'operation exactError')
  if (typeof record.code !== 'string' || typeof record.message !== 'string' || typeof record.retryable !== 'boolean') {
    throw new GeoResearchError('PROJECT_RECOVERY_REQUIRED', 'operation exactError is invalid')
  }
  return { code: record.code, message: record.message, retryable: record.retryable }
}

function objectRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GeoResearchError('PROJECT_RECOVERY_REQUIRED', `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function canonicalUtc(value: string): boolean {
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export function newProjectId(): string {
  return `project-${randomUUID()}`
}
