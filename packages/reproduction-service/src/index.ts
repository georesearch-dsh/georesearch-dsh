import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@georesearch/dsh-installation-guard'
import type {} from '@georesearch/dsh-policy'
import type {} from '@georesearch/dsh-project-service'
import type {} from '@georesearch/dsh-run-service'
import {
  operationIdentity,
  parentSessionId,
  registerTool,
  roleOf,
  type Agent,
  type ToolDefinition,
  type ToolExecution,
} from '@georesearch/dsh-compat-rc5'
import {
  GeoResearchError,
  METHOD_CODE_DELTA_CLASSIFICATIONS,
  REPOSITORY_AUDIT_SCHEMA,
  REPRODUCTION_PLAN_BODY_SCHEMA,
  REPRODUCTION_PLAN_SCHEMA,
  REPRODUCTION_REPORT_CANDIDATE_SCHEMA,
  REPRODUCTION_TEST_SPEC_SCHEMA,
  digestJson,
  nowUtc,
  operationKeyFor,
  parseReproductionPlanBody,
  parseReproductionReportCandidate,
  reproductionReportOutcomeViolation,
  requestDigestFor,
  type EvidenceRecord,
  type JsonValue,
  type MethodCodeDelta,
  type MethodCodeDeltaClassification,
  type RepositoryAudit,
  type ReproductionBlocker,
  type ReproductionPlan,
  type ReproductionReport,
  type ReproductionReportCandidate,
  type ReproductionTestSpecRecord,
  type Sha256Digest,
} from '@georesearch/dsh-contracts'
import {
  GitRepositoryProvider,
  type GitRepositoryProviderOptions,
  type RepositoryCodeLocatorRequest,
  type RepositoryInspection,
} from '@georesearch/dsh-repository-providers'
import type {
  GeneratedArtifactCommitRequest,
  GeoResearchProjectService,
  RepositoryAuditCommitRequest,
  ReproductionPlanCommitRequest,
  ReproductionReportCommitRequest,
} from '@georesearch/dsh-project-service'
import type { GeoResearchRunService, TestSpecCandidateRequest } from '@georesearch/dsh-run-service'

declare module '@deepseek-ai/cordis' {
  interface Context {
    geoResearchReproduction: GeoResearchReproductionService
  }
}

export const name = 'georesearch-reproduction-service'
export const inject = [
  'geoResearchInstallation',
  'geoResearchPolicy',
  'geoResearchProjects',
  'geoResearchRuns',
  'tools',
]

const COMMIT_RETRIES = 8
const REPORT_ARTIFACT_MAX_BYTES = 1024 * 1024

export interface Config extends GitRepositoryProviderOptions {}

export interface ReproductionHostPort {
  requireExperiment(agent: Agent): void
  requireRootCoordinator(agent: Agent): void
}

export interface ReproductionCoordinatorPorts {
  readonly projects: Pick<
    GeoResearchProjectService,
    | 'resolveAgent'
    | 'loadProject'
    | 'commitRepositoryAudit'
    | 'commitReproductionPlan'
    | 'commitGeneratedArtifact'
    | 'commitReproductionReport'
  >
  readonly runs: Pick<GeoResearchRunService, 'testSpecCandidate'>
  readonly repository: GitRepositoryProvider
  readonly host: ReproductionHostPort
}

export interface MethodCodeDeltaRequest {
  readonly deltaId: string
  readonly evidenceId: string
  readonly classification: MethodCodeDeltaClassification
  readonly codeLocator?: RepositoryCodeLocatorRequest
  readonly summary: string
  readonly likelyImpact: string
  readonly limitations: readonly string[]
}

export interface RepositoryAuditRequest {
  readonly sourceId: string
  readonly targetRef?: string
  readonly methodCodeDeltas: readonly MethodCodeDeltaRequest[]
}

export class ReproductionCoordinator {
  private readonly clock: () => string

  constructor(
    private readonly ports: ReproductionCoordinatorPorts,
    now: () => string = nowUtc,
  ) {
    this.clock = now
  }

  async repositoryAudit(execution: ToolExecution, value: unknown): Promise<RepositoryAudit> {
    const agent = exactAgent(execution, 'repository_audit')
    this.ports.host.requireExperiment(agent)
    const request = parseRepositoryAuditRequest(value)
    const resolved = await this.ports.projects.resolveAgent(agent)
    const current = await this.ports.projects.loadProject(resolved.stateFile.projectId)
    const source = current.state.sources?.[request.sourceId]
    if (source === undefined) throw new GeoResearchError('SOURCE_NOT_FOUND', `source ${request.sourceId} is not registered`)
    const inspectionRequest = {
      workspaceRoot: resolved.workspace.canonicalPath,
      ...(request.targetRef === undefined ? {} : { targetRef: request.targetRef }),
      signal: execution.signal,
    }
    const initialInspection = await this.ports.repository.inspect(inspectionRequest)
    const blockers = validateRepositoryReference(source.codeRefs.map(reference => reference.url), initialInspection)
    const methodCodeDeltas = await Promise.all(request.methodCodeDeltas.map(async raw => {
      const evidence = current.state.evidence?.[raw.evidenceId]
      if (evidence === undefined || evidence.sourceId !== source.sourceId) {
        throw new GeoResearchError('REPOSITORY_AUDIT_INVALID', `method delta evidence ${raw.evidenceId} is not registered for source ${source.sourceId}`)
      }
      return await groundedDelta(this.ports.repository, initialInspection, evidence, raw, execution.signal)
    }))
    const inspection = await this.ports.repository.inspect(inspectionRequest)
    if (digestJson(inspection) !== digestJson(initialInspection)) {
      throw new GeoResearchError('REPOSITORY_AUDIT_INVALID', 'repository changed while the audit was being grounded')
    }
    const auditId = `repo-audit-${digestJson({
      domain: 'georesearch.repository-audit-id/v1',
      projectId: current.projectId,
      workspaceId: resolved.binding.workspaceId,
      sourceId: source.sourceId,
      sourceTreeDigest: inspection.sourceTreeDigest,
      targetCommit: inspection.targetCommit,
      methodCodeDeltas,
    }).slice('sha256:'.length, 'sha256:'.length + 80)}`
    const body = {
      schemaVersion: 1 as const,
      auditId,
      projectId: current.projectId,
      workspaceId: resolved.binding.workspaceId,
      workspaceBindingVersion: resolved.binding.bindingVersion,
      sourceId: source.sourceId,
      sourceDigest: source.digest,
      repository: {
        capability: inspection.capability,
        canonicalRoot: inspection.canonicalRoot,
        gitDir: inspection.gitDir,
        gitCommonDir: inspection.gitCommonDir,
        remoteUrl: inspection.remoteUrl,
        headCommit: inspection.headCommit,
        branch: inspection.branch,
        detached: inspection.detached,
        tags: inspection.tags,
        targetRef: inspection.targetRef,
        targetCommit: inspection.targetCommit,
        targetMatchesHead: inspection.targetMatchesHead,
        dirty: inspection.dirty,
        changes: inspection.changes,
      },
      sourceTreeDigest: inspection.sourceTreeDigest,
      languages: inspection.languages,
      buildSystems: inspection.buildSystems,
      entryPoints: inspection.entryPoints,
      configurationFiles: inspection.configurationFiles,
      dataDependencyPaths: inspection.dataDependencyPaths,
      environmentFiles: inspection.environmentFiles,
      testPaths: inspection.testPaths,
      methodCodeDeltas,
      blockers,
      auditedAt: this.clock(),
    }
    const repositoryAudit: RepositoryAudit = { ...body, digest: digestJson(body) }
    const operationKey = operationKeyFor(operationIdentity(execution, current.projectId, 'repository_audit'))
    const requestDigest = requestDigestFor('repository_audit', request as unknown as JsonValue)
    return await this.commitRepositoryAudit(current.projectId, operationKey, requestDigest, repositoryAudit)
  }

  async reproductionPlanCandidate(execution: ToolExecution, value: unknown): Promise<ReproductionPlan> {
    const agent = exactAgent(execution, 'reproduction_plan_candidate')
    this.ports.host.requireExperiment(agent)
    let planBody
    try {
      planBody = parseReproductionPlanBody(value)
    } catch (error) {
      throw new GeoResearchError('REPRODUCTION_PLAN_INVALID', 'ReproductionPlan candidate schema is invalid', { cause: error })
    }
    const resolved = await this.ports.projects.resolveAgent(agent)
    const current = await this.ports.projects.loadProject(resolved.stateFile.projectId)
    const audit = current.state.repositoryAudits?.[planBody.repositoryAuditId]
    if (audit === undefined || audit.sourceId !== planBody.sourceId
      || audit.workspaceId !== resolved.binding.workspaceId
      || audit.workspaceBindingVersion !== resolved.binding.bindingVersion) {
      throw new GeoResearchError('REPRODUCTION_PLAN_INVALID', 'ReproductionPlan is not bound to the current RepositoryAudit')
    }
    if (planBody.targetRepository.commit !== audit.repository.targetCommit) {
      throw new GeoResearchError('REPRODUCTION_PLAN_INVALID', 'ReproductionPlan target commit differs from RepositoryAudit')
    }
    if (!sameNullableRepositoryUrl(planBody.targetRepository.remoteUrl, audit.repository.remoteUrl)) {
      throw new GeoResearchError('REPRODUCTION_PLAN_INVALID', 'ReproductionPlan target repository differs from RepositoryAudit')
    }
    const evidence = current.state.evidence ?? {}
    for (const target of planBody.targetResults) {
      if (target.evidenceId !== null && (evidence[target.evidenceId]?.sourceId !== planBody.sourceId)) {
        throw new GeoResearchError('REPRODUCTION_PLAN_INVALID', `target result ${target.resultId} evidence is not current`)
      }
    }
    if (planBody.scope === 'exact' && (audit.repository.dirty || !audit.repository.targetMatchesHead)) {
      throw new GeoResearchError('REPRODUCTION_PLAN_INVALID', 'exact reproduction requires a clean checkout at the audited target commit')
    }
    const body = {
      ...planBody,
      projectId: current.projectId,
      workspaceId: resolved.binding.workspaceId,
      workspaceBindingVersion: resolved.binding.bindingVersion,
      repositoryAuditDigest: audit.digest,
      sourceTreeDigest: audit.sourceTreeDigest,
      status: 'candidate' as const,
      createdAt: this.clock(),
    }
    const reproductionPlan: ReproductionPlan = { ...body, digest: digestJson(body) }
    const operationKey = operationKeyFor(operationIdentity(execution, current.projectId, 'reproduction_plan_candidate'))
    const requestDigest = requestDigestFor('reproduction_plan_candidate', planBody as unknown as JsonValue)
    return await this.commitReproductionPlan(current.projectId, operationKey, requestDigest, reproductionPlan)
  }

  async testSpecCandidate(execution: ToolExecution, value: unknown): Promise<ReproductionTestSpecRecord> {
    const agent = exactAgent(execution, 'test_spec_candidate')
    this.ports.host.requireExperiment(agent)
    const request = parseTestSpecCandidateRequest(value)
    return await this.ports.runs.testSpecCandidate(execution, request)
  }

  async commitReproductionReportCandidate(
    execution: ToolExecution,
    value: unknown,
  ): Promise<ReproductionReport> {
    const agent = exactAgent(execution, 'commitReproductionReportCandidate')
    this.ports.host.requireRootCoordinator(agent)
    let candidate: ReproductionReportCandidate
    try {
      candidate = parseReproductionReportCandidate(value)
    } catch (error) {
      throw new GeoResearchError('REPRODUCTION_REPORT_INVALID', 'ReproductionReport candidate schema is invalid', { cause: error })
    }
    const resolved = await this.ports.projects.resolveAgent(agent)
    const current = await this.ports.projects.loadProject(resolved.stateFile.projectId)
    const plan = current.state.reproductionPlans?.[candidate.planId]
    const baseline = current.state.repositoryAudits?.[candidate.baselineAuditId]
    const final = current.state.repositoryAudits?.[candidate.finalAuditId]
    if (plan === undefined) throw new GeoResearchError('REPRODUCTION_PLAN_NOT_FOUND', `reproduction plan ${candidate.planId} is unknown`)
    if (plan.workspaceId !== resolved.binding.workspaceId
      || plan.workspaceBindingVersion !== resolved.binding.bindingVersion) {
      throw new GeoResearchError('REPRODUCTION_REPORT_INVALID', 'ReproductionPlan is not current for this workspace binding')
    }
    if (baseline === undefined || final === undefined
      || baseline.sourceId !== plan.sourceId || final.sourceId !== plan.sourceId
      || baseline.workspaceId !== resolved.binding.workspaceId
      || final.workspaceId !== resolved.binding.workspaceId
      || baseline.workspaceBindingVersion !== resolved.binding.bindingVersion
      || final.workspaceBindingVersion !== resolved.binding.bindingVersion) {
      throw new GeoResearchError('REPRODUCTION_REPORT_INVALID', 'ReproductionReport audits are not current for this workspace')
    }
    if (baseline.auditId !== plan.repositoryAuditId
      || baseline.digest !== plan.repositoryAuditDigest
      || baseline.sourceTreeDigest !== plan.sourceTreeDigest) {
      throw new GeoResearchError('REPRODUCTION_REPORT_INVALID', 'ReproductionReport baseline is not the audit bound to its plan')
    }
    const runs = candidate.runIds.map(runId => {
      const run = current.state.runs[runId]
      if (run === undefined) throw new GeoResearchError('REPRODUCTION_REPORT_INVALID', `run ${runId} is unknown`)
      return run
    })
    const reportedRunIds = new Set(candidate.runIds)
    for (const diagnosis of candidate.diagnostics) {
      if (diagnosis.relatedRunIds.some(runId => !reportedRunIds.has(runId))) {
        throw new GeoResearchError('REPRODUCTION_REPORT_INVALID', `diagnosis ${diagnosis.code} references an unreported run`)
      }
      if (diagnosis.relatedArtifactIds.some(artifactId => {
        const artifact = current.state.artifacts[artifactId]
        return artifact === undefined || artifact.materialization !== 'committed'
          || artifact.integrity !== 'verified' || artifact.validity !== 'current'
      })) {
        throw new GeoResearchError('REPRODUCTION_REPORT_INVALID', `diagnosis ${diagnosis.code} references a non-current Artifact`)
      }
    }
    const diagnosticArtifactDigests = [...new Set(
      candidate.diagnostics.flatMap(diagnosis => diagnosis.relatedArtifactIds),
    )].map(artifactId => {
      const artifact = current.state.artifacts[artifactId]
      if (artifact === undefined) {
        throw new GeoResearchError('REPRODUCTION_REPORT_INVALID', `diagnosis Artifact ${artifactId} is unavailable`)
      }
      return artifact.digest
    })
    const testSpecs = Object.values(current.state.reproductionTestSpecs ?? {})
      .filter(testSpec => testSpec.planId === plan.planId)
    const violation = reproductionReportOutcomeViolation(candidate, plan, baseline, final, runs, testSpecs)
    if (violation !== undefined) throw new GeoResearchError(violation.code, violation.message)
    const reportId = `reproduction-${digestJson({
      domain: 'georesearch.reproduction-report-id/v1',
      projectId: current.projectId,
      candidate,
      planDigest: plan.digest,
      baselineAuditDigest: baseline.digest,
      finalAuditDigest: final.digest,
    }).slice('sha256:'.length, 'sha256:'.length + 80)}`
    const existing = current.state.reproductionReports?.[reportId]
    if (existing !== undefined) return existing
    const committedAt = this.clock()
    const document = {
      ...candidate,
      reportId,
      projectId: current.projectId,
      workspaceId: resolved.binding.workspaceId,
      workspaceBindingVersion: resolved.binding.bindingVersion,
      planDigest: plan.digest,
      baselineAuditDigest: baseline.digest,
      finalAuditDigest: final.digest,
      committedAt,
    }
    const documentBytes = Buffer.from(`${JSON.stringify(document, undefined, 2)}\n`, 'utf8')
    if (documentBytes.byteLength > REPORT_ARTIFACT_MAX_BYTES) {
      throw new GeoResearchError('REPRODUCTION_REPORT_INVALID', 'ReproductionReport exceeds the artifact byte limit')
    }
    const generatedRequest: GeneratedArtifactCommitRequest = {
      source: singleChunk(documentBytes),
      maxBytes: REPORT_ARTIFACT_MAX_BYTES,
      kind: 'reproduction-report',
      mediaType: 'application/json',
      transformationType: 'georesearch.reproduction-report/v1',
      inputDigests: [
        plan.digest,
        baseline.digest,
        final.digest,
        ...runs.map(run => digestJson(run)),
        ...diagnosticArtifactDigests,
      ],
      signal: execution.signal,
    }
    const committedArtifact = await this.ports.projects.commitGeneratedArtifact(agent, generatedRequest)
    const body = {
      ...candidate,
      reportId,
      projectId: current.projectId,
      workspaceId: resolved.binding.workspaceId,
      workspaceBindingVersion: resolved.binding.bindingVersion,
      planDigest: plan.digest,
      baselineAuditDigest: baseline.digest,
      finalAuditDigest: final.digest,
      reportArtifact: {
        artifactId: committedArtifact.artifact.artifactId,
        digest: committedArtifact.artifact.digest,
        kind: committedArtifact.artifact.kind,
      },
      reviewStatus: 'pending' as const,
      committedAt,
    }
    const { reviewStatus: ignoredReviewStatus, ...stableBody } = body
    void ignoredReviewStatus
    const reproductionReport: ReproductionReport = { ...body, digest: digestJson(stableBody) }
    const operationKey = operationKeyFor(operationIdentity(execution, current.projectId, 'reproduction.report.commit'))
    const requestDigest = requestDigestFor('reproduction.report.commit', candidate as unknown as JsonValue)
    return await this.commitReproductionReport(current.projectId, operationKey, requestDigest, reproductionReport)
  }

  private async commitRepositoryAudit(
    projectId: string,
    operationKey: Sha256Digest,
    requestDigest: Sha256Digest,
    repositoryAudit: RepositoryAudit,
  ): Promise<RepositoryAudit> {
    for (let attempt = 0; attempt < COMMIT_RETRIES; attempt += 1) {
      const current = await this.ports.projects.loadProject(projectId)
      const existing = current.state.repositoryAudits?.[repositoryAudit.auditId]
      if (existing !== undefined) {
        if (!sameRepositoryAuditSnapshot(existing, repositoryAudit)) {
          throw new GeoResearchError('REPOSITORY_AUDIT_INVALID', `repository audit ${repositoryAudit.auditId} already differs`)
        }
        return existing
      }
      const request: RepositoryAuditCommitRequest = {
        expectedGeneration: current.generation,
        operationKey,
        requestDigest,
        repositoryAudit,
      }
      try {
        await this.ports.projects.commitRepositoryAudit(projectId, request)
        return repositoryAudit
      } catch (error) {
        if (!generationConflict(error)) throw error
      }
    }
    throw new GeoResearchError('PROJECT_GENERATION_CONFLICT', 'RepositoryAudit could not acquire a current generation')
  }

  private async commitReproductionPlan(
    projectId: string,
    operationKey: Sha256Digest,
    requestDigest: Sha256Digest,
    reproductionPlan: ReproductionPlan,
  ): Promise<ReproductionPlan> {
    for (let attempt = 0; attempt < COMMIT_RETRIES; attempt += 1) {
      const current = await this.ports.projects.loadProject(projectId)
      const existing = current.state.reproductionPlans?.[reproductionPlan.planId]
      if (existing !== undefined) {
        if (!sameReproductionPlanSnapshot(existing, reproductionPlan)) {
          throw new GeoResearchError('REPRODUCTION_PLAN_INVALID', `reproduction plan ${reproductionPlan.planId} already differs`)
        }
        return existing
      }
      const request: ReproductionPlanCommitRequest = {
        expectedGeneration: current.generation,
        operationKey,
        requestDigest,
        reproductionPlan,
      }
      try {
        await this.ports.projects.commitReproductionPlan(projectId, request)
        return reproductionPlan
      } catch (error) {
        if (!generationConflict(error)) throw error
      }
    }
    throw new GeoResearchError('PROJECT_GENERATION_CONFLICT', 'ReproductionPlan could not acquire a current generation')
  }

  private async commitReproductionReport(
    projectId: string,
    operationKey: Sha256Digest,
    requestDigest: Sha256Digest,
    reproductionReport: ReproductionReport,
  ): Promise<ReproductionReport> {
    for (let attempt = 0; attempt < COMMIT_RETRIES; attempt += 1) {
      const current = await this.ports.projects.loadProject(projectId)
      const existing = current.state.reproductionReports?.[reproductionReport.reportId]
      if (existing !== undefined) {
        if (existing.digest !== reproductionReport.digest) {
          throw new GeoResearchError('REPRODUCTION_REPORT_INVALID', `reproduction report ${reproductionReport.reportId} already differs`)
        }
        return existing
      }
      const request: ReproductionReportCommitRequest = {
        expectedGeneration: current.generation,
        operationKey,
        requestDigest,
        reproductionReport,
      }
      try {
        await this.ports.projects.commitReproductionReport(projectId, request)
        return reproductionReport
      } catch (error) {
        if (!generationConflict(error)) throw error
      }
    }
    throw new GeoResearchError('PROJECT_GENERATION_CONFLICT', 'ReproductionReport could not acquire a current generation')
  }
}

export class GeoResearchReproductionService extends Service {
  readonly coordinator: ReproductionCoordinator
  readonly repository: GitRepositoryProvider

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'geoResearchReproduction')
    this.repository = new GitRepositoryProvider(config)
    const releaseSourceTreeInspector = ctx.geoResearchRuns.bindSourceTreeInspector(
      async (workspaceRoot, signal) => (await this.repository.inspect({
        workspaceRoot,
        ...(signal === undefined ? {} : { signal }),
      })).sourceTreeDigest,
    )
    this.coordinator = new ReproductionCoordinator({
      projects: ctx.geoResearchProjects,
      runs: ctx.geoResearchRuns,
      repository: this.repository,
      host: new HarnessReproductionHost(ctx),
    })
    ctx.effect(
      () => async () => {
        releaseSourceTreeInspector()
        await this.repository.dispose()
      },
      'georesearch-reproduction-service: repository provider disposal',
    )
  }

  repositoryAudit(execution: ToolExecution, value: unknown): Promise<RepositoryAudit> {
    return this.coordinator.repositoryAudit(execution, value)
  }

  reproductionPlanCandidate(execution: ToolExecution, value: unknown): Promise<ReproductionPlan> {
    return this.coordinator.reproductionPlanCandidate(execution, value)
  }

  testSpecCandidate(execution: ToolExecution, value: unknown): Promise<ReproductionTestSpecRecord> {
    return this.coordinator.testSpecCandidate(execution, value)
  }

  commitReproductionReportCandidate(execution: ToolExecution, value: unknown): Promise<ReproductionReport> {
    return this.coordinator.commitReproductionReportCandidate(execution, value)
  }

  drain(): Promise<void> {
    return this.repository.drain()
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  ctx.geoResearchInstallation.assertCurrent()
  new GeoResearchReproductionService(ctx, config)
  for (const tool of reproductionTools(ctx)) registerTool(ctx, tool)
}

export function reproductionTools(ctx: Context): readonly ToolDefinition[] {
  return [
    {
      name: 'repository_audit',
      description: 'Audit the exact bound Git repository with fixed read-only commands and grounded paper-method/code deltas.',
      parameters: REPOSITORY_AUDIT_PARAMETERS,
      output: { schema: REPOSITORY_AUDIT_SCHEMA, render: renderJson },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        ctx.geoResearchInstallation.assertCurrent()
        return await ctx.geoResearchReproduction.repositoryAudit(execution, args)
      },
    },
    {
      name: 'reproduction_plan_candidate',
      description: 'Validate and record one immutable candidate ReproductionPlan bound to a current RepositoryAudit.',
      parameters: REPRODUCTION_PLAN_BODY_SCHEMA,
      output: { schema: REPRODUCTION_PLAN_SCHEMA, render: renderJson },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        ctx.geoResearchInstallation.assertCurrent()
        return await ctx.geoResearchReproduction.reproductionPlanCandidate(execution, args)
      },
    },
    {
      name: 'test_spec_candidate',
      description: 'Validate and Host-register one Project-bound TestSpec candidate; generic shell and dynamic smoke entrypoints are rejected.',
      parameters: TEST_SPEC_CANDIDATE_PARAMETERS,
      output: { schema: REPRODUCTION_TEST_SPEC_SCHEMA, render: renderJson },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        ctx.geoResearchInstallation.assertCurrent()
        return await ctx.geoResearchReproduction.testSpecCandidate(execution, args)
      },
    },
  ]
}

class HarnessReproductionHost implements ReproductionHostPort {
  constructor(private readonly ctx: Context) {}

  requireExperiment(agent: Agent): void {
    this.ctx.geoResearchInstallation.assertCurrent()
    if (this.ctx.geoResearchPolicy.actorFor(agent) !== 'experiment') {
      throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', 'Phase 4 candidate tools require the experiment specialist')
    }
  }

  requireRootCoordinator(agent: Agent): void {
    this.ctx.geoResearchInstallation.assertCurrent()
    if (this.ctx.geoResearchPolicy.actorFor(agent) !== 'coordinator'
      || roleOf(agent) !== undefined || parentSessionId(agent) !== undefined) {
      throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', 'only the root Coordinator may commit a ReproductionReport')
    }
  }
}

const REPOSITORY_AUDIT_PARAMETERS: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    sourceId: { type: 'string', minLength: 1 },
    targetRef: { type: 'string', minLength: 1, maxLength: 256 },
    methodCodeDeltas: {
      type: 'array',
      maxItems: 128,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          deltaId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
          evidenceId: { type: 'string', minLength: 1 },
          classification: { type: 'string', enum: METHOD_CODE_DELTA_CLASSIFICATIONS },
          codeLocator: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string', minLength: 1 },
              lineStart: { type: 'integer', minimum: 1 },
              lineEnd: { type: 'integer', minimum: 1 },
            },
            required: ['path', 'lineStart', 'lineEnd'],
          },
          summary: { type: 'string', minLength: 1 },
          likelyImpact: { type: 'string', minLength: 1 },
          limitations: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
        required: [
          'deltaId', 'evidenceId', 'classification', 'summary', 'likelyImpact', 'limitations',
        ],
      },
    },
  },
  required: ['sourceId', 'methodCodeDeltas'],
})

const TEST_SPEC_CANDIDATE_PARAMETERS: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    planId: { type: 'string', minLength: 1 },
    repositoryAuditId: { type: 'string', minLength: 1 },
    spec: {
      type: 'object',
      additionalProperties: false,
      properties: {
        schemaVersion: { const: 1 },
        testSpecId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' },
        runner: {
          type: 'string',
          enum: ['package-script', 'pytest', 'vitest', 'jest', 'tsc', 'eslint', 'ruff', 'mypy'],
        },
        argv: { type: 'array', minItems: 1, items: { type: 'string' } },
        cwdRelative: { type: 'string', minLength: 1 },
        timeoutMs: { type: 'integer', minimum: 1 },
        graceMs: { type: 'integer', minimum: 1 },
        environment: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: [
        'schemaVersion', 'testSpecId', 'runner', 'argv', 'cwdRelative',
        'timeoutMs', 'graceMs', 'environment',
      ],
    },
  },
  required: ['planId', 'repositoryAuditId', 'spec'],
})

async function groundedDelta(
  repository: GitRepositoryProvider,
  inspection: RepositoryInspection,
  evidence: EvidenceRecord,
  raw: MethodCodeDeltaRequest,
  signal?: AbortSignal,
): Promise<MethodCodeDelta> {
  const needsLocator = raw.classification === 'matches'
    || raw.classification === 'partially-matches'
    || raw.classification === 'differs'
    || raw.classification === 'not-described-in-paper'
  if (needsLocator && raw.codeLocator === undefined) {
    throw new GeoResearchError('REPOSITORY_AUDIT_INVALID', `method delta ${raw.deltaId} requires a code locator`)
  }
  const codeLocator = raw.codeLocator === undefined
    ? undefined
    : await repository.bindCodeLocator(inspection.canonicalRoot, raw.codeLocator, signal)
  return {
    deltaId: raw.deltaId,
    evidenceId: raw.evidenceId,
    paperStatement: evidence.proposition,
    classification: raw.classification,
    ...(codeLocator === undefined ? {} : { codeLocator }),
    summary: raw.summary,
    likelyImpact: raw.likelyImpact,
    limitations: [...raw.limitations],
  }
}

function validateRepositoryReference(
  registeredUrls: readonly string[],
  inspection: RepositoryInspection,
): ReproductionBlocker[] {
  const blockers: ReproductionBlocker[] = []
  if (inspection.headCommit === null) {
    blockers.push({ code: 'REPOSITORY_HEAD_UNBORN', message: 'repository has no committed HEAD', retryable: true })
  }
  if (inspection.targetCommit === null) {
    blockers.push({ code: 'REPOSITORY_TARGET_UNRESOLVED', message: 'target commit or tag could not be resolved', retryable: true })
  } else if (!inspection.targetMatchesHead) {
    blockers.push({ code: 'REPOSITORY_TARGET_NOT_CHECKED_OUT', message: 'workspace HEAD differs from the target commit', retryable: true })
  }
  if (registeredUrls.length === 0) {
    blockers.push({
      code: 'REPOSITORY_REFERENCE_UNREGISTERED',
      message: 'the SourceRecord has no registered code reference; repository identity remains locally grounded only',
      retryable: false,
    })
    return blockers
  }
  if (inspection.remoteUrl === null
    || !registeredUrls.some(url => normalizeRepositoryUrl(url) === normalizeRepositoryUrl(inspection.remoteUrl as string))) {
    throw new GeoResearchError('REPOSITORY_REFERENCE_MISMATCH', 'repository origin does not match the SourceRecord code references')
  }
  return blockers
}

function parseRepositoryAuditRequest(value: unknown): RepositoryAuditRequest {
  const record = exactRecord(value, 'repository_audit arguments', ['sourceId', 'targetRef', 'methodCodeDeltas'])
  const methodCodeDeltas = objectArray(record.methodCodeDeltas, 'methodCodeDeltas').map((item, index) => {
    const delta = exactRecord(item, `methodCodeDeltas[${index}]`, [
      'deltaId', 'evidenceId', 'classification', 'codeLocator', 'summary', 'likelyImpact', 'limitations',
    ])
    const classification = enumValue(
      delta.classification,
      METHOD_CODE_DELTA_CLASSIFICATIONS,
      `methodCodeDeltas[${index}].classification`,
    )
    const locator = delta.codeLocator === undefined
      ? undefined
      : parseCodeLocatorRequest(delta.codeLocator, `methodCodeDeltas[${index}].codeLocator`)
    return {
      deltaId: identifier(delta.deltaId, `methodCodeDeltas[${index}].deltaId`),
      evidenceId: text(delta.evidenceId, `methodCodeDeltas[${index}].evidenceId`),
      classification,
      ...(locator === undefined ? {} : { codeLocator: locator }),
      summary: text(delta.summary, `methodCodeDeltas[${index}].summary`),
      likelyImpact: text(delta.likelyImpact, `methodCodeDeltas[${index}].likelyImpact`),
      limitations: stringArray(delta.limitations, `methodCodeDeltas[${index}].limitations`),
    }
  })
  if (methodCodeDeltas.length > 128) throw new TypeError('methodCodeDeltas exceeds 128 entries')
  assertUnique(methodCodeDeltas.map(delta => delta.deltaId), 'methodCodeDeltas.deltaId')
  return {
    sourceId: text(record.sourceId, 'sourceId'),
    ...(record.targetRef === undefined ? {} : { targetRef: text(record.targetRef, 'targetRef') }),
    methodCodeDeltas,
  }
}

function parseTestSpecCandidateRequest(value: unknown): TestSpecCandidateRequest {
  const record = exactRecord(value, 'test_spec_candidate arguments', ['planId', 'repositoryAuditId', 'spec'])
  return {
    planId: text(record.planId, 'planId'),
    repositoryAuditId: text(record.repositoryAuditId, 'repositoryAuditId'),
    spec: record.spec,
  }
}

function parseCodeLocatorRequest(value: unknown, field: string): RepositoryCodeLocatorRequest {
  const record = exactRecord(value, field, ['path', 'lineStart', 'lineEnd'])
  const lineStart = positiveInteger(record.lineStart, `${field}.lineStart`)
  const lineEnd = positiveInteger(record.lineEnd, `${field}.lineEnd`)
  if (lineEnd < lineStart) throw new TypeError(`${field}.lineEnd precedes lineStart`)
  return { path: text(record.path, `${field}.path`), lineStart, lineEnd }
}

function normalizeRepositoryUrl(value: string): string {
  return value.trim()
    .replace(/^git@([^:]+):/iu, 'https://$1/')
    .replace(/^ssh:\/\/(?:[^@/]+@)?/iu, 'https://')
    .replace(/\.git\/?$/iu, '')
    .replace(/\/$/u, '')
    .toLowerCase()
}

function sameNullableRepositoryUrl(left: string | null, right: string | null): boolean {
  return left === null || right === null
    ? left === right
    : normalizeRepositoryUrl(left) === normalizeRepositoryUrl(right)
}

async function* singleChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes
}

function exactAgent(execution: Pick<ToolExecution, 'agent'>, operation: string): Agent {
  if (execution.agent === undefined) throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', `${operation} requires an exact live Agent`)
  return execution.agent
}

function generationConflict(error: unknown): boolean {
  return error instanceof GeoResearchError && error.code === 'PROJECT_GENERATION_CONFLICT'
}

function sameRepositoryAuditSnapshot(left: RepositoryAudit, right: RepositoryAudit): boolean {
  const { auditedAt: _leftAuditedAt, digest: _leftDigest, ...leftSnapshot } = left
  const { auditedAt: _rightAuditedAt, digest: _rightDigest, ...rightSnapshot } = right
  return digestJson(leftSnapshot) === digestJson(rightSnapshot)
}

function sameReproductionPlanSnapshot(left: ReproductionPlan, right: ReproductionPlan): boolean {
  const { createdAt: _leftCreatedAt, digest: _leftDigest, ...leftSnapshot } = left
  const { createdAt: _rightCreatedAt, digest: _rightDigest, ...rightSnapshot } = right
  return digestJson(leftSnapshot) === digestJson(rightSnapshot)
}

function exactRecord(value: unknown, field: string, allowedKeys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${field} must be an object`)
  const record = value as Record<string, unknown>
  const unexpected = Object.keys(record).filter(key => !allowedKeys.includes(key))
  if (unexpected.length > 0) throw new TypeError(`${field} contains unsupported fields: ${unexpected.join(', ')}`)
  return record
}

function objectArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  return value
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new TypeError(`${field} must be non-empty NUL-free text`)
  }
  return value
}

function identifier(value: unknown, field: string): string {
  const result = text(value, field)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(result)) throw new TypeError(`${field} is not a valid identifier`)
  return result
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive safe integer`)
  return value as number
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  return value.map((item, index) => text(item, `${field}[${index}]`))
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, field: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new TypeError(`${field} is invalid`)
  return value as T[number]
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${field} must be unique`)
}

function renderJson(_args: unknown, value: JsonValue) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

export { REPRODUCTION_REPORT_CANDIDATE_SCHEMA }
