import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import {
  digestJson,
  digestPhase3Body,
  type FormalRunPlan,
  type RepositoryAudit,
  type ReproductionPlan,
  type RunRecord,
  type SourceRecord,
  type TestSpec,
} from '@georesearch/dsh-contracts'
import { projectPaths } from '@georesearch/dsh-project-provider-files'
import { ProjectCoordinator } from '@georesearch/dsh-project-service'
import {
  RunSupervisor,
  type ProcessInspection,
  type SupervisorProcessHandle,
  type SupervisorProcessInspector,
  type SupervisorRuntime,
  type SupervisorSpawnSpec,
} from '@georesearch/dsh-run-supervisor'
import type { Agent, SandboxMode, ToolExecution } from '@georesearch/dsh-compat-rc5'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RunCoordinator,
  confineRunArgv,
  runTools,
  type ConfinedRun,
  type RunHostPort,
} from '../src/index.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Harness sandbox inheritance', () => {
  it.each<SandboxMode>(['read-only', 'workspace-write'])(
    'passes the effective %s policy to the Harness sandbox provider',
    mode => {
      const agent = agentAt('D:\\session-workspace', 'coordinator')
      const confine = vi.fn(() => ({
        argv: ['sandbox-runner.exe', '--', 'node.exe', 'experiment.js'],
        enforcement: 'partial' as const,
      }))
      const resolve = vi.fn(() => ({
        mode,
        workspaceRoot: 'D:\\session-workspace',
        sessionId: agent.session.id,
      }))
      const ctx = { sandbox: { confine }, sandboxPolicy: { resolve } } as unknown as Context

      expect(confineRunArgv(ctx, ['node.exe', 'experiment.js'], agent)).toEqual({
        argv: ['sandbox-runner.exe', '--', 'node.exe', 'experiment.js'],
        mode,
        enforcement: 'partial',
      })
      expect(resolve).toHaveBeenCalledWith({ session: agent.session })
      expect(confine).toHaveBeenCalledWith(
        ['node.exe', 'experiment.js'],
        { mode, workspaceRoot: 'D:\\session-workspace', sessionId: agent.session.id },
      )
    },
  )

  it('runs the original argv under danger-full-access without calling the sandbox provider', () => {
    const agent = agentAt('D:\\session-workspace', 'coordinator')
    const confine = vi.fn()
    const ctx = {
      sandbox: { confine },
      sandboxPolicy: {
        resolve: vi.fn(() => ({
          mode: 'danger-full-access',
          workspaceRoot: 'D:\\session-workspace',
          sessionId: agent.session.id,
        })),
      },
    } as unknown as Context

    expect(confineRunArgv(ctx, ['node.exe', 'experiment.js'], agent)).toEqual({
      argv: ['node.exe', 'experiment.js'],
      mode: 'danger-full-access',
    })
    expect(confine).not.toHaveBeenCalled()
  })
})

describe('formal run lifecycle', () => {
  it('rejects an arbitrary formal protocol digest before sandbox resolution', async () => {
    const fixture = await runFixture()
    await expect(fixture.runs.submitFormalRun(
      executionAt(fixture.workspace, 'coordinator', 'arbitrary-protocol').execution,
      1,
      formalPlan('formal-arbitrary'),
    )).rejects.toMatchObject({ code: 'RUN_PLAN_INVALID' })
    expect(fixture.host.confineCalls).toBe(0)
    expect(fixture.runtime.spawns).toHaveLength(0)
  })

  it('uses exact confined argv, ignores the submitting Tool signal, persists every state, and replays exactly', async () => {
    const fixture = await runFixture()
    const call = executionAt(fixture.workspace, 'coordinator', 'formal-call')
    const { plan, expectedGeneration } = await boundFormalPlan(fixture, 'formal-success')
    const submitted = await fixture.runs.submitFormalRun(call.execution, expectedGeneration, plan)

    expect(submitted.run.state).toBe('running')
    expect(fixture.runtime.spawns).toHaveLength(1)
    expect(fixture.runtime.spawns[0]?.spec.argv).toEqual(['sandbox-runner.exe', '--', ...plan.argv])
    expect(fixture.runtime.spawns[0]?.spec.signal).toBeInstanceOf(AbortSignal)
    expect(submitted.run.sandbox).toEqual({ mode: 'workspace-write', enforcement: 'partial' })
    expect(submitted.run).not.toHaveProperty('approval')

    call.controller.abort()
    await Promise.resolve()
    const handle = fixture.runtime.spawns[0]?.handle
    expect(handle?.terminateCalls()).toBe(0)
    handle?.finish({ exitCode: 0, signal: null })
    const pending = fixture.runs.waitForRun(fixture.projectId, plan.runId)
    expect(pending).toBeDefined()
    const terminal = await pending
    expect(terminal).toMatchObject({ state: 'succeeded', exitCode: 0 })

    const eventStates = await runEventStates(fixture.home, fixture.projectId, plan.runId)
    expect(eventStates).toEqual(['starting', 'running', 'collecting', 'succeeded'])
    expect(await readFile(join(projectPaths(fixture.home, fixture.projectId).runs, plan.runId, 'stdout.log'), 'utf8'))
      .toBe('formal stdout')

    const replay = await fixture.runs.submitFormalRun(call.execution, expectedGeneration, plan)
    expect(replay).toEqual(submitted)
    expect(fixture.runtime.spawns).toHaveLength(1)

    const modified = formalPlan(plan.runId, { argv: ['node.exe', 'modified.js'] })
    await expect(fixture.runs.submitFormalRun(call.execution, expectedGeneration, modified))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })

  it.each<SandboxMode>(['read-only', 'danger-full-access'])(
    'records and executes the effective Harness %s mode without a plugin approval record',
    async mode => {
      const fixture = await runFixture()
      fixture.host.mode = mode
      const { plan, expectedGeneration } = await boundFormalPlan(fixture, `formal-${mode}`)
      const submitted = await fixture.runs.submitFormalRun(
        executionAt(fixture.workspace, 'coordinator', `formal-${mode}-call`).execution,
        expectedGeneration,
        plan,
      )

      expect(submitted.run.sandbox).toEqual(expectedSandbox(mode))
      expect(submitted.run).not.toHaveProperty('approval')
      expect(fixture.runtime.spawns[0]?.spec.argv).toEqual(
        mode === 'danger-full-access' ? plan.argv : ['sandbox-runner.exe', '--', ...plan.argv],
      )
      fixture.runtime.spawns[0]?.handle.finish({ exitCode: 0, signal: null })
      await fixture.runs.waitForRun(fixture.projectId, plan.runId)
    },
  )

  it('fails closed before spawn when the Harness sandbox backend is unavailable', async () => {
    const fixture = await runFixture()
    const { plan, expectedGeneration } = await boundFormalPlan(fixture, 'formal-no-sandbox')
    fixture.host.sandboxError = new Error('no usable backend')
    await expect(fixture.runs.submitFormalRun(
      executionAt(fixture.workspace, 'coordinator', 'sandbox-call').execution,
      expectedGeneration,
      plan,
    )).rejects.toMatchObject({ code: 'RUN_SANDBOX_UNAVAILABLE' })
    expect(fixture.runtime.spawns).toHaveLength(0)
    expect(Object.keys((await fixture.projects.loadProject(fixture.projectId)).state.runs)).toHaveLength(0)
  })

  it('reverifies every formal input Artifact digest before sandbox resolution', async () => {
    const fixture = await runFixture()
    const { plan, expectedGeneration } = await boundFormalPlan(
      fixture,
      'formal-missing-input',
      { datasetDigests: [digestJson({ missing: true })] },
    )
    await expect(fixture.runs.submitFormalRun(
      executionAt(fixture.workspace, 'coordinator', 'missing-input-call').execution,
      expectedGeneration,
      plan,
    )).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' })
    expect(fixture.host.confineCalls).toBe(0)
  })

  it('cancels a formal run only through the explicit Coordinator tool path', async () => {
    const fixture = await runFixture()
    const { plan, expectedGeneration } = await boundFormalPlan(fixture, 'formal-cancelled')
    const submitted = await fixture.runs.submitFormalRun(
      executionAt(fixture.workspace, 'coordinator', 'formal-cancel-submit').execution,
      expectedGeneration,
      plan,
    )
    const cancelled = await fixture.runs.cancelRun(
      executionAt(fixture.workspace, 'coordinator', 'formal-cancel').execution,
      submitted.run.runId,
    )
    expect(cancelled.state).toBe('cancelled')
    expect(fixture.runtime.spawns[0]?.handle.terminateCalls()).toBe(1)
    expect(fixture.runtime.spawns[0]?.handle.waitCalls()).toBeGreaterThanOrEqual(1)
  })
})

describe('local TestSpec execution', () => {
  it('rejects forbidden or shell-shaped TestSpecs during Host registration', async () => {
    const fixture = await runFixture()
    expect(() => new RunCoordinator({
      home: fixture.home,
      projects: fixture.projects,
      supervisor: fixture.supervisor,
      host: fixture.host,
      testSpecs: [{
        schemaVersion: 1,
        testSpecId: 'bad-shell',
        runner: 'smoke',
        argv: ['pwsh.exe', '-Command', 'Get-ChildItem'],
        cwdRelative: '.',
        timeoutMs: 1000,
        graceMs: 100,
        environment: {},
      }],
    })).toThrow(expect.objectContaining({ code: 'TEST_SPEC_INVALID' }))
  })

  it('runs only the registered argv and preserves failed stdout/stderr through collecting', async () => {
    const spec = smokeSpec('registered-failure', 5_000)
    const fixture = await runFixture([spec])
    const promise = fixture.runs.runLocalTest(
      executionAt(fixture.workspace, 'experiment', 'local-failure').execution,
      spec.testSpecId,
    )
    const spawned = await fixture.runtime.waitForSpawn(0)
    expect(spawned.spec.argv).toEqual(['sandbox-runner.exe', '--', ...spec.argv])
    spawned.handle.setOutput('test stdout', 'test stderr')
    spawned.handle.finish({ exitCode: 2, signal: null })
    const result = await promise
    expect(result.run).toMatchObject({
      state: 'failed',
      exitCode: 2,
      failureClassification: { code: 'RUN_EXIT_NONZERO' },
    })
    expect(await readFile(join(projectPaths(fixture.home, fixture.projectId).runs, result.run.runId, 'stdout.log'), 'utf8'))
      .toBe('test stdout')
    expect(await readFile(join(projectPaths(fixture.home, fixture.projectId).runs, result.run.runId, 'stderr.log'), 'utf8'))
      .toBe('test stderr')
    expect(await runEventStates(fixture.home, fixture.projectId, result.run.runId))
      .toEqual(['starting', 'running', 'collecting', 'failed'])
  })

  it.each<SandboxMode>(['read-only', 'workspace-write', 'danger-full-access'])(
    'inherits Harness %s for local tests',
    async mode => {
      const spec = smokeSpec(`local-${mode}`, 5_000)
      const fixture = await runFixture([spec])
      fixture.host.mode = mode
      const pending = fixture.runs.runLocalTest(
        executionAt(fixture.workspace, 'experiment', `local-${mode}-call`).execution,
        spec.testSpecId,
      )
      const spawned = await fixture.runtime.waitForSpawn(0)
      expect(spawned.spec.argv).toEqual(
        mode === 'danger-full-access' ? spec.argv : ['sandbox-runner.exe', '--', ...spec.argv],
      )
      spawned.handle.finish({ exitCode: 0, signal: null })
      const result = await pending
      expect(result.run.sandbox).toEqual(expectedSandbox(mode))
    },
  )

  it('maps the local Tool signal to terminate-and-join and a cancelled terminal record', async () => {
    const spec = smokeSpec('registered-cancel', 5_000)
    const fixture = await runFixture([spec])
    const call = executionAt(fixture.workspace, 'experiment', 'local-cancel')
    const promise = fixture.runs.runLocalTest(call.execution, spec.testSpecId)
    const spawned = await fixture.runtime.waitForSpawn(0)
    call.controller.abort()
    const result = await promise
    expect(result.run.state).toBe('cancelled')
    expect(spawned.handle.terminateCalls()).toBe(1)
    expect(spawned.handle.waitCalls()).toBeGreaterThanOrEqual(1)
  })

  it('classifies a registered timeout as failed after terminate-and-join', async () => {
    const spec = smokeSpec('registered-timeout', 20)
    const fixture = await runFixture([spec])
    const result = await fixture.runs.runLocalTest(
      executionAt(fixture.workspace, 'experiment', 'local-timeout').execution,
      spec.testSpecId,
    )
    expect(result.run).toMatchObject({
      state: 'failed',
      failureClassification: { code: 'RUN_TIMEOUT', retryable: true },
    })
    expect(fixture.runtime.spawns[0]?.handle.terminateCalls()).toBe(1)
    expect(fixture.runtime.spawns[0]?.handle.waitCalls()).toBeGreaterThanOrEqual(1)
  })

  it('accepts only testSpecId at the model boundary and registers all six Phase 2 run tools', () => {
    const tools = runTools({} as Context)
    expect(tools.map(tool => tool.name)).toEqual([
      'formal_run_candidate',
      'formal_run_submit',
      'run_status',
      'run_cancel',
      'run_record_read',
      'local_test_run',
    ])
    const local = tools.find(tool => tool.name === 'local_test_run')
    const localProperties = (local?.parameters as Record<string, unknown>).properties
    expect(localProperties).toEqual({ testSpecId: { type: 'string', minLength: 1 } })
    for (const tool of tools) {
      const properties = (tool.parameters as Record<string, unknown>).properties as Record<string, unknown>
      expect(properties).not.toHaveProperty('projectId')
      expect(properties).not.toHaveProperty('cwd')
    }
  })

  it('persists a later-audit TestSpec, rejects dynamic smoke, and binds the local run to it', async () => {
    const fixture = await runFixture()
    const seeded = await seedPhase4Plan(fixture)
    fixture.sourceTree.digest = seeded.final.sourceTreeDigest
    const execution = executionAt(fixture.workspace, 'experiment', 'phase4-test-spec')
    await expect(fixture.runs.testSpecCandidate(execution.execution, {
      planId: seeded.plan.planId,
      repositoryAuditId: seeded.final.auditId,
      spec: smokeSpec('dynamic-smoke', 5_000),
    })).rejects.toMatchObject({ code: 'TEST_SPEC_INVALID' })

    const record = await fixture.runs.testSpecCandidate(execution.execution, {
      planId: seeded.plan.planId,
      repositoryAuditId: seeded.final.auditId,
      spec: {
        schemaVersion: 1,
        testSpecId: 'phase4-pytest',
        runner: 'pytest',
        argv: ['python', '-m', 'pytest'],
        cwdRelative: '.',
        timeoutMs: 5_000,
        graceMs: 100,
        environment: {},
      },
    })
    const pending = fixture.runs.runLocalTest(
      executionAt(fixture.workspace, 'experiment', 'phase4-local-run').execution,
      record.spec.testSpecId,
    )
    const spawned = await fixture.runtime.waitForSpawn(0)
    expect(spawned.spec.argv).toEqual(['sandbox-runner.exe', '--', 'python', '-m', 'pytest'])
    spawned.handle.finish({ exitCode: 0, signal: null })
    const result = await pending
    expect(result.run).toMatchObject({
      state: 'succeeded',
      kind: 'local-test',
      sourceTreeDigest: seeded.final.sourceTreeDigest,
      experimentSpecDigest: record.specDigest,
    })
    const reloaded = await fixture.projects.loadProject(fixture.projectId)
    expect(reloaded.state.reproductionTestSpecs?.[record.spec.testSpecId]).toEqual(record)
  })

  it('fails closed when a reproduction-bound local or formal run no longer matches its audited tree', async () => {
    const fixture = await runFixture()
    const seeded = await seedPhase4Plan(fixture)
    const experiment = executionAt(fixture.workspace, 'experiment', 'phase4-stale-test-spec')
    const record = await fixture.runs.testSpecCandidate(experiment.execution, {
      planId: seeded.plan.planId,
      repositoryAuditId: seeded.final.auditId,
      spec: {
        schemaVersion: 1,
        testSpecId: 'phase4-stale-pytest',
        runner: 'pytest',
        argv: ['python', '-m', 'pytest'],
        cwdRelative: '.',
        timeoutMs: 5_000,
        graceMs: 100,
        environment: {},
      },
    })

    fixture.sourceTree.digest = digestJson({ tree: 'changed-after-audit' })
    await expect(fixture.runs.runLocalTest(
      executionAt(fixture.workspace, 'experiment', 'phase4-stale-local-run').execution,
      record.spec.testSpecId,
    )).rejects.toMatchObject({ code: 'TEST_SPEC_INVALID' })

    const state = await fixture.projects.loadProject(fixture.projectId)
    const formal = formalPlan('phase4-stale-formal', {
      experimentSpecDigest: seeded.plan.digest,
      sourceTreeDigest: seeded.final.sourceTreeDigest,
    })
    await expect(fixture.runs.submitFormalRun(
      executionAt(fixture.workspace, 'coordinator', 'phase4-stale-formal-run').execution,
      state.generation,
      formal,
    )).rejects.toMatchObject({ code: 'RUN_PLAN_INVALID' })
    expect(fixture.runtime.spawns).toHaveLength(0)
  })
})

describe('restart reconciliation', () => {
  it('promotes starting from a persisted receipt and later collects a persisted exit marker', async () => {
    const fixture = await runFixture()
    const { plan, expectedGeneration } = await boundFormalPlan(fixture, 'restart-run')
    const starting = startingRecord(fixture, plan)
    await fixture.projects.commitRunRecord(fixture.projectId, {
      expectedGeneration,
      operationKey: digestJson({ operation: 'restart-start' }),
      requestDigest: digestJson({ request: 'restart-start' }),
      run: starting,
      initial: true,
    })
    await fixture.supervisor.persistRunRecord(fixture.home, fixture.projectId, starting)
    const launch = await fixture.supervisor.launch({
      home: fixture.home,
      projectId: fixture.projectId,
      run: starting,
      confinedArgv: ['sandbox-runner.exe', '--', ...starting.argv],
      environment: {},
      graceMs: starting.resourceLimits.graceMs,
      stdoutMaxBytes: starting.resourceLimits.stdoutMaxBytes,
      stderrMaxBytes: starting.resourceLimits.stderrMaxBytes,
    })

    const restarted = new RunCoordinator({
      home: fixture.home,
      projects: fixture.projects,
      supervisor: fixture.supervisor,
      host: fixture.host,
    })
    await expect(restarted.status(agentAt(fixture.workspace, 'coordinator'), starting.runId))
      .resolves.toMatchObject({ state: 'running', pid: launch.receipt.pid })

    fixture.runtime.spawns[0]?.handle.finish({ exitCode: 0, signal: null })
    await launch.completion
    await expect(restarted.status(agentAt(fixture.workspace, 'coordinator'), starting.runId))
      .resolves.toMatchObject({ state: 'succeeded', exitCode: 0 })
    expect(await runEventStates(fixture.home, fixture.projectId, starting.runId))
      .toEqual(['starting', 'running', 'collecting', 'succeeded'])
  })

  it.each([
    ['cancelled', 'cancelled', undefined],
    ['timeout', 'failed', 'RUN_TIMEOUT'],
  ] as const)('restores persisted %s termination semantics from the exit marker', async (
    reason,
    expectedState,
    failureCode,
  ) => {
    const fixture = await runFixture()
    const { plan, expectedGeneration } = await boundFormalPlan(fixture, `restart-${reason}`)
    const starting = startingRecord(fixture, plan)
    await fixture.projects.commitRunRecord(fixture.projectId, {
      expectedGeneration,
      operationKey: digestJson({ operation: `restart-${reason}` }),
      requestDigest: digestJson({ request: `restart-${reason}` }),
      run: starting,
      initial: true,
    })
    await fixture.supervisor.persistRunRecord(fixture.home, fixture.projectId, starting)
    const launch = await fixture.supervisor.launch({
      home: fixture.home,
      projectId: fixture.projectId,
      run: starting,
      confinedArgv: ['sandbox-runner.exe', '--', ...starting.argv],
      environment: {},
      graceMs: starting.resourceLimits.graceMs,
      stdoutMaxBytes: starting.resourceLimits.stdoutMaxBytes,
      stderrMaxBytes: starting.resourceLimits.stderrMaxBytes,
    })
    await fixture.supervisor.cancel(
      fixture.home,
      fixture.projectId,
      starting.runId,
      starting.resourceLimits.graceMs,
      reason,
    )
    await launch.completion

    const restarted = new RunCoordinator({
      home: fixture.home,
      projects: fixture.projects,
      supervisor: fixture.supervisor,
      host: fixture.host,
    })
    const reconciled = await restarted.status(agentAt(fixture.workspace, 'coordinator'), starting.runId)
    expect(reconciled.state).toBe(expectedState)
    expect(reconciled.failureClassification?.code).toBe(failureCode)
  })
})

describe('formal candidate validation', () => {
  it('is Experiment-only and binds the candidate digest to the validated plan', async () => {
    const fixture = await runFixture()
    const plan = formalPlan('candidate-run')
    const candidate = fixture.runs.formalRunCandidate(
      executionAt(fixture.workspace, 'experiment', 'candidate-call').execution,
      plan,
    )
    expect(candidate).toEqual({ candidateDigest: digestJson(plan), plan })
    expect(() => fixture.runs.formalRunCandidate(
      executionAt(fixture.workspace, 'coordinator', 'candidate-role').execution,
      plan,
    )).toThrow(expect.objectContaining({ code: 'GEORESEARCH_ROLE_MISMATCH' }))
    expect(() => fixture.runs.formalRunCandidate(
      executionAt(fixture.workspace, 'experiment', 'candidate-digest').execution,
      { ...plan, argvDigest: digestJson(['different']) },
    )).toThrow(expect.objectContaining({ code: 'RUN_PLAN_INVALID' }))
  })
})

async function runFixture(testSpecs: readonly TestSpec[] = []) {
  const root = await temporaryRoot('georesearch-run-service-')
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  await mkdir(workspace)
  const projects = new ProjectCoordinator({ home })
  const attached = await projects.resolveAgent(agentAt(workspace, 'coordinator'), { attachIfMissing: true })
  const runtime = new ControlledRuntime()
  const inspector = new RuntimeInspector(runtime)
  let clockTick = 0
  const clock = () => new Date(Date.UTC(2026, 7, 16, 0, 0, 0, clockTick++)).toISOString()
  const supervisor = new RunSupervisor(runtime, inspector, clock)
  const host = new FakeHost()
  const sourceTree = { digest: digestJson({ tree: 'unattested' }) }
  const runs = new RunCoordinator({
    home,
    projects,
    supervisor,
    host,
    testSpecs,
    sourceTreeInspector: async () => sourceTree.digest,
    now: clock,
  })
  runtime.defaultOutput = { stdout: 'formal stdout', stderr: 'formal stderr' }
  return {
    root,
    workspace,
    home,
    projects,
    projectId: attached.stateFile.projectId,
    workspaceId: attached.binding.workspaceId,
    runtime,
    inspector,
    supervisor,
    host,
    sourceTree,
    runs,
  }
}

function formalPlan(
  runId: string,
  overrides: Partial<Omit<FormalRunPlan, 'argvDigest' | 'environmentDigest'>> = {},
): FormalRunPlan {
  const base: FormalRunPlan = {
    schemaVersion: 1,
    runId,
    argv: ['node.exe', 'experiment.js'],
    argvDigest: digestJson(['node.exe', 'experiment.js']),
    experimentSpecDigest: digestJson({ experiment: runId }),
    sourceTreeDigest: digestJson({ source: runId }),
    environmentDigest: digestJson({}),
    datasetDigests: [],
    seed: 42,
    resourceLimits: {
      timeoutMs: 5_000,
      graceMs: 100,
      stdoutMaxBytes: 1024,
      stderrMaxBytes: 1024,
    },
    environment: {},
  }
  const merged = { ...base, ...overrides }
  return {
    ...merged,
    argv: [...merged.argv],
    argvDigest: digestJson(merged.argv),
    environment: { ...merged.environment },
    environmentDigest: digestJson(merged.environment),
  }
}

function expectedSandbox(mode: SandboxMode): RunRecord['sandbox'] {
  return mode === 'danger-full-access'
    ? { mode }
    : { mode, enforcement: 'partial' }
}

async function boundFormalPlan(
  fixture: Awaited<ReturnType<typeof runFixture>>,
  runId: string,
  overrides: Partial<Omit<FormalRunPlan, 'argvDigest' | 'environmentDigest'>> = {},
): Promise<{ readonly plan: FormalRunPlan; readonly expectedGeneration: number }> {
  const seeded = await seedPhase4Plan(fixture)
  fixture.sourceTree.digest = seeded.final.sourceTreeDigest
  return {
    plan: formalPlan(runId, {
      experimentSpecDigest: seeded.plan.digest,
      sourceTreeDigest: seeded.final.sourceTreeDigest,
      ...overrides,
    }),
    expectedGeneration: 5,
  }
}

function smokeSpec(testSpecId: string, timeoutMs: number): TestSpec {
  return {
    schemaVersion: 1,
    testSpecId,
    runner: 'smoke',
    argv: ['node.exe', '--version'],
    cwdRelative: '.',
    timeoutMs,
    graceMs: 100,
    environment: {},
  }
}

async function seedPhase4Plan(fixture: Awaited<ReturnType<typeof runFixture>>): Promise<{
  readonly plan: ReproductionPlan
  readonly final: RepositoryAudit
}> {
  const source = phase4Source()
  await fixture.projects.commitSourceRecord(fixture.projectId, {
    expectedGeneration: 1,
    operationKey: digestJson({ operation: 'phase4-source' }),
    requestDigest: digestJson({ request: 'phase4-source' }),
    source,
  })
  const baseline = phase4Audit(fixture, source, 'phase4-baseline', digestJson({ tree: 'baseline' }), false)
  await fixture.projects.commitRepositoryAudit(fixture.projectId, {
    expectedGeneration: 2,
    operationKey: digestJson({ operation: 'phase4-baseline' }),
    requestDigest: digestJson({ request: 'phase4-baseline' }),
    repositoryAudit: baseline,
  })
  const plan = phase4Plan(baseline)
  await fixture.projects.commitReproductionPlan(fixture.projectId, {
    expectedGeneration: 3,
    operationKey: digestJson({ operation: 'phase4-plan' }),
    requestDigest: digestJson({ request: 'phase4-plan' }),
    reproductionPlan: plan,
  })
  const final = phase4Audit(fixture, source, 'phase4-final', digestJson({ tree: 'modified' }), true)
  await fixture.projects.commitRepositoryAudit(fixture.projectId, {
    expectedGeneration: 4,
    operationKey: digestJson({ operation: 'phase4-final' }),
    requestDigest: digestJson({ request: 'phase4-final' }),
    repositoryAudit: final,
  })
  return { plan, final }
}

function phase4Source(): SourceRecord {
  const body = {
    schemaVersion: 1 as const,
    sourceId: 'source-phase4-run',
    title: 'Phase 4 run fixture',
    authors: [{ name: 'A. Researcher', orcid: null }],
    year: 2025,
    venue: 'Fixture Journal',
    stableIdentifier: { kind: 'doi' as const, value: '10.1234/phase4.run' },
    sourceType: 'journal-article',
    versionRelation: { kind: 'none' as const, relatedIdentifier: null },
    retrievedAt: '2026-08-18T00:00:00.000Z',
    providerTrace: {
      providerId: 'fixture',
      providerVersion: '1.0.0',
      retrievedAt: '2026-08-18T00:00:00.000Z',
      credentialRef: null,
      credentialBindingEpoch: 0,
      requestId: null,
    },
    codeRefs: [{ url: 'https://github.com/example/repository.git', label: 'official' }],
    dataRefs: [],
    status: 'resolved' as const,
    searchChain: { chainId: 'chain-phase4-run', generation: 1, providerItemId: '10.1234/phase4.run' },
  }
  return { ...body, digest: digestPhase3Body(body) }
}

function phase4Audit(
  fixture: Awaited<ReturnType<typeof runFixture>>,
  source: SourceRecord,
  auditId: string,
  sourceTreeDigest: `sha256:${string}`,
  dirty: boolean,
): RepositoryAudit {
  const body = {
    schemaVersion: 1 as const,
    auditId,
    projectId: fixture.projectId,
    workspaceId: fixture.workspaceId,
    workspaceBindingVersion: 1,
    sourceId: source.sourceId,
    sourceDigest: source.digest,
    repository: {
      capability: {
        providerId: 'git-cli' as const,
        providerVersion: '1.0.0',
        shell: false as const,
        readOnlyCommands: true as const,
        maxFiles: 20_000,
        maxChanges: 2_000,
        maxHashedBytes: 268_435_456,
      },
      canonicalRoot: fixture.workspace,
      gitDir: join(fixture.workspace, '.git'),
      gitCommonDir: join(fixture.workspace, '.git'),
      remoteUrl: source.codeRefs[0]?.url ?? null,
      headCommit: 'a'.repeat(40),
      branch: 'main',
      detached: false,
      tags: [],
      targetRef: 'HEAD',
      targetCommit: 'a'.repeat(40),
      targetMatchesHead: true,
      dirty,
      changes: dirty ? [{ status: '.M', path: 'src/model.py' }] : [],
    },
    sourceTreeDigest,
    languages: [{ language: 'Python', fileCount: 1 }],
    buildSystems: [{ name: 'Python packaging', manifestPaths: ['pyproject.toml'] }],
    entryPoints: ['src/model.py'],
    configurationFiles: ['pyproject.toml'],
    dataDependencyPaths: ['data'],
    environmentFiles: ['pyproject.toml'],
    testPaths: ['tests'],
    methodCodeDeltas: [],
    blockers: [],
    auditedAt: dirty ? '2026-08-18T00:00:03.000Z' : '2026-08-18T00:00:01.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

function phase4Plan(audit: RepositoryAudit): ReproductionPlan {
  const body = {
    schemaVersion: 1 as const,
    planId: 'phase4-plan',
    sourceId: audit.sourceId,
    repositoryAuditId: audit.auditId,
    targetRepository: { remoteUrl: audit.repository.remoteUrl, commit: audit.repository.targetCommit as string },
    targetData: [],
    targetResults: [],
    scope: 'functional' as const,
    environmentRequirements: ['Python'],
    missingMaterials: [],
    steps: [{ stepId: 'test', kind: 'test' as const, description: 'Run pytest.', expectedOutputs: ['result'] }],
    expectedOutputs: ['result'],
    tolerances: [],
    blockers: [],
    projectId: audit.projectId,
    workspaceId: audit.workspaceId,
    workspaceBindingVersion: audit.workspaceBindingVersion,
    repositoryAuditDigest: audit.digest,
    sourceTreeDigest: audit.sourceTreeDigest,
    status: 'candidate' as const,
    createdAt: '2026-08-18T00:00:02.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

function startingRecord(fixture: Awaited<ReturnType<typeof runFixture>>, plan: FormalRunPlan): RunRecord {
  return {
    schemaVersion: 1,
    runId: plan.runId,
    kind: 'formal',
    projectId: fixture.projectId,
    workspaceId: fixture.workspaceId,
    workspaceBindingVersion: 1,
    experimentSpecDigest: plan.experimentSpecDigest,
    sourceTreeDigest: plan.sourceTreeDigest,
    environmentDigest: plan.environmentDigest,
    datasetDigests: plan.datasetDigests,
    seed: plan.seed,
    argv: plan.argv,
    argvDigest: plan.argvDigest,
    cwd: {
      canonicalPath: fixture.workspace,
      volumeIdentity: 'restart-volume',
      fileIdentity: 'restart-file',
    },
    state: 'starting',
    launchId: 'launch-restart-run',
    resourceLimits: {
      timeoutMs: 5_000,
      graceMs: 100,
      stdoutMaxBytes: 1024,
      stderrMaxBytes: 1024,
    },
    stdoutPath: `runs/${plan.runId}/stdout.log`,
    stderrPath: `runs/${plan.runId}/stderr.log`,
    sandbox: { mode: 'workspace-write', enforcement: 'partial' },
    approval: {
      outcome: 'allowed-once',
      callId: 'restart-call',
      approvedAt: '2026-08-16T00:00:00.000Z',
    },
    outputArtifactRefs: [],
  }
}

function agentAt(cwd: string, actor: 'coordinator' | 'experiment'): Agent {
  return {
    id: actor,
    session: { id: `session-${actor}`, header: { cwd } },
  } as unknown as Agent
}

function executionAt(cwd: string, actor: 'coordinator' | 'experiment', callId: string) {
  const controller = new AbortController()
  return {
    controller,
    execution: {
      agent: agentAt(cwd, actor),
      rootCallId: callId,
      callId,
      signal: controller.signal,
    } as unknown as ToolExecution,
  }
}

class FakeHost implements RunHostPort {
  mode: SandboxMode = 'workspace-write'
  sandboxError: Error | undefined
  confineCalls = 0

  authorizeExecution(agent: Agent, kind: 'formal' | 'local-test'): void {
    const expected = kind === 'formal' ? 'coordinator' : 'experiment'
    if (String(agent.id) !== expected) throw roleError(expected, String(agent.id))
  }

  requireActor(agent: Agent, actor: 'coordinator' | 'literature' | 'experiment' | 'reviewer' | 'writing'): void {
    if (String(agent.id) !== actor) throw roleError(actor, String(agent.id))
  }

  confine(argv: readonly string[]): ConfinedRun {
    this.confineCalls += 1
    if (this.sandboxError !== undefined) throw this.sandboxError
    return this.mode === 'danger-full-access'
      ? { argv: [...argv], mode: this.mode }
      : { argv: ['sandbox-runner.exe', '--', ...argv], mode: this.mode, enforcement: 'partial' }
  }
}

class ControlledRuntime implements SupervisorRuntime {
  readonly spawns: Array<{ readonly spec: SupervisorSpawnSpec; readonly handle: ControlledHandle }> = []
  defaultOutput = { stdout: '', stderr: '' }
  private readonly waiters: Array<() => void> = []

  spawn(spec: SupervisorSpawnSpec): ControlledHandle {
    const handle = new ControlledHandle(5000 + this.spawns.length, this.defaultOutput.stdout, this.defaultOutput.stderr)
    this.spawns.push({ spec, handle })
    this.waiters.splice(0).forEach(resolveWait => resolveWait())
    return handle
  }

  async waitForSpawn(index: number): Promise<{ readonly spec: SupervisorSpawnSpec; readonly handle: ControlledHandle }> {
    while (this.spawns[index] === undefined) {
      await new Promise<void>(resolveWait => this.waiters.push(resolveWait))
    }
    return this.spawns[index] as { readonly spec: SupervisorSpawnSpec; readonly handle: ControlledHandle }
  }

  handle(pid: number): ControlledHandle | undefined {
    return this.spawns.find(spawn => spawn.handle.pid === pid)?.handle
  }
}

class RuntimeInspector implements SupervisorProcessInspector {
  constructor(private readonly runtime: ControlledRuntime) {}

  async creationTime(pid: number): Promise<string> {
    if (this.runtime.handle(pid) === undefined) throw new Error(`missing PID ${pid}`)
    return creationTime(pid)
  }

  async inspect(pid: number, expectedCreationTime: string): Promise<ProcessInspection> {
    const handle = this.runtime.handle(pid)
    if (handle === undefined) return { state: 'missing' }
    if (expectedCreationTime !== creationTime(pid)) return { state: 'reused', creationTime: creationTime(pid) }
    return handle.settled()
      ? { state: 'exited', creationTime: creationTime(pid) }
      : { state: 'running', creationTime: creationTime(pid) }
  }

  async terminate(pid: number, expectedCreationTime: string): Promise<boolean> {
    const inspection = await this.inspect(pid, expectedCreationTime)
    if (inspection.state !== 'running') return inspection.state === 'exited' || inspection.state === 'missing'
    const handle = this.runtime.handle(pid)
    handle?.terminate()
    return handle?.waitForExit() ?? false
  }
}

class ControlledHandle implements SupervisorProcessHandle {
  readonly collected: SupervisorProcessHandle['collected']
  readonly done: SupervisorProcessHandle['done']
  private resolveDone!: (outcome: { readonly exitCode: number | null; readonly signal: string | null }) => void
  private isSettled = false
  private terminateCount = 0
  private waitCount = 0
  private stdoutText: string
  private stderrText: string

  constructor(readonly pid: number, stdout: string, stderr: string) {
    this.stdoutText = stdout
    this.stderrText = stderr
    this.collected = {
      stdout: { readFrom: () => outputRead(this.stdoutText) },
      stderr: { readFrom: () => outputRead(this.stderrText) },
    }
    this.done = new Promise(resolveDone => { this.resolveDone = resolveDone })
  }

  setOutput(stdout: string, stderr: string): void {
    this.stdoutText = stdout
    this.stderrText = stderr
  }

  finish(outcome: { readonly exitCode: number | null; readonly signal: string | null }): void {
    if (this.isSettled) return
    this.isSettled = true
    this.resolveDone(outcome)
  }

  terminate(): void {
    this.terminateCount += 1
    this.finish({ exitCode: null, signal: 'SIGTERM' })
  }

  async waitForExit(): Promise<boolean> {
    this.waitCount += 1
    await this.done
    return true
  }

  settled(): boolean { return this.isSettled }
  terminateCalls(): number { return this.terminateCount }
  waitCalls(): number { return this.waitCount }
}

async function runEventStates(home: string, projectId: string, runId: string): Promise<string[]> {
  const lines = (await readFile(projectPaths(home, projectId).events, 'utf8')).trim().split('\n')
  return lines
    .map(line => JSON.parse(line) as { readonly type: string; readonly data: { readonly run?: RunRecord } })
    .filter(event => (event.type === 'run.recorded' || event.type === 'run.updated') && event.data.run?.runId === runId)
    .map(event => event.data.run?.state as string)
}

function outputRead(text: string) {
  return { text, nextOffset: Buffer.byteLength(text), lossy: false }
}

function creationTime(pid: number): string {
  return new Date(Date.UTC(2026, 7, 16, 0, 0, 0, pid % 1000)).toISOString()
}

function roleError(expected: string, actual: string) {
  return Object.assign(new Error(`expected ${expected}, found ${actual}`), { code: 'GEORESEARCH_ROLE_MISMATCH' })
}

async function temporaryRoot(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(path)
  return path
}
