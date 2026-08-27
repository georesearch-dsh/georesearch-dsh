import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  GeoResearchError,
  digestJson,
  type ArtifactRecord,
  type JsonValue,
} from '@georesearch/dsh-contracts'
import {
  ProjectFileStore,
  downstreamArtifactIds,
  inspectWorkspace,
  projectPaths,
  workspaceBinding,
  type ProjectMutexLease,
} from '../src/index.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('project file persistence', () => {
  it('uses generation CAS under concurrent writers', async () => {
    const fixture = await projectFixture()
    const request = (suffix: string) => fixture.store.commit(fixture.projectId, {
      expectedGeneration: 1,
      operationKey: digestJson({ operation: suffix }),
      requestDigest: digestJson({ request: suffix }),
      type: 'project.blockers.updated',
      data: { blockers: [suffix] },
    })
    const settled = await Promise.allSettled([request('a'), request('b')])
    expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = settled.find(result => result.status === 'rejected')
    expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({ code: 'PROJECT_GENERATION_CONFLICT' })
  })

  it('separates operation identity from request content and replays the exact result', async () => {
    const fixture = await projectFixture()
    const key = digestJson({ key: 'one call' })
    const request = digestJson({ request: 'original' })
    let effects = 0
    const first = await fixture.store.executeOperation(
      fixture.projectId,
      key,
      request,
      'probe',
      async () => ({ value: ++effects }),
    )
    const replay = await fixture.store.executeOperation(
      fixture.projectId,
      key,
      request,
      'probe',
      async () => ({ value: ++effects }),
    )
    expect(first).toEqual({ value: 1 })
    expect(replay).toEqual(first)
    expect(effects).toBe(1)
    await expect(fixture.store.executeOperation(
      fixture.projectId,
      key,
      digestJson({ request: 'modified' }),
      'probe',
      async () => ({ value: 3 }),
    )).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('truncates only an incomplete EOF tail and rebuilds a lagging snapshot', async () => {
    const fixture = await projectFixture()
    const paths = projectPaths(fixture.home, fixture.projectId)
    await appendFile(paths.events, '{"eventSchemaVersion":1')
    await rm(paths.state)
    const report = await fixture.store.recover(fixture.projectId)
    expect(report.truncatedEventTail).toBe(true)
    expect(report.rebuiltSnapshot).toBe(true)
    expect((await fixture.store.load(fixture.projectId)).generation).toBe(1)
    expect((await readFile(paths.events, 'utf8')).endsWith('\n')).toBe(true)
  })

  it('preserves a complete event tail that is missing its final newline', async () => {
    const fixture = await projectFixture()
    const paths = projectPaths(fixture.home, fixture.projectId)
    const events = await readFile(paths.events, 'utf8')
    expect(events.endsWith('\n')).toBe(true)
    await writeFile(paths.events, events.slice(0, -1), 'utf8')

    await fixture.store.commit(fixture.projectId, {
      expectedGeneration: 1,
      operationKey: digestJson({ operation: 'append-after-complete-tail' }),
      requestDigest: digestJson({ request: 'append-after-complete-tail' }),
      type: 'project.blockers.updated',
      data: { blockers: ['preserved'] },
    })

    const reloaded = await fixture.store.load(fixture.projectId)
    expect(reloaded.generation).toBe(2)
    expect(reloaded.state.blockers).toEqual(['preserved'])
    expect((await readFile(paths.events, 'utf8')).split('\n').filter(Boolean)).toHaveLength(2)
  })

  it('fails closed on a corrupt complete event line', async () => {
    const fixture = await projectFixture()
    const paths = projectPaths(fixture.home, fixture.projectId)
    await appendFile(paths.events, '{}\n')
    await expect(fixture.store.load(fixture.projectId)).rejects.toMatchObject({ code: 'PROJECT_EVENT_LOG_CORRUPT' })
  })

  it('detects a checksum-valid snapshot that disagrees with event replay', async () => {
    const fixture = await projectFixture()
    const paths = projectPaths(fixture.home, fixture.projectId)
    const current = JSON.parse(await readFile(paths.state, 'utf8')) as Record<string, unknown>
    const state = current.state as Record<string, unknown>
    const modifiedState = { ...state, blockers: ['forged'] }
    const body = {
      schemaVersion: current.schemaVersion,
      projectId: current.projectId,
      generation: current.generation,
      lastEventSeq: current.lastEventSeq,
      lastEventHash: current.lastEventHash,
      state: modifiedState,
    }
    await writeFile(paths.state, `${JSON.stringify({ ...body, digest: digestJson(body) }, undefined, 2)}\n`)
    await expect(fixture.store.load(fixture.projectId)).rejects.toMatchObject({ code: 'PROJECT_SNAPSHOT_INCONSISTENT' })
  })

  it('rebuilds a checksum-valid legacy snapshot missing additive Phase 3 and Phase 4 maps', async () => {
    const fixture = await projectFixture()
    const paths = projectPaths(fixture.home, fixture.projectId)
    const current = JSON.parse(await readFile(paths.state, 'utf8')) as Record<string, unknown>
    const state = current.state as Record<string, unknown>
    const {
      sources,
      evidence,
      repositoryAudits,
      reproductionPlans,
      reproductionTestSpecs,
      reproductionReports,
      ...legacyState
    } = state
    expect(sources).toEqual({})
    expect(evidence).toEqual({})
    expect(repositoryAudits).toEqual({})
    expect(reproductionPlans).toEqual({})
    expect(reproductionTestSpecs).toEqual({})
    expect(reproductionReports).toEqual({})
    const body = {
      schemaVersion: current.schemaVersion,
      projectId: current.projectId,
      generation: current.generation,
      lastEventSeq: current.lastEventSeq,
      lastEventHash: current.lastEventHash,
      state: legacyState,
    }
    await writeFile(paths.state, `${JSON.stringify({ ...body, digest: digestJson(body) }, undefined, 2)}\n`)

    const migrated = await fixture.store.load(fixture.projectId)
    expect(migrated.state.sources).toEqual({})
    expect(migrated.state.evidence).toEqual({})
    expect(migrated.state.repositoryAudits).toEqual({})
    expect(migrated.state.reproductionPlans).toEqual({})
    expect(migrated.state.reproductionTestSpecs).toEqual({})
    expect(migrated.state.reproductionReports).toEqual({})
    const persisted = JSON.parse(await readFile(paths.state, 'utf8')) as {
      readonly state: Record<string, unknown>
    }
    expect(persisted.state.sources).toEqual({})
    expect(persisted.state.evidence).toEqual({})
    expect(persisted.state.repositoryAudits).toEqual({})
    expect(persisted.state.reproductionPlans).toEqual({})
    expect(persisted.state.reproductionTestSpecs).toEqual({})
    expect(persisted.state.reproductionReports).toEqual({})
  })

  it('rebuilds a checksum-valid legacy snapshot missing additive Phase 5 and Phase 6 maps', async () => {
    const fixture = await projectFixture()
    const paths = projectPaths(fixture.home, fixture.projectId)
    const current = JSON.parse(await readFile(paths.state, 'utf8')) as Record<string, unknown>
    const state = current.state as Record<string, unknown>
    const {
      geodataReports,
      datasetManifests,
      experimentSpecs,
      experimentAmendments,
      results,
      validationPlans,
      validationReports,
      reviewRecords,
      claims,
      writingPackets,
      manuscripts,
      manuscriptAudits,
      ...legacyState
    } = state
    for (const value of [
      geodataReports,
      datasetManifests,
      experimentSpecs,
      experimentAmendments,
      results,
      validationPlans,
      validationReports,
      reviewRecords,
      claims,
      writingPackets,
      manuscripts,
      manuscriptAudits,
    ]) expect(value).toEqual({})
    const body = {
      schemaVersion: current.schemaVersion,
      projectId: current.projectId,
      generation: current.generation,
      lastEventSeq: current.lastEventSeq,
      lastEventHash: current.lastEventHash,
      state: legacyState,
    }
    await writeFile(paths.state, `${JSON.stringify({ ...body, digest: digestJson(body) }, undefined, 2)}\n`)

    const migrated = await fixture.store.load(fixture.projectId)
    expect(migrated.state).toMatchObject({
      geodataReports: {},
      datasetManifests: {},
      experimentSpecs: {},
      experimentAmendments: {},
      results: {},
      validationPlans: {},
      validationReports: {},
      reviewRecords: {},
      claims: {},
      writingPackets: {},
      manuscripts: {},
      manuscriptAudits: {},
    })
    const persisted = JSON.parse(await readFile(paths.state, 'utf8')) as {
      readonly state: Record<string, unknown>
    }
    expect(persisted.state).toMatchObject({
      geodataReports: {},
      datasetManifests: {},
      experimentSpecs: {},
      experimentAmendments: {},
      results: {},
      validationPlans: {},
      validationReports: {},
      reviewRecords: {},
      claims: {},
      writingPackets: {},
      manuscripts: {},
      manuscriptAudits: {},
    })
  })

  it('runs recovery before writing after an abandoned mutex', async () => {
    const fixture = await projectFixture()
    const paths = projectPaths(fixture.home, fixture.projectId)
    await appendFile(paths.events, '{"partial"')
    let acquired = 0
    const recovering = new ProjectFileStore({
      home: fixture.home,
      mutexFactory: async (): Promise<ProjectMutexLease> => ({
        abandoned: ++acquired === 1,
        async release() {},
      }),
    })
    const next = await recovering.commit(fixture.projectId, {
      expectedGeneration: 1,
      operationKey: digestJson({ operation: 'after-abandon' }),
      requestDigest: digestJson({ request: 'after-abandon' }),
      type: 'project.blockers.updated',
      data: { blockers: ['recovered'] },
    })
    expect(next.generation).toBe(2)
    expect(next.state.blockers).toEqual(['recovered'])
  })

  it('marks interrupted operations for dedicated recovery and removes aged orphans', async () => {
    const fixture = await projectFixture({ orphanGraceMs: 0 })
    const key = digestJson({ key: 'interrupted' })
    await expect(fixture.store.executeOperation(
      fixture.projectId,
      key,
      digestJson({ request: 'interrupted' }),
      'probe',
      async () => { throw new Error('crash boundary') },
    )).rejects.toThrow('crash boundary')
    const paths = projectPaths(fixture.home, fixture.projectId)
    const orphan = join(paths.objectSha256, 'aa', 'a'.repeat(64))
    await mkdir(join(paths.objectSha256, 'aa'), { recursive: true })
    await writeFile(orphan, 'orphan')
    await utimes(orphan, new Date(0), new Date(0))
    const report = await fixture.store.recover(fixture.projectId)
    expect(report.removedOrphanObjects).toEqual([`objects/sha256/aa/${'a'.repeat(64)}`])
    const recovered = await fixture.store.executeOperation(
      fixture.projectId,
      key,
      digestJson({ request: 'interrupted' }),
      'probe',
      async () => ({ unreachable: true }),
      { recover: async () => ({ recovered: true }) },
    )
    expect(recovered).toEqual({ recovered: true })
  })

  it('does not recover an operation while its original action still owns the operation lease', async () => {
    const fixture = await projectFixture()
    const key = digestJson({ key: 'live-operation' })
    const request = digestJson({ request: 'live-operation' })
    let releaseAction!: () => void
    let actionStarted!: () => void
    const started = new Promise<void>(resolveStarted => { actionStarted = resolveStarted })
    const release = new Promise<void>(resolveRelease => { releaseAction = resolveRelease })

    const original = fixture.store.executeOperation(
      fixture.projectId,
      key,
      request,
      'probe',
      async () => {
        actionStarted()
        await release
        return { winner: 'original' }
      },
    )
    await started

    const recovery = await fixture.store.recover(fixture.projectId)
    expect(recovery.recoveredOperationKeys).not.toContain(key)
    await expect(fixture.store.executeOperation(
      fixture.projectId,
      key,
      request,
      'probe',
      async () => ({ winner: 'unexpected' }),
      { recover: async () => ({ winner: 'recovery' }) },
    )).rejects.toMatchObject({ code: 'OPERATION_IN_PROGRESS' })

    releaseAction()
    await expect(original).resolves.toEqual({ winner: 'original' })
    await expect(fixture.store.executeOperation(
      fixture.projectId,
      key,
      request,
      'probe',
      async () => ({ winner: 'unexpected' }),
    )).resolves.toEqual({ winner: 'original' })
  })

  it('propagates stale validity through artifact lineage without deleting history', () => {
    const digestA = digestJson({ artifact: 'a' })
    const digestB = digestJson({ artifact: 'b' })
    const artifacts: Record<string, ArtifactRecord> = {
      a: artifact('a', digestA, [digestJson({ input: 'changed' })]),
      b: artifact('b', digestB, [digestA]),
      c: artifact('c', digestJson({ artifact: 'c' }), [digestB]),
      independent: artifact('independent', digestJson({ artifact: 'independent' }), []),
    }
    expect(downstreamArtifactIds(artifacts, new Set([digestJson({ input: 'changed' })]))).toEqual(['a', 'b', 'c'])
  })
})

async function projectFixture(options: { readonly orphanGraceMs?: number } = {}): Promise<{
  readonly root: string
  readonly home: string
  readonly projectId: string
  readonly store: ProjectFileStore
}> {
  const root = await temporaryRoot('georesearch-store-')
  const home = join(root, 'home')
  const projectId = 'project-test'
  const inspected = await inspectWorkspace(root)
  const binding = workspaceBinding(projectId, inspected, 1, '2026-08-16T00:00:00.000Z')
  const store = new ProjectFileStore({ home, orphanGraceMs: options.orphanGraceMs })
  await store.createProject(
    projectId,
    binding,
    digestJson({ operation: 'create' }),
    digestJson({ request: 'create' }),
  )
  return { root, home, projectId, store }
}

function artifact(id: string, digest: `sha256:${string}`, inputs: readonly `sha256:${string}`[]): ArtifactRecord {
  return {
    schemaVersion: 1,
    artifactId: id,
    digest,
    kind: 'test',
    size: 1,
    mediaType: 'application/octet-stream',
    workspaceId: 'workspace-test',
    materialization: 'committed',
    integrity: 'verified',
    validity: 'current',
    objectPath: `objects/${id}`,
    lineage: { inputDigests: inputs, transformationType: 'test', outputDigest: digest },
    committedAt: '2026-08-16T00:00:00.000Z',
  }
}

async function temporaryRoot(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(path)
  return path
}
