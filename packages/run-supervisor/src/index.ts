import { mkdir, open, readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import {
  GeoResearchError,
  digestJson,
  nowUtc,
  parseRunExitMarker,
  parseRunRecord,
  sha256Bytes,
  type RunExitMarker,
  type RunLaunchIntent,
  type RunLaunchReceipt,
  type RunRecord,
} from '@georesearch/dsh-contracts'
import {
  assertId,
  atomicWriteFile,
  atomicWriteJson,
  projectPaths,
} from '@georesearch/dsh-project-provider-files'

export interface SupervisorOutputRead {
  readonly text: string
  readonly nextOffset: number
  readonly lossy: boolean
  readonly spillPath?: string
}

export interface SupervisorOutputReader {
  readFrom(fromByte: number): SupervisorOutputRead
}

export interface SupervisorProcessHandle {
  readonly pid: number
  readonly collected: {
    readonly stdout?: SupervisorOutputReader
    readonly stderr?: SupervisorOutputReader
  }
  readonly done: Promise<{ readonly exitCode: number | null; readonly signal: string | null }>
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
}

export interface SupervisorSpawnSpec {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly graceMs: number
  readonly stdoutMaxBytes: number
  readonly stderrMaxBytes: number
  readonly signal: AbortSignal
}

export interface SupervisorRuntime {
  spawn(spec: SupervisorSpawnSpec): SupervisorProcessHandle
}

export type ProcessInspection =
  | { readonly state: 'running'; readonly creationTime: string }
  | { readonly state: 'exited'; readonly creationTime?: string }
  | { readonly state: 'missing' }
  | { readonly state: 'reused'; readonly creationTime: string }
  | { readonly state: 'unknown'; readonly reason: string }

export interface SupervisorProcessInspector {
  creationTime(pid: number): Promise<string>
  inspect(pid: number, expectedCreationTime: string): Promise<ProcessInspection>
  terminate(pid: number, expectedCreationTime: string, graceMs: number): Promise<boolean>
}

export interface SupervisorLaunchRequest {
  readonly home: string
  readonly projectId: string
  readonly run: RunRecord
  readonly confinedArgv: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly graceMs: number
  readonly stdoutMaxBytes: number
  readonly stderrMaxBytes: number
}

export interface SupervisorCompletion {
  readonly marker: RunExitMarker
  readonly terminationReason?: 'cancelled' | 'timeout'
  readonly spawnError?: string
}

export interface SupervisorLaunch {
  readonly receipt: RunLaunchReceipt
  readonly completion: Promise<SupervisorCompletion>
}

export type SupervisorReconciliation =
  | { readonly state: 'running'; readonly receipt: RunLaunchReceipt }
  | { readonly state: 'terminal'; readonly receipt: RunLaunchReceipt; readonly marker: RunExitMarker }
  | { readonly state: 'recovery-required'; readonly reason: string; readonly receipt?: RunLaunchReceipt }

interface ActiveRun {
  readonly handle: SupervisorProcessHandle
  readonly receipt: RunLaunchReceipt
  readonly controller: AbortController
  terminationReason?: 'cancelled' | 'timeout'
}

export class RunSupervisor {
  private readonly active = new Map<string, ActiveRun>()
  private readonly clock: () => string

  constructor(
    private readonly runtime: SupervisorRuntime,
    private readonly inspector: SupervisorProcessInspector = new NativeProcessInspector(),
    now: () => string = nowUtc,
  ) {
    this.clock = now
  }

  async persistRunRecord(home: string, projectId: string, record: RunRecord): Promise<void> {
    const paths = runPaths(home, projectId, record.runId)
    await atomicWriteJson(paths.record, record)
  }

  async launch(request: SupervisorLaunchRequest): Promise<SupervisorLaunch> {
    validateLaunchRequest(request)
    const paths = runPaths(request.home, request.projectId, request.run.runId)
    const intent: RunLaunchIntent = {
      schemaVersion: 1,
      projectId: request.projectId,
      runId: request.run.runId,
      launchId: request.run.launchId,
      argv: [...request.confinedArgv],
      argvDigest: digestJson(request.confinedArgv),
      cwd: request.run.cwd,
      environmentDigest: request.run.environmentDigest,
      stdoutPath: relative(projectPaths(request.home, request.projectId).root, paths.stdout).replaceAll('\\', '/'),
      stderrPath: relative(projectPaths(request.home, request.projectId).root, paths.stderr).replaceAll('\\', '/'),
      createdAt: this.clock(),
    }
    await writeNewJson(paths.intent, intent)
    await atomicWriteFile(paths.stdout, '')
    await atomicWriteFile(paths.stderr, '')
    const controller = new AbortController()
    let handle: SupervisorProcessHandle
    try {
      handle = this.runtime.spawn({
        argv: request.confinedArgv,
        cwd: request.run.cwd.canonicalPath,
        env: request.environment,
        graceMs: request.graceMs,
        stdoutMaxBytes: request.stdoutMaxBytes,
        stderrMaxBytes: request.stderrMaxBytes,
        signal: controller.signal,
      })
    } catch (error) {
      throw new GeoResearchError('RUN_LAUNCH_FAILED', `Supervisor process creation failed: ${errorMessage(error)}`, { cause: error })
    }
    let processCreationTime: string
    try {
      processCreationTime = await this.inspector.creationTime(handle.pid)
    } catch (error) {
      const cause = await terminateAndJoinSpawnedProcess(controller, handle, error)
      throw new GeoResearchError('RUN_LAUNCH_FAILED', `Supervisor could not identify PID ${handle.pid}`, { cause })
    }
    const receiptBody = {
      schemaVersion: 1 as const,
      projectId: request.projectId,
      runId: request.run.runId,
      launchId: request.run.launchId,
      pid: handle.pid,
      processCreationTime,
      stdoutPath: intent.stdoutPath,
      stderrPath: intent.stderrPath,
      createdAt: this.clock(),
    }
    const receipt: RunLaunchReceipt = { ...receiptBody, digest: digestJson(receiptBody) }
    try {
      await writeNewJson(paths.receipt, receipt)
    } catch (error) {
      const cause = await terminateAndJoinSpawnedProcess(controller, handle, error)
      throw new GeoResearchError('RUN_LAUNCH_FAILED', 'Supervisor could not persist the launch receipt', { cause })
    }
    const active: ActiveRun = { handle, receipt, controller }
    this.active.set(activeKey(request.projectId, request.run.runId), active)
    const completion = this.collect(request.home, active, paths).finally(() => {
      this.active.delete(activeKey(request.projectId, request.run.runId))
    })
    return { receipt, completion }
  }

  async cancel(
    home: string,
    projectId: string,
    runId: string,
    graceMs: number,
    reason: 'cancelled' | 'timeout' = 'cancelled',
  ): Promise<boolean> {
    const key = activeKey(projectId, runId)
    const active = this.active.get(key)
    if (active !== undefined) {
      active.terminationReason ??= reason
      active.controller.abort(new Error(`GeoResearch run ${reason}`))
      active.handle.terminate()
      return active.handle.waitForExit()
    }
    const receipt = await readReceipt(runPaths(home, projectId, runId).receipt)
    if (receipt === undefined) return false
    return this.inspector.terminate(receipt.pid, receipt.processCreationTime, graceMs)
  }

  async reconcile(home: string, projectId: string, runId: string): Promise<SupervisorReconciliation> {
    const paths = runPaths(home, projectId, runId)
    const receipt = await readReceipt(paths.receipt)
    const marker = await readExitMarker(paths.exit)
    if (marker !== undefined) {
      if (receipt === undefined || marker.launchId !== receipt.launchId) {
        return { state: 'recovery-required', reason: 'exit marker has no matching launch receipt' }
      }
      return { state: 'terminal', receipt, marker }
    }
    if (receipt === undefined) {
      return { state: 'recovery-required', reason: 'launch intent has no launch receipt' }
    }
    const inspection = await this.inspector.inspect(receipt.pid, receipt.processCreationTime)
    switch (inspection.state) {
      case 'running':
        if (this.active.get(activeKey(projectId, runId))?.receipt.launchId === receipt.launchId) {
          return { state: 'running', receipt }
        }
        return this.reconcileOrphanedProcess(paths.record, receipt)
      case 'exited':
      case 'missing':
        return { state: 'recovery-required', reason: 'process ended without an exit marker', receipt }
      case 'reused':
        return { state: 'recovery-required', reason: 'PID was reused by a different process', receipt }
      case 'unknown':
        return { state: 'recovery-required', reason: inspection.reason, receipt }
    }
  }

  private async collect(
    home: string,
    active: ActiveRun,
    paths: ReturnType<typeof runPaths>,
  ): Promise<SupervisorCompletion> {
    let outcome: { readonly exitCode: number | null; readonly signal: string | null }
    let spawnError: string | undefined
    try {
      outcome = await active.handle.done
    } catch (error) {
      outcome = { exitCode: null, signal: null }
      spawnError = errorMessage(error)
    }
    const stdout = await completeOutput(active.handle.collected.stdout)
    const stderr = await completeOutput(active.handle.collected.stderr)
    await Promise.all([
      atomicWriteFile(paths.stdout, stdout),
      atomicWriteFile(paths.stderr, stderr),
    ])
    const marker: RunExitMarker = {
      schemaVersion: 1,
      projectId: active.receipt.projectId,
      runId: active.receipt.runId,
      launchId: active.receipt.launchId,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      endedAt: this.clock(),
      stdoutDigest: sha256Bytes(stdout),
      stderrDigest: sha256Bytes(stderr),
      ...(active.terminationReason === undefined ? {} : { terminationReason: active.terminationReason }),
    }
    await atomicWriteJson(paths.exit, marker)
    void home
    return {
      marker,
      ...(active.terminationReason === undefined ? {} : { terminationReason: active.terminationReason }),
      ...(spawnError === undefined ? {} : { spawnError }),
    }
  }

  private async reconcileOrphanedProcess(
    recordPath: string,
    receipt: RunLaunchReceipt,
  ): Promise<SupervisorReconciliation> {
    const record = await readRunRecord(recordPath)
    const graceMs = record?.projectId === receipt.projectId
      && record.runId === receipt.runId
      && record.launchId === receipt.launchId
      ? record.resourceLimits.graceMs
      : 1_000
    try {
      const terminated = await this.inspector.terminate(receipt.pid, receipt.processCreationTime, graceMs)
      return {
        state: 'recovery-required',
        reason: terminated
          ? 'process was terminated because its output collector was lost after Supervisor restart'
          : 'process output collector was lost after Supervisor restart and termination was not confirmed',
        receipt,
      }
    } catch (error) {
      return {
        state: 'recovery-required',
        reason: `process output collector was lost after Supervisor restart: ${errorMessage(error)}`,
        receipt,
      }
    }
  }
}

export class NativeProcessInspector implements SupervisorProcessInspector {
  async creationTime(pid: number): Promise<string> {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new TypeError('pid must be a positive integer')
    if (process.platform === 'win32') {
      const result = await inspectWindowsProcess(pid)
      if (result.state === 'missing') throw new Error(`PID ${pid} is no longer available`)
      if (result.state === 'unknown') throw new Error(result.reason)
      if (result.creationTime === undefined) throw new Error(`PID ${pid} has no process creation time`)
      return result.creationTime
    }
    process.kill(pid, 0)
    return this.clockFallback(pid)
  }

  async inspect(pid: number, expectedCreationTime: string): Promise<ProcessInspection> {
    if (process.platform === 'win32') {
      const result = await inspectWindowsProcess(pid)
      if (result.state === 'running' || result.state === 'exited') {
        if (result.creationTime === undefined) {
          return { state: 'unknown', reason: `PID ${pid} has no process creation time` }
        }
        if (result.creationTime !== expectedCreationTime) return { state: 'reused', creationTime: result.creationTime }
      }
      return result
    }
    try {
      process.kill(pid, 0)
      const creationTime = this.clockFallback(pid)
      return creationTime === expectedCreationTime
        ? { state: 'running', creationTime }
        : { state: 'reused', creationTime }
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH'
        ? { state: 'missing' }
        : { state: 'unknown', reason: errorMessage(error) }
    }
  }

  async terminate(pid: number, expectedCreationTime: string, graceMs: number): Promise<boolean> {
    if (process.platform === 'win32') return terminateWindowsProcess(pid, expectedCreationTime, graceMs)
    const inspection = await this.inspect(pid, expectedCreationTime)
    if (inspection.state !== 'running') return inspection.state === 'missing' || inspection.state === 'exited'
    process.kill(pid, 'SIGTERM')
    const deadline = Date.now() + graceMs
    while (Date.now() < deadline) {
      const current = await this.inspect(pid, expectedCreationTime)
      if (current.state !== 'running') return true
      await new Promise(resolveWait => setTimeout(resolveWait, 25))
    }
    process.kill(pid, 'SIGKILL')
    return true
  }

  private clockFallback(pid: number): string {
    return new Date(Math.floor(Date.now() / 1000) * 1000 + (pid % 1000)).toISOString()
  }
}

function runPaths(home: string, projectId: string, runId: string) {
  assertId(runId, 'runId')
  const project = projectPaths(home, projectId)
  const root = join(project.runs, runId)
  return {
    root,
    intent: join(root, 'launch-intent.json'),
    receipt: join(root, 'launch-receipt.json'),
    exit: join(root, 'exit.json'),
    record: join(root, 'record.json'),
    stdout: join(root, 'stdout.log'),
    stderr: join(root, 'stderr.log'),
  }
}

async function writeNewJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
    await handle.sync()
  } catch (error) {
    throw error
  } finally {
    await handle.close()
  }
}

async function completeOutput(reader: SupervisorOutputReader | undefined): Promise<string> {
  if (reader === undefined) return ''
  const result = reader.readFrom(0)
  if (result.lossy && result.spillPath !== undefined) return readFile(result.spillPath, 'utf8')
  return result.text
}

async function readReceipt(path: string): Promise<RunLaunchReceipt | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as RunLaunchReceipt
    const { digest, ...body } = value
    if (digestJson(body) !== digest) throw new Error('launch receipt digest is invalid')
    return value
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function readExitMarker(path: string): Promise<RunExitMarker | undefined> {
  try {
    return parseRunExitMarker(JSON.parse(await readFile(path, 'utf8')) as unknown)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function readRunRecord(path: string): Promise<RunRecord | undefined> {
  try {
    return parseRunRecord(JSON.parse(await readFile(path, 'utf8')) as unknown)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function terminateAndJoinSpawnedProcess(
  controller: AbortController,
  handle: SupervisorProcessHandle,
  cause: unknown,
): Promise<unknown> {
  controller.abort(cause)
  try {
    handle.terminate()
    await handle.waitForExit()
    return cause
  } catch (cleanupError) {
    return new AggregateError([cause, cleanupError], 'Supervisor could not reclaim the spawned process')
  }
}

function validateLaunchRequest(request: SupervisorLaunchRequest): void {
  if (request.projectId !== request.run.projectId) throw new TypeError('run projectId does not match launch request')
  if (request.run.state !== 'starting') throw new GeoResearchError('RUN_STATE_CONFLICT', 'only a starting RunRecord may be launched')
  if (request.confinedArgv.length === 0 || request.confinedArgv.some(argument => typeof argument !== 'string' || argument.includes('\0'))) {
    throw new TypeError('confined argv is invalid')
  }
  for (const value of [request.graceMs, request.stdoutMaxBytes, request.stderrMaxBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('run limits must be positive integers')
  }
}

function activeKey(projectId: string, runId: string): string {
  return `${projectId}\0${runId}`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type NativeHandle = object | number | bigint

async function inspectWindowsProcess(pid: number): Promise<ProcessInspection> {
  const api = await windowsProcessApi()
  const handle = api.openProcess(api.queryAccess, 0, pid)
  if (invalidHandle(api.koffi, handle)) {
    const code = api.getLastError()
    return code === 87 ? { state: 'missing' } : { state: 'unknown', reason: `OpenProcess failed with Win32 code ${code}` }
  }
  try {
    const creationTime = processCreationTime(api, handle as NativeHandle)
    const wait = api.waitForSingleObject(handle as NativeHandle, 0)
    if (wait === 0x00000102) return { state: 'running', creationTime }
    if (wait === 0x00000000) return { state: 'exited', creationTime }
    return { state: 'unknown', reason: `WaitForSingleObject returned ${wait}` }
  } finally {
    api.closeHandle(handle as NativeHandle)
  }
}

async function terminateWindowsProcess(pid: number, expectedCreationTime: string, graceMs: number): Promise<boolean> {
  const api = await windowsProcessApi()
  const handle = api.openProcess(api.terminateAccess, 0, pid)
  if (invalidHandle(api.koffi, handle)) return api.getLastError() === 87
  try {
    if (processCreationTime(api, handle as NativeHandle) !== expectedCreationTime) return false
    if (api.terminateProcess(handle as NativeHandle, 1) === 0) {
      throw new Error(`TerminateProcess failed with Win32 code ${api.getLastError()}`)
    }
    const wait = api.waitForSingleObject(handle as NativeHandle, graceMs)
    return wait === 0x00000000
  } finally {
    api.closeHandle(handle as NativeHandle)
  }
}

interface WindowsProcessApi {
  readonly koffi: { address(value: unknown): bigint }
  readonly queryAccess: number
  readonly terminateAccess: number
  readonly openProcess: (access: number, inherit: number, pid: number) => NativeHandle | null
  readonly getProcessTimes: (
    handle: NativeHandle,
    creation: Buffer,
    exit: Buffer,
    kernel: Buffer,
    user: Buffer,
  ) => number
  readonly waitForSingleObject: (handle: NativeHandle, milliseconds: number) => number
  readonly terminateProcess: (handle: NativeHandle, code: number) => number
  readonly closeHandle: (handle: NativeHandle) => number
  readonly getLastError: () => number
}

let windowsApi: Promise<WindowsProcessApi> | undefined

async function windowsProcessApi(): Promise<WindowsProcessApi> {
  windowsApi ??= loadWindowsProcessApi()
  return windowsApi
}

async function loadWindowsProcessApi(): Promise<WindowsProcessApi> {
  const koffi = (await import('koffi')).default
  const kernel32 = koffi.load('kernel32.dll')
  return {
    koffi,
    queryAccess: 0x00100000 | 0x1000,
    terminateAccess: 0x00100000 | 0x1000 | 0x0001,
    openProcess: kernel32.func('__stdcall', 'OpenProcess', 'void *', ['uint', 'int', 'uint']) as WindowsProcessApi['openProcess'],
    getProcessTimes: kernel32.func('__stdcall', 'GetProcessTimes', 'int', ['void *', 'void *', 'void *', 'void *', 'void *']) as WindowsProcessApi['getProcessTimes'],
    waitForSingleObject: kernel32.func('__stdcall', 'WaitForSingleObject', 'uint', ['void *', 'uint']) as WindowsProcessApi['waitForSingleObject'],
    terminateProcess: kernel32.func('__stdcall', 'TerminateProcess', 'int', ['void *', 'uint']) as WindowsProcessApi['terminateProcess'],
    closeHandle: kernel32.func('__stdcall', 'CloseHandle', 'int', ['void *']) as WindowsProcessApi['closeHandle'],
    getLastError: kernel32.func('__stdcall', 'GetLastError', 'uint', []) as WindowsProcessApi['getLastError'],
  }
}

function processCreationTime(api: WindowsProcessApi, handle: NativeHandle): string {
  const creation = Buffer.alloc(8)
  if (api.getProcessTimes(handle, creation, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)) === 0) {
    throw new Error(`GetProcessTimes failed with Win32 code ${api.getLastError()}`)
  }
  const fileTime = creation.readBigUInt64LE(0)
  const unixMilliseconds = Number((fileTime - 116444736000000000n) / 10000n)
  return new Date(unixMilliseconds).toISOString()
}

function invalidHandle(koffi: { address(value: unknown): bigint }, value: NativeHandle | null): boolean {
  if (value === null) return true
  const address = koffi.address(value)
  return address === 0n || address === -1n || address === 0xffffffffffffffffn || address === 0xffffffffn
}
