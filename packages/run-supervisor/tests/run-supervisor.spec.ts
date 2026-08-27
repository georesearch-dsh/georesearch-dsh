import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  digestJson,
  sha256Bytes,
  type RunRecord,
} from '@georesearch/dsh-contracts'
import {
  NativeProcessInspector,
  RunSupervisor,
  type ProcessInspection,
  type SupervisorProcessHandle,
  type SupervisorProcessInspector,
  type SupervisorRuntime,
  type SupervisorSpawnSpec,
} from '../src/index.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('RunSupervisor', () => {
  it('persists intent before spawn, launches exact confined argv, and writes terminal evidence', async () => {
    const fixture = await supervisorFixture()
    const handle = controlledHandle(4201, 'standard output', 'standard error')
    let spawned: SupervisorSpawnSpec | undefined
    const runtime: SupervisorRuntime = {
      spawn(spec) {
        expect(existsSync(fixture.paths.intent)).toBe(true)
        spawned = spec
        return handle
      },
    }
    const supervisor = new RunSupervisor(runtime, inspector('2026-08-16T01:02:03.004Z'), fixture.clock)
    const confinedArgv = ['sandbox-wrapper.exe', '--', 'node.exe', 'experiment.js']
    const launch = await supervisor.launch({
      home: fixture.home,
      projectId: fixture.projectId,
      run: fixture.run,
      confinedArgv,
      environment: { PATH: 'C:\\tools', GEORESEARCH_RUN: '1' },
      graceMs: 500,
      stdoutMaxBytes: 1024,
      stderrMaxBytes: 2048,
    })

    expect(spawned).toMatchObject({
      argv: confinedArgv,
      cwd: fixture.run.cwd.canonicalPath,
      env: { PATH: 'C:\\tools', GEORESEARCH_RUN: '1' },
      graceMs: 500,
      stdoutMaxBytes: 1024,
      stderrMaxBytes: 2048,
    })
    expect(spawned?.signal).toBeInstanceOf(AbortSignal)
    const intent = JSON.parse(await readFile(fixture.paths.intent, 'utf8')) as Record<string, unknown>
    expect(intent.argv).toEqual(confinedArgv)
    expect(intent.argvDigest).toBe(digestJson(confinedArgv))
    expect(launch.receipt.pid).toBe(4201)

    handle.finish({ exitCode: 0, signal: null })
    const completion = await launch.completion
    expect(completion).toMatchObject({ marker: { exitCode: 0, signal: null } })
    expect(completion.terminationReason).toBeUndefined()
    expect(await readFile(fixture.paths.stdout, 'utf8')).toBe('standard output')
    expect(await readFile(fixture.paths.stderr, 'utf8')).toBe('standard error')
    expect(completion.marker.stdoutDigest).toBe(sha256Bytes('standard output'))
    expect(completion.marker.stderrDigest).toBe(sha256Bytes('standard error'))
    expect(JSON.parse(await readFile(fixture.paths.exit, 'utf8'))).toEqual(completion.marker)
  })

  it('does not truncate completed logs when a duplicate launch intent is rejected', async () => {
    const fixture = await supervisorFixture()
    const firstHandle = controlledHandle(4202, 'preserve me', '')
    const supervisor = new RunSupervisor({ spawn: () => firstHandle }, inspector('2026-08-16T01:02:03.004Z'), fixture.clock)
    const request = launchRequest(fixture)
    const first = await supervisor.launch(request)
    firstHandle.finish({ exitCode: 0, signal: null })
    await first.completion

    await expect(supervisor.launch(request)).rejects.toMatchObject({ code: 'EEXIST' })
    expect(await readFile(fixture.paths.stdout, 'utf8')).toBe('preserve me')
  })

  it('leaves an auditable intent and requires recovery when process creation fails', async () => {
    const fixture = await supervisorFixture()
    const supervisor = new RunSupervisor({
      spawn() { throw new Error('CreateProcess denied') },
    }, inspector('2026-08-16T01:02:03.004Z'), fixture.clock)

    await expect(supervisor.launch(launchRequest(fixture))).rejects.toMatchObject({ code: 'RUN_LAUNCH_FAILED' })
    expect(existsSync(fixture.paths.intent)).toBe(true)
    expect(existsSync(fixture.paths.receipt)).toBe(false)
    await expect(supervisor.reconcile(fixture.home, fixture.projectId, fixture.run.runId)).resolves.toEqual({
      state: 'recovery-required',
      reason: 'launch intent has no launch receipt',
    })
  })

  it('terminates and joins a spawned process when the launch receipt cannot be persisted', async () => {
    const fixture = await supervisorFixture()
    const handle = controlledHandle(4210, '', '')
    const failingReceiptInspector: SupervisorProcessInspector = {
      async creationTime() {
        await mkdir(fixture.paths.receipt, { recursive: true })
        return '2026-08-16T01:02:03.004Z'
      },
      async inspect() { return { state: 'running', creationTime: '2026-08-16T01:02:03.004Z' } },
      async terminate() { return true },
    }
    const supervisor = new RunSupervisor({ spawn: () => handle }, failingReceiptInspector, fixture.clock)

    await expect(supervisor.launch(launchRequest(fixture))).rejects.toMatchObject({ code: 'RUN_LAUNCH_FAILED' })
    expect(handle.terminateCalls()).toBe(1)
    expect(handle.waitCalls()).toBe(1)
  })

  it('reconciles a restarted service by launch ID, PID, and process creation time', async () => {
    const fixture = await supervisorFixture()
    const handle = controlledHandle(4203, '', '')
    const firstInspector = inspector('2026-08-16T01:02:03.004Z')
    const first = new RunSupervisor({ spawn: () => handle }, firstInspector, fixture.clock)
    await first.persistRunRecord(fixture.home, fixture.projectId, fixture.run)
    const launch = await first.launch(launchRequest(fixture))

    const terminate = vi.fn(async () => true)
    const runningInspector: SupervisorProcessInspector = {
      async creationTime() { return '2026-08-16T01:02:03.004Z' },
      async inspect() { return { state: 'running', creationTime: '2026-08-16T01:02:03.004Z' } },
      terminate,
    }
    const restarted = new RunSupervisor(unusedRuntime(), runningInspector, fixture.clock)
    await expect(restarted.reconcile(fixture.home, fixture.projectId, fixture.run.runId)).resolves.toEqual({
      state: 'recovery-required',
      reason: 'process was terminated because its output collector was lost after Supervisor restart',
      receipt: launch.receipt,
    })
    expect(terminate).toHaveBeenCalledWith(
      launch.receipt.pid,
      launch.receipt.processCreationTime,
      fixture.run.resourceLimits.graceMs,
    )

    const reused = new RunSupervisor(
      unusedRuntime(),
      inspector('2026-08-16T01:02:03.004Z', { state: 'reused', creationTime: '2026-08-16T09:09:09.009Z' }),
      fixture.clock,
    )
    await expect(reused.reconcile(fixture.home, fixture.projectId, fixture.run.runId)).resolves.toMatchObject({
      state: 'recovery-required',
      reason: 'PID was reused by a different process',
    })

    handle.finish({ exitCode: 7, signal: null })
    const completion = await launch.completion
    await expect(restarted.reconcile(fixture.home, fixture.projectId, fixture.run.runId)).resolves.toEqual({
      state: 'terminal',
      receipt: launch.receipt,
      marker: completion.marker,
    })
  })

  it('terminates and joins an active run before reporting cancellation', async () => {
    const fixture = await supervisorFixture()
    const handle = controlledHandle(4204, 'partial', 'cancelled')
    const supervisor = new RunSupervisor({ spawn: () => handle }, inspector('2026-08-16T01:02:03.004Z'), fixture.clock)
    const launch = await supervisor.launch(launchRequest(fixture))

    await expect(supervisor.cancel(fixture.home, fixture.projectId, fixture.run.runId, 250)).resolves.toBe(true)
    expect(handle.terminateCalls()).toBe(1)
    await expect(launch.completion).resolves.toMatchObject({
      terminationReason: 'cancelled',
      marker: { exitCode: null, signal: 'SIGTERM', terminationReason: 'cancelled' },
    })
    expect(JSON.parse(await readFile(fixture.paths.exit, 'utf8'))).toMatchObject({ terminationReason: 'cancelled' })
  })

  it('persists timeout as part of the authoritative exit marker', async () => {
    const fixture = await supervisorFixture()
    const handle = controlledHandle(4206, 'partial', 'timed out')
    const supervisor = new RunSupervisor({ spawn: () => handle }, inspector('2026-08-16T01:02:03.004Z'), fixture.clock)
    const launch = await supervisor.launch(launchRequest(fixture))

    await expect(supervisor.cancel(
      fixture.home,
      fixture.projectId,
      fixture.run.runId,
      250,
      'timeout',
    )).resolves.toBe(true)
    await expect(launch.completion).resolves.toMatchObject({
      terminationReason: 'timeout',
      marker: { terminationReason: 'timeout' },
    })
  })

  it('strictly rejects a malformed persisted exit marker', async () => {
    const fixture = await supervisorFixture()
    const handle = controlledHandle(4207, '', '')
    const supervisor = new RunSupervisor({ spawn: () => handle }, inspector('2026-08-16T01:02:03.004Z'), fixture.clock)
    const launch = await supervisor.launch(launchRequest(fixture))
    handle.finish({ exitCode: 0, signal: null })
    const completion = await launch.completion
    await writeFile(fixture.paths.exit, `${JSON.stringify({ ...completion.marker, unexpected: true })}\n`, 'utf8')

    await expect(supervisor.reconcile(fixture.home, fixture.projectId, fixture.run.runId))
      .rejects.toThrow(/RunExitMarker contains unsupported fields/)
  })

  it('fails launch closed when PID creation time cannot be established', async () => {
    const fixture = await supervisorFixture()
    const handle = controlledHandle(4205, '', '')
    const failingInspector: SupervisorProcessInspector = {
      async creationTime() { throw new Error('GetProcessTimes denied') },
      async inspect() { return { state: 'unknown', reason: 'unreachable' } },
      async terminate() { return false },
    }
    const supervisor = new RunSupervisor({ spawn: () => handle }, failingInspector, fixture.clock)

    await expect(supervisor.launch(launchRequest(fixture))).rejects.toMatchObject({ code: 'RUN_LAUNCH_FAILED' })
    expect(handle.terminateCalls()).toBe(1)
    expect(handle.waitCalls()).toBe(1)
  })
})

describe('NativeProcessInspector', () => {
  it.runIf(process.platform === 'win32')('distinguishes the live process from PID reuse by creation time', async () => {
    const inspector = new NativeProcessInspector()
    const creationTime = await inspector.creationTime(process.pid)
    await expect(inspector.inspect(process.pid, creationTime)).resolves.toEqual({ state: 'running', creationTime })
    await expect(inspector.inspect(process.pid, '2000-01-01T00:00:00.000Z')).resolves.toEqual({
      state: 'reused',
      creationTime,
    })
  })
})

async function supervisorFixture() {
  const root = await mkdtemp(join(tmpdir(), 'georesearch-supervisor-'))
  temporaryRoots.push(root)
  const home = join(root, 'home')
  const projectId = 'project-supervisor'
  const run = runRecord(projectId)
  const runRoot = join(home, 'georesearch', 'projects', projectId, 'runs', run.runId)
  let tick = 0
  return {
    home,
    projectId,
    run,
    clock: () => `2026-08-16T00:00:0${tick++}.000Z`,
    paths: {
      intent: join(runRoot, 'launch-intent.json'),
      receipt: join(runRoot, 'launch-receipt.json'),
      exit: join(runRoot, 'exit.json'),
      stdout: join(runRoot, 'stdout.log'),
      stderr: join(runRoot, 'stderr.log'),
    },
  }
}

function runRecord(projectId: string): RunRecord {
  const argv = ['node.exe', 'experiment.js']
  return {
    schemaVersion: 1,
    runId: 'run-supervisor',
    kind: 'formal',
    projectId,
    workspaceId: 'workspace-supervisor',
    workspaceBindingVersion: 1,
    experimentSpecDigest: digestJson({ experiment: 1 }),
    sourceTreeDigest: digestJson({ source: 1 }),
    environmentDigest: digestJson({ environment: 1 }),
    datasetDigests: [],
    seed: 42,
    argv,
    argvDigest: digestJson(argv),
    cwd: {
      canonicalPath: 'C:\\workspace',
      volumeIdentity: 'volume',
      fileIdentity: 'directory',
    },
    state: 'starting',
    launchId: 'launch-supervisor',
    resourceLimits: {
      timeoutMs: 60_000,
      graceMs: 250,
      stdoutMaxBytes: 1024,
      stderrMaxBytes: 1024,
    },
    stdoutPath: 'runs/run-supervisor/stdout.log',
    stderrPath: 'runs/run-supervisor/stderr.log',
    sandbox: { mode: 'workspace-write', enforcement: 'partial' },
    approval: {
      outcome: 'allowed-once',
      callId: 'call-supervisor',
      approvedAt: '2026-08-16T00:00:00.000Z',
    },
    outputArtifactRefs: [],
  }
}

function launchRequest(fixture: Awaited<ReturnType<typeof supervisorFixture>>) {
  return {
    home: fixture.home,
    projectId: fixture.projectId,
    run: fixture.run,
    confinedArgv: ['sandbox-wrapper.exe', '--', ...fixture.run.argv],
    environment: { PATH: 'C:\\tools' },
    graceMs: 250,
    stdoutMaxBytes: 1024,
    stderrMaxBytes: 1024,
  }
}

function inspector(
  creationTime: string,
  inspection: ProcessInspection = { state: 'running', creationTime },
): SupervisorProcessInspector {
  return {
    async creationTime() { return creationTime },
    async inspect() { return inspection },
    async terminate() { return true },
  }
}

function unusedRuntime(): SupervisorRuntime {
  return { spawn() { throw new Error('restart reconciliation must not spawn') } }
}

function controlledHandle(pid: number, stdout: string, stderr: string): SupervisorProcessHandle & {
  finish(outcome: { readonly exitCode: number | null; readonly signal: string | null }): void
  terminateCalls(): number
  waitCalls(): number
} {
  let finish!: (outcome: { readonly exitCode: number | null; readonly signal: string | null }) => void
  let terminateCount = 0
  let waitCount = 0
  let settled = false
  const done = new Promise<{ readonly exitCode: number | null; readonly signal: string | null }>(resolve => {
    finish = outcome => {
      settled = true
      resolve(outcome)
    }
  })
  return {
    pid,
    collected: {
      stdout: { readFrom: () => ({ text: stdout, nextOffset: Buffer.byteLength(stdout), lossy: false }) },
      stderr: { readFrom: () => ({ text: stderr, nextOffset: Buffer.byteLength(stderr), lossy: false }) },
    },
    done,
    terminate() {
      terminateCount += 1
      if (!settled) finish({ exitCode: null, signal: 'SIGTERM' })
    },
    async waitForExit() {
      waitCount += 1
      await done
      return true
    },
    finish(outcome) {
      if (!settled) finish(outcome)
    },
    terminateCalls: () => terminateCount,
    waitCalls: () => waitCount,
  }
}
