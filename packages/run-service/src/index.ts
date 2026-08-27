import { basename, isAbsolute, relative, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@georesearch/dsh-installation-guard'
import type {} from '@georesearch/dsh-policy'
import type {} from '@georesearch/dsh-project-service'
import {
  confineArgv,
  operationIdentity,
  registerTool,
  resolveAgentSandboxPolicy,
  resolveDshHome,
  spawnSubprocess,
  type Agent,
  type SandboxMode,
  type ToolDefinition,
  type ToolExecution,
} from '@georesearch/dsh-compat-rc5'
import {
  GeoResearchError,
  RUN_RECORD_SCHEMA,
  digestJson,
  isSha256Digest,
  nowUtc,
  operationKeyFor,
  requestDigestFor,
  type FormalRunPlan,
  type GeoResearchActor,
  type JsonValue,
  type RunKind,
  type RunRecord,
  type RunResourceLimits,
  type ReproductionTestSpecRecord,
  type Sha256Digest,
  type TestRunnerKind,
  type TestSpec,
} from '@georesearch/dsh-contracts'
import {
  assertId,
  canonicalDirectoryIdentity,
  type OperationExecutionOptions,
} from '@georesearch/dsh-project-provider-files'
import {
  type ProjectCoordinator,
  type ResolvedProject,
  type RunRecordCommitRequest,
  type ReproductionTestSpecCommitRequest,
} from '@georesearch/dsh-project-service'
import {
  RunSupervisor,
  type SupervisorCompletion,
  type SupervisorLaunch,
  type SupervisorProcessHandle,
  type SupervisorReconciliation,
  type SupervisorRuntime,
  type SupervisorSpawnSpec,
} from '@georesearch/dsh-run-supervisor'

declare module '@deepseek-ai/cordis' {
  interface Context {
    geoResearchRuns: GeoResearchRunService
  }
}

export const name = 'georesearch-run-service'
export const inject = [
  'geoResearchInstallation',
  'geoResearchPolicy',
  'geoResearchProjects',
  'sandbox',
  'sandboxPolicy',
  'subprocess',
  'tools',
]

const DEFAULT_LOCAL_OUTPUT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_MAX_FORMAL_TIMEOUT_MS = 24 * 60 * 60 * 1_000
const DEFAULT_MAX_FORMAL_OUTPUT_BYTES = 256 * 1024 * 1024
const TRANSITION_RETRIES = 8
const SECRET_ENVIRONMENT_KEY = /(?:^|_)(?:API_?KEY|AUTH|CREDENTIAL|PASSWORD|PRIVATE_?KEY|SECRET|TOKEN)(?:_|$)/iu
const ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u
const SHELL_OPERATOR = /^(?:[<>|&]|&&|\|\|)/u
const FORBIDDEN_LOCAL_EXECUTABLES = new Set([
  'bash',
  'cmd',
  'curl',
  'invoke-webrequest',
  'powershell',
  'pwsh',
  'sh',
])

export interface Config {
  readonly home?: string
  readonly testSpecs?: readonly TestSpec[]
  readonly allowedFormalEnvironmentKeys?: readonly string[]
  readonly localTestOutputMaxBytes?: number
  readonly maxFormalTimeoutMs?: number
  readonly maxFormalOutputBytes?: number
}

export interface RunProjectPort {
  resolveAgent(agent: Agent, options?: { readonly attachIfMissing?: boolean }): Promise<ResolvedProject>
  loadProject(projectId: string): Promise<Awaited<ReturnType<ProjectCoordinator['loadProject']>>>
  listProjectStates(): Promise<Awaited<ReturnType<ProjectCoordinator['listProjectStates']>>>
  recoverProject(projectId: string): ReturnType<ProjectCoordinator['recoverProject']>
  executeOperation<T extends JsonValue>(
    projectId: string,
    operationKey: Sha256Digest,
    requestDigest: Sha256Digest,
    operation: string,
    action: () => Promise<T>,
    options?: OperationExecutionOptions<T>,
  ): Promise<T>
  commitRunRecord(projectId: string, request: RunRecordCommitRequest): Promise<Awaited<ReturnType<ProjectCoordinator['loadProject']>>>
  commitReproductionTestSpec(
    projectId: string,
    request: ReproductionTestSpecCommitRequest,
  ): Promise<Awaited<ReturnType<ProjectCoordinator['loadProject']>>>
  verifyRunInputDigests(projectId: string, digests: readonly Sha256Digest[]): Promise<void>
}

export type ConfinedRun =
  | {
      readonly argv: readonly string[]
      readonly mode: Exclude<SandboxMode, 'danger-full-access'>
      readonly enforcement: 'full' | 'partial'
    }
  | {
      readonly argv: readonly string[]
      readonly mode: 'danger-full-access'
      readonly enforcement?: never
    }

export interface RunHostPort {
  authorizeExecution(agent: Agent, kind: RunKind): void
  requireActor(agent: Agent, actor: GeoResearchActor): void
  confine(argv: readonly string[], agent: Agent): ConfinedRun
}

export type RunSourceTreeInspector = (
  workspaceRoot: string,
  signal?: AbortSignal,
) => Promise<Sha256Digest>

export interface RunSupervisorPort {
  persistRunRecord(home: string, projectId: string, record: RunRecord): Promise<void>
  launch(request: Parameters<RunSupervisor['launch']>[0]): Promise<SupervisorLaunch>
  cancel(
    home: string,
    projectId: string,
    runId: string,
    graceMs: number,
    reason?: 'cancelled' | 'timeout',
  ): Promise<boolean>
  reconcile(home: string, projectId: string, runId: string): Promise<SupervisorReconciliation>
}

export interface RunCoordinatorConfig extends Config {
  readonly home: string
  readonly projects: RunProjectPort
  readonly supervisor: RunSupervisorPort
  readonly host: RunHostPort
  readonly sourceTreeInspector?: RunSourceTreeInspector
  readonly now?: () => string
}

export interface FormalRunCandidate {
  readonly candidateDigest: Sha256Digest
  readonly plan: FormalRunPlan
}

export interface TestSpecCandidateRequest {
  readonly planId: string
  readonly repositoryAuditId: string
  readonly spec: unknown
}

export class RunCoordinator {
  private readonly home: string
  private readonly projects: RunProjectPort
  private readonly supervisor: RunSupervisorPort
  private readonly host: RunHostPort
  private readonly clock: () => string
  private readonly testSpecs = new Map<string, TestSpec>()
  private readonly allowedFormalEnvironmentKeys: ReadonlySet<string>
  private readonly localTestOutputMaxBytes: number
  private readonly maxFormalTimeoutMs: number
  private readonly maxFormalOutputBytes: number
  private readonly pending = new Map<string, Promise<RunRecord>>()
  private sourceTreeInspector: RunSourceTreeInspector | undefined

  constructor(config: RunCoordinatorConfig) {
    this.home = config.home
    this.projects = config.projects
    this.supervisor = config.supervisor
    this.host = config.host
    this.sourceTreeInspector = config.sourceTreeInspector
    this.clock = config.now ?? nowUtc
    this.allowedFormalEnvironmentKeys = new Set(
      (config.allowedFormalEnvironmentKeys ?? []).map(key => environmentKey(key, 'allowedFormalEnvironmentKeys')),
    )
    this.localTestOutputMaxBytes = positiveBoundedInteger(
      config.localTestOutputMaxBytes ?? DEFAULT_LOCAL_OUTPUT_MAX_BYTES,
      'localTestOutputMaxBytes',
      DEFAULT_MAX_FORMAL_OUTPUT_BYTES,
    )
    this.maxFormalTimeoutMs = positiveBoundedInteger(
      config.maxFormalTimeoutMs ?? DEFAULT_MAX_FORMAL_TIMEOUT_MS,
      'maxFormalTimeoutMs',
      DEFAULT_MAX_FORMAL_TIMEOUT_MS,
    )
    this.maxFormalOutputBytes = positiveBoundedInteger(
      config.maxFormalOutputBytes ?? DEFAULT_MAX_FORMAL_OUTPUT_BYTES,
      'maxFormalOutputBytes',
      DEFAULT_MAX_FORMAL_OUTPUT_BYTES,
    )
    for (const raw of config.testSpecs ?? []) {
      let spec: TestSpec
      try {
        spec = parseTestSpec(raw)
      } catch (error) {
        if (error instanceof GeoResearchError && error.code === 'TEST_SPEC_INVALID') throw error
        throw new GeoResearchError('TEST_SPEC_INVALID', errorMessage(error), { cause: error })
      }
      if (this.testSpecs.has(spec.testSpecId)) throw new TypeError(`duplicate TestSpec ${spec.testSpecId}`)
      this.testSpecs.set(spec.testSpecId, spec)
    }
  }

  bindSourceTreeInspector(inspector: RunSourceTreeInspector): () => void {
    if (this.sourceTreeInspector !== undefined && this.sourceTreeInspector !== inspector) {
      throw new Error('a source-tree inspector is already bound')
    }
    this.sourceTreeInspector = inspector
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.sourceTreeInspector === inspector) this.sourceTreeInspector = undefined
    }
  }

  formalRunCandidate(execution: ToolExecution, value: unknown): FormalRunCandidate {
    const agent = exactAgent(execution, 'formal_run_candidate')
    this.host.requireActor(agent, 'experiment')
    const plan = this.parseFormalPlan(value)
    return { candidateDigest: digestJson(plan), plan }
  }

  async testSpecCandidate(
    execution: ToolExecution,
    request: TestSpecCandidateRequest,
  ): Promise<ReproductionTestSpecRecord> {
    const agent = exactAgent(execution, 'test_spec_candidate')
    this.host.requireActor(agent, 'experiment')
    const planId = nonEmptyText(request.planId, 'planId')
    const repositoryAuditId = nonEmptyText(request.repositoryAuditId, 'repositoryAuditId')
    const spec = parseTestSpec(request.spec, false)
    const resolved = await this.projects.resolveAgent(agent)
    const current = await this.projects.loadProject(resolved.stateFile.projectId)
    const plan = current.state.reproductionPlans?.[planId]
    const audit = current.state.repositoryAudits?.[repositoryAuditId]
    if (plan === undefined) throw new GeoResearchError('REPRODUCTION_PLAN_NOT_FOUND', `reproduction plan ${planId} is unknown`)
    if (audit === undefined || audit.sourceId !== plan.sourceId
      || audit.workspaceId !== plan.workspaceId
      || audit.workspaceBindingVersion !== plan.workspaceBindingVersion
      || audit.workspaceId !== resolved.binding.workspaceId
      || audit.workspaceBindingVersion !== resolved.binding.bindingVersion) {
      throw new GeoResearchError(
        'TEST_SPEC_INVALID',
        'TestSpec candidate is not bound to a current audit for the reproduction plan workspace',
      )
    }
    const specDigest = digestJson(spec)
    const registeredAt = this.clock()
    const body = {
      schemaVersion: 1 as const,
      projectId: current.projectId,
      workspaceId: resolved.binding.workspaceId,
      workspaceBindingVersion: resolved.binding.bindingVersion,
      planId,
      repositoryAuditId,
      sourceTreeDigest: audit.sourceTreeDigest,
      spec,
      specDigest,
      registeredAt,
    }
    const record: ReproductionTestSpecRecord = { ...body, digest: digestJson(body) }
    const operation = 'test_spec_candidate'
    const operationKey = operationKeyFor(operationIdentity(execution, current.projectId, operation))
    const requestDigest = requestDigestFor(operation, {
      planId,
      repositoryAuditId,
      spec,
    } as unknown as JsonValue)
    for (let attempt = 0; attempt < TRANSITION_RETRIES; attempt += 1) {
      const latest = await this.projects.loadProject(current.projectId)
      const existing = latest.state.reproductionTestSpecs?.[spec.testSpecId]
      if (existing !== undefined) {
        if (existing.specDigest !== specDigest || existing.planId !== planId
          || existing.repositoryAuditId !== repositoryAuditId) {
          throw new GeoResearchError('TEST_SPEC_INVALID', `TestSpec ${spec.testSpecId} already differs`)
        }
        return existing
      }
      try {
        await this.projects.commitReproductionTestSpec(current.projectId, {
          expectedGeneration: latest.generation,
          operationKey,
          requestDigest,
          reproductionTestSpec: record,
        })
        return record
      } catch (error) {
        if (!generationConflict(error)) throw error
      }
    }
    throw new GeoResearchError('PROJECT_GENERATION_CONFLICT', 'TestSpec candidate could not acquire a current project generation')
  }

  async submitFormalRun(
    execution: ToolExecution,
    expectedGeneration: number,
    value: unknown,
  ): Promise<{ readonly run: RunRecord }> {
    const agent = exactAgent(execution, 'formal_run_submit')
    this.host.authorizeExecution(agent, 'formal')
    positiveInteger(expectedGeneration, 'expectedGeneration')
    const plan = this.parseFormalPlan(value)
    const resolved = await this.projects.resolveAgent(agent)
    const operation = 'formal_run_submit'
    const operationKey = operationKeyFor(operationIdentity(execution, resolved.stateFile.projectId, operation))
    const request = { expectedGeneration, plan } as unknown as JsonValue
    const requestDigest = requestDigestFor(operation, request)
    return this.projects.executeOperation(
      resolved.stateFile.projectId,
      operationKey,
      requestDigest,
      operation,
      async () => {
        const project = await this.projects.loadProject(resolved.stateFile.projectId)
        const reproductionPlan = Object.values(project.state.reproductionPlans ?? {})
          .find(candidate => candidate.digest === plan.experimentSpecDigest)
        const experimentSpec = Object.values(project.state.experimentSpecs ?? {})
          .find(candidate => candidate.digest === plan.experimentSpecDigest && candidate.status === 'frozen')
        if (reproductionPlan === undefined && experimentSpec === undefined) {
          throw new GeoResearchError(
            'RUN_PLAN_INVALID',
            'formal Run must reference a current ReproductionPlan or frozen ExperimentSpec',
          )
        }
        if (reproductionPlan !== undefined) {
          if (reproductionPlan.workspaceId !== resolved.binding.workspaceId
            || reproductionPlan.workspaceBindingVersion !== resolved.binding.bindingVersion
            || !Object.values(project.state.repositoryAudits ?? {}).some(audit => (
              audit.sourceId === reproductionPlan.sourceId
              && audit.workspaceId === reproductionPlan.workspaceId
              && audit.workspaceBindingVersion === reproductionPlan.workspaceBindingVersion
              && audit.sourceTreeDigest === plan.sourceTreeDigest
            ))) {
            throw new GeoResearchError('RUN_PLAN_INVALID', 'formal Run differs from its current ReproductionPlan binding')
          }
          await this.projects.verifyRunInputDigests(resolved.stateFile.projectId, plan.datasetDigests)
        } else if (experimentSpec !== undefined) {
          this.assertExperimentPlan(project.state, resolved, plan, experimentSpec)
          const assetDigests = experimentSpec.datasets.flatMap(reference => {
            const manifest = project.state.datasetManifests?.[reference.datasetId]
            return manifest?.assetRefs.map(artifact => artifact.digest) ?? []
          })
          await this.projects.verifyRunInputDigests(resolved.stateFile.projectId, [...new Set(assetDigests)])
        }
        await this.assertSourceTree(
          resolved,
          plan.sourceTreeDigest,
          'RUN_PLAN_INVALID',
          execution.signal,
        )
        const confined = this.confine(plan.argv, agent)
        await this.assertSourceTree(resolved, plan.sourceTreeDigest, 'RUN_PLAN_INVALID')
        const starting = this.formalStartingRecord(
          plan,
          resolved,
          operationKey,
          confined,
        )
        await this.commitInitial(starting, expectedGeneration, operationKey, requestDigest)
        const running = await this.launch(starting, confined.argv, plan.environment, false)
        return { run: running } as unknown as JsonValue
      },
      {
        recover: async () => ({
          run: await this.reconcileKnownRun(resolved.stateFile.projectId, plan.runId),
        }) as unknown as JsonValue,
      },
    ) as unknown as Promise<{ readonly run: RunRecord }>
  }

  async runLocalTest(execution: ToolExecution, testSpecId: string): Promise<{ readonly run: RunRecord }> {
    const agent = exactAgent(execution, 'local_test_run')
    this.host.authorizeExecution(agent, 'local-test')
    const resolved = await this.projects.resolveAgent(agent)
    const dynamic = resolved.stateFile.state.reproductionTestSpecs?.[testSpecId]
    if (dynamic !== undefined && (dynamic.workspaceId !== resolved.binding.workspaceId
      || dynamic.workspaceBindingVersion !== resolved.binding.bindingVersion)) {
      throw new GeoResearchError('TEST_SPEC_INVALID', `TestSpec ${testSpecId} belongs to another workspace binding`)
    }
    const spec = dynamic?.spec ?? this.testSpecs.get(testSpecId)
    if (spec === undefined) throw new GeoResearchError('TEST_SPEC_INVALID', `TestSpec ${testSpecId} is not Host-registered`)
    const operation = 'local_test_run'
    const operationKey = operationKeyFor(operationIdentity(execution, resolved.stateFile.projectId, operation))
    const request = {
      testSpecId,
      specDigest: dynamic?.specDigest ?? digestJson(spec),
      sourceTreeDigest: dynamic?.sourceTreeDigest ?? null,
    } as unknown as JsonValue
    const requestDigest = requestDigestFor(operation, request)
    return this.projects.executeOperation(
      resolved.stateFile.projectId,
      operationKey,
      requestDigest,
      operation,
      async () => {
        const cwd = await testWorkingDirectory(resolved, spec)
        const confined = this.confine(spec.argv, agent)
        if (dynamic !== undefined) {
          await this.assertSourceTree(
            resolved,
            dynamic.sourceTreeDigest,
            'TEST_SPEC_INVALID',
            execution.signal,
          )
        }
        const starting = this.localStartingRecord(spec, dynamic, resolved, cwd, operationKey, confined)
        await this.commitInitialWithRetry(starting, operationKey, requestDigest)
        const terminal = await this.launch(starting, confined.argv, spec.environment, true, execution.signal)
        return { run: terminal } as unknown as JsonValue
      },
      {
        recover: async () => ({
          run: await this.reconcileKnownRun(
            resolved.stateFile.projectId,
            deterministicId('local', operationKey),
          ),
        }) as unknown as JsonValue,
      },
    ) as unknown as Promise<{ readonly run: RunRecord }>
  }

  async status(agent: Agent, runId: string): Promise<RunRecord> {
    assertId(runId, 'runId')
    const resolved = await this.projects.resolveAgent(agent)
    const state = await this.projects.loadProject(resolved.stateFile.projectId)
    const record = state.state.runs[runId]
    if (record === undefined) throw new GeoResearchError('RUN_NOT_FOUND', `run ${runId} does not exist`)
    if (terminal(record) || this.pending.has(runKey(record.projectId, record.runId))) return record
    return this.reconcileRecord(record)
  }

  async readRecord(agent: Agent, runId: string): Promise<RunRecord> {
    assertId(runId, 'runId')
    const resolved = await this.projects.resolveAgent(agent)
    const state = await this.projects.loadProject(resolved.stateFile.projectId)
    const record = state.state.runs[runId]
    if (record === undefined) throw new GeoResearchError('RUN_NOT_FOUND', `run ${runId} does not exist`)
    return record
  }

  async cancelRun(execution: ToolExecution, runId: string): Promise<RunRecord> {
    const agent = exactAgent(execution, 'run_cancel')
    this.host.authorizeExecution(agent, 'formal')
    const resolved = await this.projects.resolveAgent(agent)
    const state = await this.projects.loadProject(resolved.stateFile.projectId)
    const record = state.state.runs[runId]
    if (record === undefined) throw new GeoResearchError('RUN_NOT_FOUND', `run ${runId} does not exist`)
    if (terminal(record)) return record
    await this.supervisor.cancel(
      this.home,
      record.projectId,
      record.runId,
      record.resourceLimits.graceMs,
      'cancelled',
    )
    const pending = this.pending.get(runKey(record.projectId, record.runId))
    if (pending !== undefined) return pending
    return this.reconcileRecord(record)
  }

  async reconcileAll(): Promise<void> {
    const projects = await this.projects.listProjectStates()
    for (const project of projects) {
      await this.projects.recoverProject(project.projectId)
      const current = await this.projects.loadProject(project.projectId)
      for (const record of Object.values(current.state.runs)) {
        if (!terminal(record)) await this.reconcileRecord(record)
      }
    }
  }

  waitForRun(projectId: string, runId: string): Promise<RunRecord> | undefined {
    return this.pending.get(runKey(projectId, runId))
  }

  private parseFormalPlan(value: unknown): FormalRunPlan {
    try {
      const plan = parseFormalRunPlan(value, this.maxFormalTimeoutMs, this.maxFormalOutputBytes)
      const environment = validateEnvironment(
        plan.environment,
        this.allowedFormalEnvironmentKeys,
        'FormalRunPlan.environment',
      )
      if (digestJson(environment) !== plan.environmentDigest) {
        throw new GeoResearchError('RUN_PLAN_INVALID', 'FormalRunPlan.environmentDigest does not match environment')
      }
      return { ...plan, environment }
    } catch (error) {
      if (error instanceof GeoResearchError && error.code === 'RUN_PLAN_INVALID') throw error
      throw new GeoResearchError('RUN_PLAN_INVALID', errorMessage(error), { cause: error })
    }
  }

  private confine(argv: readonly string[], agent: Agent): ConfinedRun {
    try {
      const confined = this.host.confine(argv, agent)
      if (confined.argv.length === 0) throw new Error('sandbox returned an empty argv')
      if (confined.mode === 'danger-full-access' && confined.enforcement !== undefined) {
        throw new Error('danger-full-access cannot report sandbox enforcement')
      }
      return confined.mode === 'danger-full-access'
        ? { argv: [...confined.argv], mode: confined.mode }
        : { argv: [...confined.argv], mode: confined.mode, enforcement: confined.enforcement }
    } catch (error) {
      throw new GeoResearchError('RUN_SANDBOX_UNAVAILABLE', `sandbox confinement failed: ${errorMessage(error)}`, { cause: error })
    }
  }

  private async assertSourceTree(
    resolved: ResolvedProject,
    expectedDigest: Sha256Digest,
    code: 'RUN_PLAN_INVALID' | 'TEST_SPEC_INVALID',
    signal?: AbortSignal,
  ): Promise<void> {
    const inspector = this.sourceTreeInspector
    if (inspector === undefined) {
      throw new GeoResearchError(code, 'repository source-tree attestation is unavailable')
    }
    const actualDigest = await inspector(resolved.workspace.canonicalPath, signal)
    if (!isSha256Digest(actualDigest)) {
      throw new GeoResearchError(code, 'repository source-tree attestation returned an invalid digest')
    }
    if (actualDigest !== expectedDigest) {
      throw new GeoResearchError(
        code,
        `workspace source tree ${actualDigest} differs from the audited digest ${expectedDigest}`,
      )
    }
  }

  private formalStartingRecord(
    plan: FormalRunPlan,
    resolved: ResolvedProject,
    operationKey: Sha256Digest,
    confined: ConfinedRun,
  ): RunRecord {
    return {
      schemaVersion: 1,
      runId: plan.runId,
      kind: 'formal',
      projectId: resolved.stateFile.projectId,
      workspaceId: resolved.binding.workspaceId,
      workspaceBindingVersion: resolved.binding.bindingVersion,
      experimentSpecDigest: plan.experimentSpecDigest,
      sourceTreeDigest: plan.sourceTreeDigest,
      environmentDigest: plan.environmentDigest,
      datasetDigests: [...plan.datasetDigests],
      seed: plan.seed,
      argv: [...plan.argv],
      argvDigest: plan.argvDigest,
      cwd: workspaceIdentity(resolved),
      state: 'starting',
      launchId: deterministicId('launch', operationKey),
      resourceLimits: { ...plan.resourceLimits },
      stdoutPath: `runs/${plan.runId}/stdout.log`,
      stderrPath: `runs/${plan.runId}/stderr.log`,
      sandbox: sandboxRecord(confined),
      outputArtifactRefs: [],
    }
  }

  private assertExperimentPlan(
    state: Awaited<ReturnType<RunProjectPort['loadProject']>>['state'],
    resolved: ResolvedProject,
    plan: FormalRunPlan,
    experimentSpec: NonNullable<Awaited<ReturnType<RunProjectPort['loadProject']>>['state']['experimentSpecs']>[string],
  ): void {
    if (experimentSpec.workspaceId !== resolved.binding.workspaceId
      || experimentSpec.workspaceBindingVersion !== resolved.binding.bindingVersion
      || experimentSpec.sourceTreeDigest !== plan.sourceTreeDigest) {
      throw new GeoResearchError('RUN_PLAN_INVALID', 'formal Run differs from its frozen ExperimentSpec binding')
    }
    if (!sameDigestSet(plan.datasetDigests, experimentSpec.datasets.map(reference => reference.datasetDigest))) {
      throw new GeoResearchError('RUN_PLAN_INVALID', 'formal Run dataset digests differ from the frozen ExperimentSpec')
    }
    if (!experimentSpec.seeds.includes(plan.seed)) {
      throw new GeoResearchError('RUN_PLAN_INVALID', `formal Run seed ${plan.seed} is not declared by the frozen ExperimentSpec`)
    }
    for (const reference of experimentSpec.datasets) {
      const manifest = state.datasetManifests?.[reference.datasetId]
      if (manifest === undefined || manifest.digest !== reference.datasetDigest || manifest.status !== 'verified') {
        throw new GeoResearchError('RUN_PLAN_INVALID', `dataset ${reference.datasetId} is not the verified frozen manifest`)
      }
    }
  }

  private localStartingRecord(
    spec: TestSpec,
    dynamic: ReproductionTestSpecRecord | undefined,
    resolved: ResolvedProject,
    cwd: RunRecord['cwd'],
    operationKey: Sha256Digest,
    confined: ConfinedRun,
  ): RunRecord {
    const runId = deterministicId('local', operationKey)
    const resourceLimits: RunResourceLimits = {
      timeoutMs: spec.timeoutMs,
      graceMs: spec.graceMs,
      stdoutMaxBytes: this.localTestOutputMaxBytes,
      stderrMaxBytes: this.localTestOutputMaxBytes,
    }
    return {
      schemaVersion: 1,
      runId,
      kind: 'local-test',
      projectId: resolved.stateFile.projectId,
      workspaceId: resolved.binding.workspaceId,
      workspaceBindingVersion: resolved.binding.bindingVersion,
      experimentSpecDigest: dynamic?.specDigest ?? digestJson(spec),
      sourceTreeDigest: dynamic?.sourceTreeDigest ?? digestJson({
          domain: 'georesearch.local-test-source/v1',
          workspaceId: resolved.binding.workspaceId,
          bindingVersion: resolved.binding.bindingVersion,
          identity: workspaceIdentity(resolved),
        }),
      environmentDigest: digestJson(spec.environment),
      datasetDigests: [],
      argv: [...spec.argv],
      argvDigest: digestJson(spec.argv),
      cwd,
      state: 'starting',
      launchId: deterministicId('launch', operationKey),
      resourceLimits,
      stdoutPath: `runs/${runId}/stdout.log`,
      stderrPath: `runs/${runId}/stderr.log`,
      sandbox: sandboxRecord(confined),
      outputArtifactRefs: [],
    }
  }

  private async commitInitial(
    record: RunRecord,
    expectedGeneration: number,
    operationKey: Sha256Digest,
    requestDigest: Sha256Digest,
  ): Promise<void> {
    await this.projects.commitRunRecord(record.projectId, {
      expectedGeneration,
      operationKey,
      requestDigest,
      run: record,
      initial: true,
    })
    await this.persist(record)
  }

  private async commitInitialWithRetry(
    record: RunRecord,
    operationKey: Sha256Digest,
    requestDigest: Sha256Digest,
  ): Promise<void> {
    for (let attempt = 0; attempt < TRANSITION_RETRIES; attempt += 1) {
      const current = await this.projects.loadProject(record.projectId)
      try {
        await this.projects.commitRunRecord(record.projectId, {
          expectedGeneration: current.generation,
          operationKey,
          requestDigest,
          run: record,
          initial: true,
        })
        await this.persist(record)
        return
      } catch (error) {
        if (!generationConflict(error) || attempt === TRANSITION_RETRIES - 1) throw error
      }
    }
  }

  private async launch(
    starting: RunRecord,
    confinedArgv: readonly string[],
    environment: Readonly<Record<string, string>>,
    wait: boolean,
    callerSignal?: AbortSignal,
  ): Promise<RunRecord> {
    let launch: SupervisorLaunch
    try {
      launch = await this.supervisor.launch({
        home: this.home,
        projectId: starting.projectId,
        run: starting,
        confinedArgv,
        environment,
        graceMs: starting.resourceLimits.graceMs,
        stdoutMaxBytes: starting.resourceLimits.stdoutMaxBytes,
        stderrMaxBytes: starting.resourceLimits.stderrMaxBytes,
      })
    } catch (error) {
      await this.failLaunch(starting, error)
      throw error
    }
    const running = await this.transition(starting.projectId, starting.runId, 'running', current => ({
      ...current,
      state: 'running',
      pid: launch.receipt.pid,
      processCreationTime: launch.receipt.processCreationTime,
      supervisorReceiptDigest: launch.receipt.digest,
      startedAt: launch.receipt.createdAt,
    }))
    if (terminal(running)) return running
    const tracked = this.trackCompletion(running, launch.completion, callerSignal)
    return wait ? tracked : running
  }

  private trackCompletion(
    running: RunRecord,
    completion: Promise<SupervisorCompletion>,
    callerSignal?: AbortSignal,
  ): Promise<RunRecord> {
    const key = runKey(running.projectId, running.runId)
    const timeout = setTimeout(() => {
      void this.supervisor.cancel(
        this.home,
        running.projectId,
        running.runId,
        running.resourceLimits.graceMs,
        'timeout',
      )
    }, running.resourceLimits.timeoutMs)
    timeout.unref()
    const onAbort = () => {
      void this.supervisor.cancel(
        this.home,
        running.projectId,
        running.runId,
        running.resourceLimits.graceMs,
        'cancelled',
      )
    }
    callerSignal?.addEventListener('abort', onAbort, { once: true })
    if (callerSignal?.aborted) onAbort()
    const tracked = this.finalize(running, completion)
      .catch(error => this.markRecoveryRequired(running, error))
      .finally(() => {
        clearTimeout(timeout)
        callerSignal?.removeEventListener('abort', onAbort)
        this.pending.delete(key)
      })
    this.pending.set(key, tracked)
    void tracked.catch(() => undefined)
    return tracked
  }

  private async finalize(running: RunRecord, completionPromise: Promise<SupervisorCompletion>): Promise<RunRecord> {
    const completion = await completionPromise
    const collecting = await this.transition(running.projectId, running.runId, 'collecting', current => ({
      ...current,
      state: 'collecting',
      endedAt: completion.marker.endedAt,
      exitCode: completion.marker.exitCode,
    }))
    if (terminal(collecting)) return collecting
    const classification = completionFailure(completion)
    const state = completion.terminationReason === 'cancelled'
      ? 'cancelled'
      : classification === undefined
        ? 'succeeded'
        : 'failed'
    return this.transition(collecting.projectId, collecting.runId, state, current => ({
      ...current,
      state,
      ...(classification === undefined ? {} : { failureClassification: classification }),
    }))
  }

  private async failLaunch(starting: RunRecord, error: unknown): Promise<RunRecord> {
    const failure = failureRecord('RUN_LAUNCH_FAILED', errorMessage(error), false)
    const collecting = await this.transition(starting.projectId, starting.runId, 'collecting', current => ({
      ...current,
      state: 'collecting',
      endedAt: this.clock(),
      exitCode: null,
      failureClassification: failure,
    }))
    if (terminal(collecting)) return collecting
    return this.transition(collecting.projectId, collecting.runId, 'failed', current => ({
      ...current,
      state: 'failed',
      failureClassification: failure,
    }))
  }

  private async markRecoveryRequired(record: RunRecord, error: unknown): Promise<RunRecord> {
    const state = await this.projects.loadProject(record.projectId)
    const current = state.state.runs[record.runId]
    if (current === undefined) throw error
    if (terminal(current)) return current
    return this.transition(current.projectId, current.runId, 'recovery-required', value => ({
      ...value,
      state: 'recovery-required',
      failureClassification: failureRecord('RUN_RECONCILIATION_REQUIRED', errorMessage(error), true),
    }))
  }

  private async reconcileKnownRun(projectId: string, runId: string): Promise<RunRecord> {
    const state = await this.projects.loadProject(projectId)
    const record = state.state.runs[runId]
    if (record === undefined) {
      throw new GeoResearchError('RUN_RECONCILIATION_REQUIRED', `operation has no persisted run ${runId}`)
    }
    return terminal(record) ? record : this.reconcileRecord(record)
  }

  private async reconcileRecord(record: RunRecord): Promise<RunRecord> {
    const reconciliation = await this.supervisor.reconcile(this.home, record.projectId, record.runId)
    switch (reconciliation.state) {
      case 'running': {
        if (record.state !== 'starting') return record
        return this.transition(record.projectId, record.runId, 'running', current => ({
          ...current,
          state: 'running',
          pid: reconciliation.receipt.pid,
          processCreationTime: reconciliation.receipt.processCreationTime,
          supervisorReceiptDigest: reconciliation.receipt.digest,
          startedAt: reconciliation.receipt.createdAt,
        }))
      }
      case 'terminal': {
        let current = record
        if (current.state === 'starting') {
          current = await this.transition(current.projectId, current.runId, 'running', value => ({
            ...value,
            state: 'running',
            pid: reconciliation.receipt.pid,
            processCreationTime: reconciliation.receipt.processCreationTime,
            supervisorReceiptDigest: reconciliation.receipt.digest,
            startedAt: reconciliation.receipt.createdAt,
          }))
        }
        if (terminal(current)) return current
        const collecting = current.state === 'collecting'
          ? current
          : await this.transition(current.projectId, current.runId, 'collecting', value => ({
            ...value,
            state: 'collecting',
            endedAt: reconciliation.marker.endedAt,
            exitCode: reconciliation.marker.exitCode,
          }))
        if (terminal(collecting)) return collecting
        const completion: SupervisorCompletion = {
          marker: reconciliation.marker,
          ...(reconciliation.marker.terminationReason === undefined
            ? {}
            : { terminationReason: reconciliation.marker.terminationReason }),
        }
        const classification = completionFailure(completion)
        const terminalState = reconciliation.marker.terminationReason === 'cancelled'
          ? 'cancelled'
          : classification === undefined
            ? 'succeeded'
            : 'failed'
        return this.transition(collecting.projectId, collecting.runId, terminalState, value => ({
          ...value,
          state: terminalState,
          ...(classification === undefined ? {} : { failureClassification: classification }),
        }))
      }
      case 'recovery-required':
        return this.markRecoveryRequired(record, new Error(reconciliation.reason))
    }
  }

  private async transition(
    projectId: string,
    runId: string,
    target: RunRecord['state'],
    build: (current: RunRecord) => RunRecord,
  ): Promise<RunRecord> {
    for (let attempt = 0; attempt < TRANSITION_RETRIES; attempt += 1) {
      const state = await this.projects.loadProject(projectId)
      const current = state.state.runs[runId]
      if (current === undefined) throw new GeoResearchError('RUN_NOT_FOUND', `run ${runId} does not exist`)
      if (current.state === target || terminal(current) || statePassedTarget(current.state, target)) return current
      const next = build(current)
      if (next.state !== target) throw new TypeError(`run transition builder did not produce ${target}`)
      const operationKey = digestJson({
        domain: 'georesearch.run-transition/v1',
        projectId,
        runId,
        launchId: current.launchId,
        target,
      })
      const requestDigest = digestJson(next)
      try {
        const committed = await this.projects.commitRunRecord(projectId, {
          expectedGeneration: state.generation,
          operationKey,
          requestDigest,
          run: next,
          initial: false,
        })
        const result = committed.state.runs[runId]
        if (result === undefined) throw new GeoResearchError('RUN_RECONCILIATION_REQUIRED', `run ${runId} vanished after commit`)
        await this.persist(result)
        return result
      } catch (error) {
        if (!generationConflict(error) || attempt === TRANSITION_RETRIES - 1) throw error
      }
    }
    throw new GeoResearchError('RUN_RECONCILIATION_REQUIRED', `run ${runId} exceeded transition retries`)
  }

  private async persist(record: RunRecord): Promise<void> {
    try {
      await this.supervisor.persistRunRecord(this.home, record.projectId, record)
    } catch (error) {
      throw new GeoResearchError('RUN_RECONCILIATION_REQUIRED', `could not persist RunRecord ${record.runId}`, { cause: error })
    }
  }
}

export class GeoResearchRunService extends Service {
  readonly coordinator: RunCoordinator

  constructor(ctx: Context, config: Config) {
    super(ctx, 'geoResearchRuns')
    const home = resolveDshHome(config.home)
    this.coordinator = new RunCoordinator({
      ...config,
      home,
      projects: ctx.geoResearchProjects,
      supervisor: new RunSupervisor(new HarnessSupervisorRuntime(ctx)),
      host: new HarnessRunHost(ctx),
    })
    // Candidate activation probes are read-only with respect to user Project state.
    if (ctx.geoResearchInstallation.maintenanceTransactionId === undefined) {
      queueMicrotask(() => {
        void this.coordinator.reconcileAll().catch(error => {
          ctx.logger.error(`GeoResearch run reconciliation failed: ${errorMessage(error)}`)
        })
      })
    }
  }

  formalRunCandidate(execution: ToolExecution, value: unknown): FormalRunCandidate {
    return this.coordinator.formalRunCandidate(execution, value)
  }

  testSpecCandidate(execution: ToolExecution, request: TestSpecCandidateRequest) {
    return this.coordinator.testSpecCandidate(execution, request)
  }

  bindSourceTreeInspector(inspector: RunSourceTreeInspector): () => void {
    return this.coordinator.bindSourceTreeInspector(inspector)
  }

  submitFormalRun(execution: ToolExecution, expectedGeneration: number, value: unknown) {
    return this.coordinator.submitFormalRun(execution, expectedGeneration, value)
  }

  runLocalTest(execution: ToolExecution, testSpecId: string) {
    return this.coordinator.runLocalTest(execution, testSpecId)
  }

  status(agent: Agent, runId: string): Promise<RunRecord> {
    return this.coordinator.status(agent, runId)
  }

  readRecord(agent: Agent, runId: string): Promise<RunRecord> {
    return this.coordinator.readRecord(agent, runId)
  }

  cancelRun(execution: ToolExecution, runId: string): Promise<RunRecord> {
    return this.coordinator.cancelRun(execution, runId)
  }

  reconcileAll(): Promise<void> {
    return this.coordinator.reconcileAll()
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  new GeoResearchRunService(ctx, config)
  for (const tool of runTools(ctx)) registerTool(ctx, tool)
}

export function runTools(ctx: Context): readonly ToolDefinition[] {
  return [
    {
      name: 'formal_run_candidate',
      description: 'Validate an exact formal execution plan for Coordinator review without launching it.',
      parameters: FORMAL_RUN_CANDIDATE_PARAMETERS,
      output: { schema: formalCandidateOutputSchema(), render: renderJson },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        const record = objectRecord(args, 'formal_run_candidate arguments')
        return ctx.geoResearchRuns.formalRunCandidate(execution, record.plan) as unknown as JsonValue
      },
    },
    {
      name: 'formal_run_submit',
      description: 'Submit one Host-validated formal run for the exact live Project workspace under the effective Harness session sandbox policy.',
      parameters: FORMAL_RUN_SUBMIT_PARAMETERS,
      output: { schema: runOutputSchema(), render: renderJson },
      async execute(args, execution) {
        const record = objectRecord(args, 'formal_run_submit arguments')
        return ctx.geoResearchRuns.submitFormalRun(
          execution,
          positiveInteger(record.expectedGeneration, 'expectedGeneration'),
          record.plan,
        ) as unknown as Promise<JsonValue>
      },
    },
    {
      name: 'run_status',
      description: 'Read and reconcile one run visible to the exact live Agent Project.',
      parameters: RUN_ID_PARAMETERS,
      output: { schema: RUN_RECORD_SCHEMA, render: renderJson },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        const record = objectRecord(args, 'run_status arguments')
        return ctx.geoResearchRuns.status(
          exactAgent(execution, 'run_status'),
          nonEmptyText(record.runId, 'runId'),
        ) as unknown as Promise<JsonValue>
      },
    },
    {
      name: 'run_cancel',
      description: 'Terminate and join one Project run under the Coordinator execution policy.',
      parameters: RUN_ID_PARAMETERS,
      output: { schema: RUN_RECORD_SCHEMA, render: renderJson },
      async execute(args, execution) {
        const record = objectRecord(args, 'run_cancel arguments')
        return ctx.geoResearchRuns.cancelRun(execution, nonEmptyText(record.runId, 'runId')) as unknown as Promise<JsonValue>
      },
    },
    {
      name: 'run_record_read',
      description: 'Read the persisted RunRecord without accepting a model-supplied Project or cwd.',
      parameters: RUN_ID_PARAMETERS,
      output: { schema: RUN_RECORD_SCHEMA, render: renderJson },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        const record = objectRecord(args, 'run_record_read arguments')
        return ctx.geoResearchRuns.readRecord(
          exactAgent(execution, 'run_record_read'),
          nonEmptyText(record.runId, 'runId'),
        ) as unknown as Promise<JsonValue>
      },
    },
    {
      name: 'local_test_run',
      description: 'Run one Host-registered TestSpec; arbitrary command strings are not accepted.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { testSpecId: { type: 'string', minLength: 1 } },
        required: ['testSpecId'],
      },
      output: { schema: runOutputSchema(), render: renderJson },
      async execute(args, execution) {
        const record = objectRecord(args, 'local_test_run arguments')
        return ctx.geoResearchRuns.runLocalTest(
          execution,
          nonEmptyText(record.testSpecId, 'testSpecId'),
        ) as unknown as Promise<JsonValue>
      },
    },
  ]
}

class HarnessSupervisorRuntime implements SupervisorRuntime {
  constructor(private readonly ctx: Context) {}

  spawn(spec: SupervisorSpawnSpec): SupervisorProcessHandle {
    const stdoutMemory = Math.min(spec.stdoutMaxBytes, 1024 * 1024)
    const stderrMemory = Math.min(spec.stderrMaxBytes, 1024 * 1024)
    return spawnSubprocess(this.ctx, {
      argv: spec.argv,
      cwd: spec.cwd,
      env: { ...spec.env },
      graceMs: spec.graceMs,
      signal: spec.signal,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: stdoutMemory, spill: { maxBytes: spec.stdoutMaxBytes } },
        stderr: { maxBytes: stderrMemory, spill: { maxBytes: spec.stderrMaxBytes } },
      },
    })
  }
}

class HarnessRunHost implements RunHostPort {
  constructor(private readonly ctx: Context) {}

  authorizeExecution(agent: Agent, kind: RunKind): void {
    this.ctx.geoResearchPolicy.authorizeExecution(agent, kind)
  }

  requireActor(agent: Agent, actor: GeoResearchActor): void {
    this.ctx.geoResearchInstallation.assertCurrent()
    const actual = this.ctx.geoResearchPolicy.actorFor(agent)
    if (actual !== actor) {
      throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', `${actor} operation is not authorized for ${actual ?? 'an unbound actor'}`)
    }
  }

  confine(argv: readonly string[], agent: Agent): ConfinedRun {
    return confineRunArgv(this.ctx, argv, agent)
  }
}

export function confineRunArgv(ctx: Context, argv: readonly string[], agent: Agent): ConfinedRun {
  const policy = resolveAgentSandboxPolicy(ctx, agent)
  if (policy.mode === 'danger-full-access') {
    return { argv: [...argv], mode: policy.mode }
  }
  const confined = confineArgv(ctx, argv, policy.workspaceRoot, policy.mode, agent)
  return { argv: confined.argv, mode: policy.mode, enforcement: confined.enforcement }
}

const FORMAL_RUN_PLAN_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    runId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
    argv: { type: 'array', minItems: 1, items: { type: 'string' } },
    argvDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
    experimentSpecDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
    sourceTreeDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
    environmentDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
    datasetDigests: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
    },
    seed: { type: 'integer', minimum: 0 },
    resourceLimits: {
      type: 'object',
      additionalProperties: false,
      properties: {
        timeoutMs: { type: 'integer', minimum: 1 },
        graceMs: { type: 'integer', minimum: 1 },
        stdoutMaxBytes: { type: 'integer', minimum: 1 },
        stderrMaxBytes: { type: 'integer', minimum: 1 },
      },
      required: ['timeoutMs', 'graceMs', 'stdoutMaxBytes', 'stderrMaxBytes'],
    },
    environment: { type: 'object', additionalProperties: { type: 'string' } },
  },
  required: [
    'schemaVersion', 'runId', 'argv', 'argvDigest', 'experimentSpecDigest',
    'sourceTreeDigest', 'environmentDigest', 'datasetDigests', 'seed', 'resourceLimits',
    'environment',
  ],
})

const FORMAL_RUN_CANDIDATE_PARAMETERS: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: { plan: FORMAL_RUN_PLAN_SCHEMA },
  required: ['plan'],
})

const FORMAL_RUN_SUBMIT_PARAMETERS: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    expectedGeneration: { type: 'integer', minimum: 1 },
    plan: FORMAL_RUN_PLAN_SCHEMA,
  },
  required: ['expectedGeneration', 'plan'],
})

const RUN_ID_PARAMETERS: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: { runId: { type: 'string', minLength: 1 } },
  required: ['runId'],
})

function runOutputSchema(): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: { run: RUN_RECORD_SCHEMA },
    required: ['run'],
  }
}

function formalCandidateOutputSchema(): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      candidateDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
      plan: FORMAL_RUN_PLAN_SCHEMA,
    },
    required: ['candidateDigest', 'plan'],
  }
}

function parseFormalRunPlan(value: unknown, maxTimeoutMs: number, maxOutputBytes: number): FormalRunPlan {
  const record = exactRecord(value, 'FormalRunPlan', [
    'schemaVersion', 'runId', 'argv', 'argvDigest', 'experimentSpecDigest',
    'sourceTreeDigest', 'environmentDigest', 'datasetDigests', 'seed', 'resourceLimits',
    'environment',
  ])
  if (record.schemaVersion !== 1) throw new GeoResearchError('RUN_PLAN_INVALID', 'FormalRunPlan.schemaVersion must be 1')
  const runId = nonEmptyText(record.runId, 'FormalRunPlan.runId')
  assertId(runId, 'FormalRunPlan.runId')
  const argv = argvValue(record.argv, 'FormalRunPlan.argv')
  const argvDigest = digestValue(record.argvDigest, 'FormalRunPlan.argvDigest')
  if (digestJson(argv) !== argvDigest) throw new GeoResearchError('RUN_PLAN_INVALID', 'FormalRunPlan.argvDigest does not match argv')
  const datasetDigests = digestArray(record.datasetDigests, 'FormalRunPlan.datasetDigests')
  if (new Set(datasetDigests).size !== datasetDigests.length) {
    throw new GeoResearchError('RUN_PLAN_INVALID', 'FormalRunPlan.datasetDigests must be unique')
  }
  const limits = exactRecord(record.resourceLimits, 'FormalRunPlan.resourceLimits', [
    'timeoutMs', 'graceMs', 'stdoutMaxBytes', 'stderrMaxBytes',
  ])
  return {
    schemaVersion: 1,
    runId,
    argv,
    argvDigest,
    experimentSpecDigest: digestValue(record.experimentSpecDigest, 'FormalRunPlan.experimentSpecDigest'),
    sourceTreeDigest: digestValue(record.sourceTreeDigest, 'FormalRunPlan.sourceTreeDigest'),
    environmentDigest: digestValue(record.environmentDigest, 'FormalRunPlan.environmentDigest'),
    datasetDigests,
    seed: nonNegativeInteger(record.seed, 'FormalRunPlan.seed'),
    resourceLimits: {
      timeoutMs: positiveBoundedInteger(limits.timeoutMs, 'FormalRunPlan.resourceLimits.timeoutMs', maxTimeoutMs),
      graceMs: positiveBoundedInteger(limits.graceMs, 'FormalRunPlan.resourceLimits.graceMs', 10 * 60 * 1_000),
      stdoutMaxBytes: positiveBoundedInteger(limits.stdoutMaxBytes, 'FormalRunPlan.resourceLimits.stdoutMaxBytes', maxOutputBytes),
      stderrMaxBytes: positiveBoundedInteger(limits.stderrMaxBytes, 'FormalRunPlan.resourceLimits.stderrMaxBytes', maxOutputBytes),
    },
    environment: environmentRecord(record.environment, 'FormalRunPlan.environment'),
  }
}

function parseTestSpec(value: unknown, allowSmoke = true): TestSpec {
  const record = exactRecord(value, 'TestSpec', [
    'schemaVersion', 'testSpecId', 'runner', 'argv', 'cwdRelative', 'timeoutMs', 'graceMs', 'environment',
  ])
  if (record.schemaVersion !== 1) throw new GeoResearchError('TEST_SPEC_INVALID', 'TestSpec.schemaVersion must be 1')
  const testSpecId = nonEmptyText(record.testSpecId, 'TestSpec.testSpecId')
  assertId(testSpecId, 'TestSpec.testSpecId')
  const runner = runnerValue(record.runner)
  if (runner === 'smoke' && !allowSmoke) {
    throw new GeoResearchError('TEST_SPEC_INVALID', 'dynamic TestSpec candidates cannot register smoke entrypoints')
  }
  const argv = argvValue(record.argv, 'TestSpec.argv')
  validateTestRunner(runner, argv)
  const cwdRelative = nonEmptyText(record.cwdRelative, 'TestSpec.cwdRelative')
  if (cwdRelative.includes('\0') || isAbsolute(cwdRelative) || escapesRelativePath(cwdRelative)) {
    throw new GeoResearchError('TEST_SPEC_INVALID', 'TestSpec.cwdRelative must remain inside the workspace')
  }
  return {
    schemaVersion: 1,
    testSpecId,
    runner,
    argv,
    cwdRelative,
    timeoutMs: positiveBoundedInteger(record.timeoutMs, 'TestSpec.timeoutMs', 30 * 60 * 1_000),
    graceMs: positiveBoundedInteger(record.graceMs, 'TestSpec.graceMs', 10 * 60 * 1_000),
    environment: validateEnvironment(
      environmentRecord(record.environment, 'TestSpec.environment'),
      undefined,
      'TestSpec.environment',
    ),
  }
}

function validateTestRunner(runner: TestRunnerKind, argv: readonly string[]): void {
  const executable = executableName(argv[0] as string)
  if (FORBIDDEN_LOCAL_EXECUTABLES.has(executable)) {
    throw new GeoResearchError('TEST_SPEC_INVALID', `TestSpec executable ${executable} is forbidden`)
  }
  if (argv.some(argument => argument.includes('\n') || argument.includes('\r') || SHELL_OPERATOR.test(argument))) {
    throw new GeoResearchError('TEST_SPEC_INVALID', 'TestSpec argv contains a shell or redirection operator')
  }
  if (executable === 'python' && argv[1] === '-c') {
    throw new GeoResearchError('TEST_SPEC_INVALID', 'python -c is not an allowed TestSpec entrypoint')
  }
  switch (runner) {
    case 'package-script':
      if ((executable !== 'pnpm' && executable !== 'npm') || argv[1] !== 'run' || !safeScriptName(argv[2])) {
        throw new GeoResearchError('TEST_SPEC_INVALID', 'package-script requires pnpm/npm run <registered-script>')
      }
      return
    case 'pytest':
      if (executable === 'pytest') return
      if (executable === 'python' && argv[1] === '-m' && argv[2] === 'pytest') return
      throw new GeoResearchError('TEST_SPEC_INVALID', 'pytest TestSpec requires pytest or python -m pytest')
    case 'vitest':
    case 'jest':
    case 'tsc':
    case 'eslint':
    case 'ruff':
    case 'mypy':
      if (executable !== runner) throw new GeoResearchError('TEST_SPEC_INVALID', `${runner} TestSpec executable must be ${runner}`)
      return
    case 'smoke':
      return
  }
}

async function testWorkingDirectory(resolved: ResolvedProject, spec: TestSpec): Promise<RunRecord['cwd']> {
  const lexical = resolve(resolved.workspace.canonicalPath, spec.cwdRelative)
  if (!containedPath(resolved.workspace.canonicalPath, lexical)) {
    throw new GeoResearchError('TEST_SPEC_INVALID', 'TestSpec cwd escapes the workspace')
  }
  let identity
  try {
    identity = await canonicalDirectoryIdentity(lexical)
  } catch (error) {
    throw new GeoResearchError('TEST_SPEC_INVALID', `TestSpec cwd is unavailable: ${errorMessage(error)}`, { cause: error })
  }
  if (!containedPath(resolved.workspace.canonicalPath, identity.canonicalPath)) {
    throw new GeoResearchError('TEST_SPEC_INVALID', 'TestSpec cwd resolves outside the workspace')
  }
  return identity
}

function sameDigestSet(left: readonly Sha256Digest[], right: readonly Sha256Digest[]): boolean {
  if (left.length !== right.length) return false
  const expected = new Set(right)
  return left.every(digest => expected.has(digest))
}

function sandboxRecord(confined: ConfinedRun): RunRecord['sandbox'] {
  return confined.mode === 'danger-full-access'
    ? { mode: confined.mode }
    : { mode: confined.mode, enforcement: confined.enforcement }
}

function completionFailure(completion: SupervisorCompletion): RunRecord['failureClassification'] | undefined {
  if (completion.terminationReason === 'cancelled') return undefined
  if (completion.terminationReason === 'timeout') {
    return failureRecord('RUN_TIMEOUT', 'run exceeded its registered timeout', true)
  }
  if (completion.spawnError !== undefined) {
    return failureRecord('RUN_LAUNCH_FAILED', completion.spawnError, true)
  }
  if (completion.marker.exitCode !== 0) {
    return failureRecord(
      'RUN_EXIT_NONZERO',
      `process exited with code ${String(completion.marker.exitCode)}${completion.marker.signal === null ? '' : ` (${completion.marker.signal})`}`,
      false,
    )
  }
  return undefined
}

function failureRecord(code: string, message: string, retryable: boolean): NonNullable<RunRecord['failureClassification']> {
  return { code, message, retryable }
}

function workspaceIdentity(resolved: ResolvedProject): RunRecord['cwd'] {
  return {
    canonicalPath: resolved.workspace.canonicalPath,
    volumeIdentity: resolved.workspace.volumeIdentity,
    fileIdentity: resolved.workspace.directoryFileIdentity,
  }
}

function terminal(record: RunRecord): boolean {
  return record.state === 'succeeded'
    || record.state === 'failed'
    || record.state === 'cancelled'
    || record.state === 'recovery-required'
}

function statePassedTarget(current: RunRecord['state'], target: RunRecord['state']): boolean {
  const rank: Record<RunRecord['state'], number> = {
    starting: 0,
    running: 1,
    collecting: 2,
    succeeded: 3,
    failed: 3,
    cancelled: 3,
    'recovery-required': 3,
  }
  return rank[current] > rank[target]
}

function deterministicId(prefix: string, digest: Sha256Digest): string {
  return `${prefix}-${digest.slice('sha256:'.length, 'sha256:'.length + 40)}`
}

function runKey(projectId: string, runId: string): string {
  return `${projectId}\0${runId}`
}

function exactAgent(execution: Pick<ToolExecution, 'agent'>, operation: string): Agent {
  if (execution.agent === undefined) throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', `${operation} requires an exact live Agent`)
  return execution.agent
}

function exactRecord(value: unknown, field: string, allowedKeys: readonly string[]): Record<string, unknown> {
  const record = objectRecord(value, field)
  const unexpected = Object.keys(record).filter(key => !allowedKeys.includes(key))
  if (unexpected.length > 0) throw new TypeError(`${field} contains unsupported fields: ${unexpected.join(', ')}`)
  return record
}

function objectRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${field} must be an object`)
  return value as Record<string, unknown>
}

function nonEmptyText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new TypeError(`${field} must be a non-empty NUL-free string`)
  }
  return value
}

function positiveInteger(value: unknown, field: string): number {
  return positiveBoundedInteger(value, field, Number.MAX_SAFE_INTEGER)
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`)
  }
  return value as number
}

function positiveBoundedInteger(value: unknown, field: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new TypeError(`${field} must be an integer from 1 through ${maximum}`)
  }
  return value as number
}

function argvValue(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4096) throw new TypeError(`${field} must be a non-empty argv array`)
  return value.map((argument, index) => {
    if (typeof argument !== 'string' || argument.includes('\0') || argument.length > 32_768) {
      throw new TypeError(`${field}[${index}] is invalid`)
    }
    return argument
  })
}

function digestValue(value: unknown, field: string): Sha256Digest {
  if (!isSha256Digest(value)) throw new TypeError(`${field} must be a SHA-256 digest`)
  return value
}

function digestArray(value: unknown, field: string): Sha256Digest[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  return value.map((entry, index) => digestValue(entry, `${field}[${index}]`))
}

function environmentRecord(value: unknown, field: string): Record<string, string> {
  const record = objectRecord(value, field)
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => {
    if (typeof entry !== 'string' || entry.includes('\0')) throw new TypeError(`${field}.${key} must be a NUL-free string`)
    return [key, entry]
  }))
}

function validateEnvironment(
  value: Readonly<Record<string, string>>,
  allowlist: ReadonlySet<string> | undefined,
  field: string,
): Record<string, string> {
  const result: Record<string, string> = {}
  for (const key of Object.keys(value).sort()) {
    environmentKey(key, `${field} key`)
    if (SECRET_ENVIRONMENT_KEY.test(key)) throw new TypeError(`${field} may not contain credential-shaped key ${key}`)
    if (allowlist !== undefined && !allowlist.has(key)) throw new TypeError(`${field} key ${key} is not Host-allowed`)
    result[key] = value[key] as string
  }
  return result
}

function environmentKey(value: unknown, field: string): string {
  if (typeof value !== 'string' || !ENVIRONMENT_KEY.test(value)) throw new TypeError(`${field} is not a valid environment key`)
  return value
}

function runnerValue(value: unknown): TestRunnerKind {
  const runners: readonly TestRunnerKind[] = [
    'package-script', 'pytest', 'vitest', 'jest', 'tsc', 'eslint', 'ruff', 'mypy', 'smoke',
  ]
  if (typeof value !== 'string' || !runners.includes(value as TestRunnerKind)) {
    throw new GeoResearchError('TEST_SPEC_INVALID', `unsupported TestSpec runner ${String(value)}`)
  }
  return value as TestRunnerKind
}

function executableName(value: string): string {
  return basename(value).toLowerCase().replace(/\.(?:cmd|exe)$/u, '')
}

function safeScriptName(value: string | undefined): boolean {
  return value !== undefined && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(value)
}

function escapesRelativePath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/')
  return normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')
}

function containedPath(root: string, candidate: string): boolean {
  const relation = relative(resolve(root), resolve(candidate))
  return relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))
}

function generationConflict(error: unknown): boolean {
  return error instanceof GeoResearchError && error.code === 'PROJECT_GENERATION_CONFLICT'
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function renderJson(_args: unknown, value: JsonValue) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}
