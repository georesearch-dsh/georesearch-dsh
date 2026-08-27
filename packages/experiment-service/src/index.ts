import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@georesearch/dsh-geospatial-service'
import type {} from '@georesearch/dsh-installation-guard'
import type {} from '@georesearch/dsh-policy'
import type {} from '@georesearch/dsh-project-service'
import type {} from '@georesearch/dsh-run-service'
import {
  operationIdentity,
  registerTool,
  resolveDshHome,
  type Agent,
  type ToolDefinition,
  type ToolExecution,
} from '@georesearch/dsh-compat-rc5'
import {
  EXPERIMENT_AMENDMENT_SCHEMA,
  EXPERIMENT_SPEC_CANDIDATE_SCHEMA,
  EXPERIMENT_SPEC_SCHEMA,
  GeoResearchError,
  RESULT_RECORD_SCHEMA,
  digestJson,
  nowUtc,
  operationKeyFor,
  parseRunExitMarker,
  parseExperimentSpecCandidate,
  parseResultEnvelope,
  requestDigestFor,
  sha256Bytes,
  type DatasetManifest,
  type ExperimentAmendment,
  type ExperimentSpec,
  type ExperimentSpecCandidate,
  type JsonValue,
  type ResultRecord,
  type RunRecord,
} from '@georesearch/dsh-contracts'
import type { GeoResearchGeospatialService } from '@georesearch/dsh-geospatial-service'
import { projectPaths } from '@georesearch/dsh-project-provider-files'
import type {
  ExperimentSpecCommitRequest,
  GeoResearchProjectService,
  ResultRecordsCommitRequest,
} from '@georesearch/dsh-project-service'

declare module '@deepseek-ai/cordis' {
  interface Context {
    geoResearchExperiments: GeoResearchExperimentService
  }
}

export const name = 'georesearch-experiment-service'
export const inject = [
  'geoResearchInstallation',
  'geoResearchPolicy',
  'geoResearchProjects',
  'geoResearchGeospatial',
  'geoResearchRuns',
  'tools',
]

const COMMIT_RETRIES = 8
const RESULT_PREFIX = 'GEORESEARCH_RESULT_V1 '
const MAX_RESULT_LOG_BYTES = 64 * 1024 * 1024
const MAX_RESULT_ENVELOPE_CHARS = 4 * 1024 * 1024

export interface Config {
  readonly home?: string
  readonly resultLogMaxBytes?: number
}

export interface ExperimentProjectPort {
  resolveAgent(agent: Agent): ReturnType<GeoResearchProjectService['resolveAgent']>
  loadProject(projectId: string): ReturnType<GeoResearchProjectService['loadProject']>
  commitExperimentSpec(projectId: string, request: ExperimentSpecCommitRequest): ReturnType<GeoResearchProjectService['commitExperimentSpec']>
  commitResultRecords(projectId: string, request: ResultRecordsCommitRequest): ReturnType<GeoResearchProjectService['commitResultRecords']>
}

export interface ExperimentHostPort {
  requireExperiment(agent: Agent): void
  requireRootCoordinator(agent: Agent): void
  requireReviewer(agent: Agent): void
}

export interface ExperimentCoordinatorPorts {
  readonly projects: ExperimentProjectPort
  readonly geospatial: Pick<GeoResearchGeospatialService, 'verifyReport' | 'manifestFromReport'>
  readonly host: ExperimentHostPort
}

export interface ExperimentCommitResult {
  readonly experimentSpec: ExperimentSpec
  readonly amendment: ExperimentAmendment | null
  readonly datasetManifests: readonly DatasetManifest[]
}

export class ExperimentCoordinator {
  private readonly home: string
  private readonly resultLogMaxBytes: number
  private readonly clock: () => string

  constructor(
    private readonly ports: ExperimentCoordinatorPorts,
    config: { readonly home: string; readonly resultLogMaxBytes?: number; readonly now?: () => string },
  ) {
    this.home = config.home
    this.resultLogMaxBytes = positive(config.resultLogMaxBytes ?? MAX_RESULT_LOG_BYTES, 'resultLogMaxBytes')
    this.clock = config.now ?? nowUtc
  }

  async candidate(execution: ToolExecution, value: unknown): Promise<ExperimentSpecCandidate> {
    const agent = exactAgent(execution, 'experiment_spec_candidate')
    this.ports.host.requireExperiment(agent)
    const candidate = parseCandidate(value)
    await this.validateCandidate(agent, candidate, execution.signal)
    return candidate
  }

  async commitCandidate(
    execution: ToolExecution,
    value: unknown,
    expectedGeneration?: number,
  ): Promise<ExperimentCommitResult> {
    const agent = exactAgent(execution, 'experiment_spec_commit')
    this.ports.host.requireRootCoordinator(agent)
    const candidate = parseCandidate(value)
    const resolved = await this.ports.projects.resolveAgent(agent)
    await this.validateCandidate(agent, candidate, execution.signal)
    const current = await this.ports.projects.loadProject(resolved.stateFile.projectId)
    if (expectedGeneration !== undefined && current.generation !== expectedGeneration) {
      throw new GeoResearchError('PROJECT_GENERATION_CONFLICT', `expected generation ${expectedGeneration}, found ${current.generation}`)
    }
    const audit = current.state.repositoryAudits?.[candidate.repositoryAuditId]
    if (audit === undefined) throw new GeoResearchError('EXPERIMENT_SPEC_INVALID', 'RepositoryAudit disappeared during commit')
    const roleByDataset = new Map(candidate.datasetRoles.map(role => [role.datasetId, role.role]))
    const datasetManifests = candidate.datasetReports.map(report => this.ports.geospatial.manifestFromReport(
      report,
      roleByDataset.get(report.datasetId),
    ))
    if (datasetManifests.some(manifest => manifest.status !== 'verified')) {
      throw new GeoResearchError('GEODATA_MANDATORY_CHECK_BLOCKED', 'ExperimentSpec cannot freeze a blocked DatasetManifest')
    }
    const datasetRefs = datasetManifests.map(manifest => ({
      datasetId: manifest.datasetId,
      datasetDigest: manifest.digest,
      role: roleByDataset.get(manifest.datasetId) as NonNullable<ReturnType<typeof roleByDataset.get>>,
    }))
    const parent = candidate.amendment === null
      ? undefined
      : current.state.experimentSpecs?.[candidate.amendment.parentSpecId]
    const amendmentId = parent === undefined ? undefined : `amendment-${digestJson({
      domain: 'georesearch.experiment-amendment-id/v1',
      projectId: current.projectId,
      experimentId: candidate.experimentId,
      fromSpecDigest: parent.digest,
      toSpecId: candidate.specId,
      changes: candidate.amendment?.changes,
      reason: candidate.amendment?.reason,
    }).slice('sha256:'.length, 'sha256:'.length + 80)}`
    const protocol = {
      experimentId: candidate.experimentId,
      revision: candidate.revision,
      researchBriefDigest: candidate.researchBriefDigest,
      hypothesisIds: candidate.hypothesisIds,
      repositoryAuditDigest: audit.digest,
      sourceTreeDigest: audit.sourceTreeDigest,
      datasets: datasetRefs,
      baselines: candidate.baselines,
      independentVariables: candidate.independentVariables,
      controlVariables: candidate.controlVariables,
      splitStrategy: candidate.splitStrategy,
      preprocessing: candidate.preprocessing,
      metrics: candidate.metrics,
      seeds: candidate.seeds,
      ablations: candidate.ablations,
      statisticalPlan: candidate.statisticalPlan,
      stoppingRule: candidate.stoppingRule,
      resourceRequirements: candidate.resourceRequirements,
      acceptanceCriteria: candidate.acceptanceCriteria,
    }
    const frozenAt = this.clock()
    const specBody = {
      schemaVersion: 1 as const,
      specId: candidate.specId,
      experimentId: candidate.experimentId,
      revision: candidate.revision,
      projectId: current.projectId,
      workspaceId: resolved.binding.workspaceId,
      workspaceBindingVersion: resolved.binding.bindingVersion,
      researchBriefDigest: candidate.researchBriefDigest,
      hypothesisIds: candidate.hypothesisIds,
      repositoryAuditId: audit.auditId,
      repositoryAuditDigest: audit.digest,
      sourceTreeDigest: audit.sourceTreeDigest,
      datasets: datasetRefs,
      baselines: candidate.baselines,
      independentVariables: candidate.independentVariables,
      controlVariables: candidate.controlVariables,
      splitStrategy: candidate.splitStrategy,
      preprocessing: candidate.preprocessing,
      metrics: candidate.metrics,
      seeds: candidate.seeds,
      ablations: candidate.ablations,
      statisticalPlan: candidate.statisticalPlan,
      stoppingRule: candidate.stoppingRule,
      resourceRequirements: candidate.resourceRequirements,
      acceptanceCriteria: candidate.acceptanceCriteria,
      parentSpecDigest: parent?.digest ?? null,
      amendmentIds: amendmentId === undefined ? [] : [...parent!.amendmentIds, amendmentId],
      protocolDigest: digestJson(protocol),
      status: 'frozen' as const,
      frozenAt,
    }
    const experimentSpec: ExperimentSpec = { ...specBody, digest: digestJson(specBody) }
    const amendment = amendmentId === undefined || candidate.amendment === null || parent === undefined
      ? null
      : amendmentRecord(current.projectId, candidate, parent, experimentSpec, amendmentId, frozenAt)
    const operation = 'experiment_spec_commit'
    const operationKey = operationKeyFor(operationIdentity(execution, current.projectId, operation))
    const requestDigest = requestDigestFor(operation, candidate as unknown as JsonValue)
    const request: ExperimentSpecCommitRequest = {
      expectedGeneration: current.generation,
      operationKey,
      requestDigest,
      geodataReports: candidate.datasetReports,
      datasetManifests,
      experimentSpec,
      amendment,
    }
    await this.ports.projects.commitExperimentSpec(current.projectId, request)
    return { experimentSpec, amendment, datasetManifests }
  }

  async commitResults(
    execution: ToolExecution,
    expectedGeneration: number,
    runId: string,
  ): Promise<readonly ResultRecord[]> {
    const agent = exactAgent(execution, 'result_commit')
    this.ports.host.requireRootCoordinator(agent)
    positive(expectedGeneration, 'expectedGeneration')
    const resolved = await this.ports.projects.resolveAgent(agent)
    const current = await this.ports.projects.loadProject(resolved.stateFile.projectId)
    if (current.generation !== expectedGeneration) {
      throw new GeoResearchError('PROJECT_GENERATION_CONFLICT', `expected generation ${expectedGeneration}, found ${current.generation}`)
    }
    const run = current.state.runs[runId]
    if (run === undefined) throw new GeoResearchError('RUN_NOT_FOUND', `run ${runId} is unknown`)
    if (run.kind !== 'formal' || run.state !== 'succeeded') {
      throw new GeoResearchError('RESULT_INVALID', `run ${runId} is not a succeeded formal Run`)
    }
    const spec = Object.values(current.state.experimentSpecs ?? {}).find(candidate => candidate.digest === run.experimentSpecDigest)
    if (spec === undefined) throw new GeoResearchError('EXPERIMENT_SPEC_NOT_FOUND', 'formal Run is not bound to a frozen ExperimentSpec')
    const envelope = await this.readEnvelope(current.projectId, run)
    const committedAt = this.clock()
    const prepared = envelope.results.map(entry => {
      const metric = spec.metrics.find(candidate => candidate.metricId === entry.metricId)
      if (metric === undefined || metric.unit !== entry.unit || metric.aggregation !== entry.aggregation) {
        throw new GeoResearchError('RESULT_ENVELOPE_INVALID', `result ${entry.resultId} differs from frozen metric ${entry.metricId}`)
      }
      if (!spec.datasets.some(dataset => dataset.datasetId === entry.scope.datasetId)) {
        throw new GeoResearchError('RESULT_ENVELOPE_INVALID', `result ${entry.resultId} references an undeclared dataset`)
      }
      const artifactRefs = entry.artifactIds.map(artifactId => {
        const artifact = current.state.artifacts[artifactId]
        if (artifact === undefined || artifact.materialization !== 'committed'
          || artifact.integrity !== 'verified' || artifact.validity !== 'current') {
          throw new GeoResearchError('RESULT_ENVELOPE_INVALID', `result ${entry.resultId} references an invalid Artifact`)
        }
        return { artifactId: artifact.artifactId, digest: artifact.digest, kind: artifact.kind }
      })
      return { entry, artifactRefs }
    })
    const outputArtifactRefs = [...new Map(prepared.flatMap(item => item.artifactRefs)
      .map(ref => [ref.artifactId, ref])).values()].sort((left, right) => left.artifactId.localeCompare(right.artifactId))
    const boundRun: RunRecord = { ...run, outputArtifactRefs }
    const runDigest = digestJson(boundRun)
    const records = prepared.map(({ entry, artifactRefs }) => {
      const body = {
        schemaVersion: 1 as const,
        ...entry,
        projectId: current.projectId,
        workspaceId: run.workspaceId,
        workspaceBindingVersion: run.workspaceBindingVersion,
        experimentSpecId: spec.specId,
        experimentSpecDigest: spec.digest,
        runId: run.runId,
        runDigest,
        datasetDigests: run.datasetDigests,
        validationStatus: 'pending' as const,
        artifactRefs,
        committedAt,
      }
      const { validationStatus: ignoredValidationStatus, ...stableBody } = body
      void ignoredValidationStatus
      return { ...body, digest: digestJson(stableBody) }
    })
    const operation = 'result_commit'
    const request: ResultRecordsCommitRequest = {
      expectedGeneration,
      operationKey: operationKeyFor(operationIdentity(execution, current.projectId, operation)),
      requestDigest: requestDigestFor(operation, { runId } as unknown as JsonValue),
      run: boundRun,
      results: records,
    }
    await this.ports.projects.commitResultRecords(current.projectId, request)
    return records
  }

  async readResult(agent: Agent, resultId: string): Promise<ResultRecord> {
    this.ports.host.requireReviewer(agent)
    const resolved = await this.ports.projects.resolveAgent(agent)
    const current = await this.ports.projects.loadProject(resolved.stateFile.projectId)
    const result = current.state.results?.[resultId]
    if (result === undefined) throw new GeoResearchError('RESULT_NOT_FOUND', `result ${resultId} is unknown`)
    return result
  }

  private async validateCandidate(agent: Agent, candidate: ExperimentSpecCandidate, signal?: AbortSignal): Promise<void> {
    const resolved = await this.ports.projects.resolveAgent(agent)
    const current = await this.ports.projects.loadProject(resolved.stateFile.projectId)
    const brief = current.state.researchBrief
    if (brief === undefined || brief.digest !== candidate.researchBriefDigest) {
      throw new GeoResearchError('EXPERIMENT_SPEC_INVALID', 'ExperimentSpec candidate does not reference the current ResearchBrief')
    }
    const knownHypotheses = new Set(brief.hypotheses.map(hypothesis => hypothesis.hypothesisId))
    if (candidate.hypothesisIds.some(hypothesisId => !knownHypotheses.has(hypothesisId))) {
      throw new GeoResearchError('EXPERIMENT_SPEC_INVALID', 'ExperimentSpec candidate references an unknown hypothesis')
    }
    const audit = current.state.repositoryAudits?.[candidate.repositoryAuditId]
    if (audit === undefined || audit.workspaceId !== resolved.binding.workspaceId
      || audit.workspaceBindingVersion !== resolved.binding.bindingVersion) {
      throw new GeoResearchError('EXPERIMENT_SPEC_INVALID', 'ExperimentSpec candidate RepositoryAudit is not current')
    }
    for (const report of candidate.datasetReports) {
      if (report.projectId !== current.projectId || report.workspaceId !== resolved.binding.workspaceId
        || report.workspaceBindingVersion !== resolved.binding.bindingVersion || report.overall !== 'passed') {
        throw new GeoResearchError('GEODATA_MANDATORY_CHECK_BLOCKED', `dataset ${report.datasetId} has not passed mandatory checks`)
      }
      await this.ports.geospatial.verifyReport(agent, report, signal)
    }
    if (candidate.amendment === null) {
      if (candidate.revision !== 1) throw new GeoResearchError('EXPERIMENT_AMENDMENT_INVALID', 'initial ExperimentSpec revision must be 1')
    } else {
      const parent = current.state.experimentSpecs?.[candidate.amendment.parentSpecId]
      if (parent === undefined || parent.digest !== candidate.amendment.parentSpecDigest
        || parent.experimentId !== candidate.experimentId || candidate.revision !== parent.revision + 1) {
        throw new GeoResearchError('EXPERIMENT_AMENDMENT_INVALID', 'ExperimentSpec amendment parent is invalid')
      }
      if (candidate.amendment.resultsSeenRunIds.some(runId => current.state.runs[runId] === undefined)) {
        throw new GeoResearchError('EXPERIMENT_AMENDMENT_INVALID', 'ExperimentSpec amendment references an unknown viewed Run')
      }
    }
  }

  private async readEnvelope(projectId: string, run: RunRecord) {
    const root = projectPaths(this.home, projectId).root
    const path = resolve(root, run.stdoutPath)
    const relation = relative(root, path)
    if (isAbsolute(relation) || relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new GeoResearchError('RESULT_ENVELOPE_INVALID', 'Run stdout path escapes the Project state root')
    }
    let stdout: Buffer
    try {
      stdout = await readFile(path)
    } catch (error) {
      throw new GeoResearchError('RESULT_ENVELOPE_INVALID', 'Run stdout is unavailable', { cause: error })
    }
    if (stdout.byteLength > this.resultLogMaxBytes) {
      throw new GeoResearchError('RESULT_ENVELOPE_INVALID', 'Run stdout exceeds the result log limit')
    }
    let marker
    try {
      const markerPath = join(projectPaths(this.home, projectId).runs, run.runId, 'exit.json')
      marker = parseRunExitMarker(JSON.parse(await readFile(markerPath, 'utf8')) as unknown)
    } catch (error) {
      throw new GeoResearchError('RESULT_ENVELOPE_INVALID', 'Run exit marker is unavailable or invalid', { cause: error })
    }
    if (marker.projectId !== projectId || marker.runId !== run.runId || marker.launchId !== run.launchId
      || marker.exitCode !== (run.exitCode ?? null) || marker.endedAt !== run.endedAt
      || marker.stdoutDigest !== sha256Bytes(stdout)) {
      throw new GeoResearchError('RESULT_ENVELOPE_INVALID', 'Run stdout does not match its terminal exit marker')
    }
    const lines = stdout.toString('utf8').split(/\r?\n/u)
    const envelopes = lines.filter(line => line.startsWith(RESULT_PREFIX))
    if (envelopes.length === 0) throw new GeoResearchError('RESULT_ENVELOPE_NOT_FOUND', 'formal Run emitted no result envelope')
    if (envelopes.length !== 1) throw new GeoResearchError('RESULT_ENVELOPE_INVALID', 'formal Run emitted multiple result envelopes')
    const encoded = (envelopes[0] as string).slice(RESULT_PREFIX.length)
    if (encoded.length === 0 || encoded.length > MAX_RESULT_ENVELOPE_CHARS) {
      throw new GeoResearchError('RESULT_ENVELOPE_INVALID', 'formal Run result envelope size is invalid')
    }
    try {
      return parseResultEnvelope(JSON.parse(encoded) as unknown)
    } catch (error) {
      if (error instanceof GeoResearchError) throw error
      throw new GeoResearchError('RESULT_ENVELOPE_INVALID', 'formal Run result envelope is invalid', { cause: error })
    }
  }
}

export class GeoResearchExperimentService extends Service {
  readonly coordinator: ExperimentCoordinator

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'geoResearchExperiments')
    this.coordinator = new ExperimentCoordinator({
      projects: ctx.geoResearchProjects,
      geospatial: ctx.geoResearchGeospatial,
      host: new HarnessExperimentHost(ctx),
    }, {
      home: resolveDshHome(config.home),
      ...(config.resultLogMaxBytes === undefined ? {} : { resultLogMaxBytes: config.resultLogMaxBytes }),
    })
  }

  candidate(execution: ToolExecution, value: unknown): Promise<ExperimentSpecCandidate> {
    return this.coordinator.candidate(execution, value)
  }

  commitCandidate(execution: ToolExecution, value: unknown, expectedGeneration?: number): Promise<ExperimentCommitResult> {
    return this.coordinator.commitCandidate(execution, value, expectedGeneration)
  }

  commitResults(execution: ToolExecution, expectedGeneration: number, runId: string): Promise<readonly ResultRecord[]> {
    return this.coordinator.commitResults(execution, expectedGeneration, runId)
  }

  readResult(agent: Agent, resultId: string): Promise<ResultRecord> {
    return this.coordinator.readResult(agent, resultId)
  }
}

class HarnessExperimentHost implements ExperimentHostPort {
  constructor(private readonly ctx: Context) {}

  requireExperiment(agent: Agent): void {
    this.requireActor(agent, 'experiment')
  }

  requireRootCoordinator(agent: Agent): void {
    this.requireActor(agent, 'coordinator')
  }

  requireReviewer(agent: Agent): void {
    this.requireActor(agent, 'reviewer')
  }

  private requireActor(agent: Agent, expected: 'experiment' | 'coordinator' | 'reviewer'): void {
    this.ctx.geoResearchInstallation.assertCurrent()
    const actor = this.ctx.geoResearchPolicy.actorFor(agent)
    if (actor !== expected) throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', `${expected} operation is not authorized for ${actor ?? 'an unbound actor'}`)
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  ctx.geoResearchInstallation.assertCurrent()
  new GeoResearchExperimentService(ctx, config)
  for (const tool of experimentTools(ctx)) registerTool(ctx, tool)
}

/**
 * The Coordinator passes through a candidate produced and schema-validated by
 * the Experiment specialist. Keeping the nested candidate opaque here avoids
 * copying the evolving Phase 5 schema into every Coordinator request; the Host
 * still parses and revalidates the complete candidate before any commit.
 */
export const EXPERIMENT_SPEC_COMMIT_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    expectedGeneration: { type: 'integer', minimum: 1 },
    candidate: {
      type: 'object',
      description: 'Exact ExperimentSpecCandidate returned by the Experiment specialist. Pass it unchanged; the Host revalidates its full schema and provenance.',
    },
  },
  required: ['expectedGeneration', 'candidate'],
})

export function experimentTools(ctx: Context): readonly ToolDefinition[] {
  return [
    {
      name: 'experiment_spec_candidate',
      description: 'Validate a complete experiment protocol candidate without committing authoritative Project state.',
      parameters: EXPERIMENT_SPEC_CANDIDATE_SCHEMA,
      output: { schema: EXPERIMENT_SPEC_CANDIDATE_SCHEMA, render: renderJson },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        return ctx.geoResearchExperiments.candidate(execution, args) as unknown as Promise<JsonValue>
      },
    },
    {
      name: 'experiment_spec_commit',
      description: 'Commit the exact ExperimentSpecCandidate returned by the Experiment specialist. The Host revalidates the full protocol and provenance before freezing authoritative state.',
      parameters: EXPERIMENT_SPEC_COMMIT_PARAMETERS,
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            experimentSpec: EXPERIMENT_SPEC_SCHEMA,
            amendment: { oneOf: [EXPERIMENT_AMENDMENT_SCHEMA, { type: 'null' }] },
            datasetManifests: { type: 'array', items: { type: 'object' } },
          },
          required: ['experimentSpec', 'amendment', 'datasetManifests'],
        },
        render: renderJson,
      },
      async execute(args, execution) {
        const record = exactRecord(args, 'experiment_spec_commit arguments', ['expectedGeneration', 'candidate'])
        return ctx.geoResearchExperiments.commitCandidate(
          execution,
          record.candidate,
          positiveNumber(record.expectedGeneration, 'expectedGeneration'),
        ) as unknown as Promise<JsonValue>
      },
    },
    {
      name: 'result_commit',
      description: 'Commit ResultRecords parsed only from the succeeded formal Run result envelope; metric values are not accepted as arguments.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { expectedGeneration: { type: 'integer', minimum: 1 }, runId: { type: 'string', minLength: 1 } },
        required: ['expectedGeneration', 'runId'],
      },
      output: { schema: { type: 'array', items: RESULT_RECORD_SCHEMA }, render: renderJson },
      async execute(args, execution) {
        const record = exactRecord(args, 'result_commit arguments', ['expectedGeneration', 'runId'])
        return ctx.geoResearchExperiments.commitResults(
          execution,
          positiveNumber(record.expectedGeneration, 'expectedGeneration'),
          id(record.runId, 'runId'),
        ) as unknown as Promise<JsonValue>
      },
    },
    {
      name: 'result_read',
      description: 'Read one authoritative ResultRecord visible to the exact Reviewer Project binding.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { resultId: { type: 'string', minLength: 1 } }, required: ['resultId'],
      },
      output: { schema: RESULT_RECORD_SCHEMA, render: renderJson },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        const record = exactRecord(args, 'result_read arguments', ['resultId'])
        return ctx.geoResearchExperiments.readResult(
          exactAgent(execution, 'result_read'),
          id(record.resultId, 'resultId'),
        ) as unknown as Promise<JsonValue>
      },
    },
  ]
}

function amendmentRecord(
  projectId: string,
  candidate: ExperimentSpecCandidate,
  parent: ExperimentSpec,
  next: ExperimentSpec,
  amendmentId: string,
  createdAt: string,
): ExperimentAmendment {
  const proposal = candidate.amendment
  if (proposal === null) throw new TypeError('amendment proposal is missing')
  const body = {
    schemaVersion: 1 as const,
    amendmentId,
    projectId,
    experimentId: candidate.experimentId,
    fromSpecId: parent.specId,
    fromSpecDigest: parent.digest,
    toSpecId: next.specId,
    toSpecDigest: next.digest,
    changes: proposal.changes,
    reason: proposal.reason,
    resultsSeenRunIds: proposal.resultsSeenRunIds,
    createdAt,
  }
  return { ...body, digest: digestJson(body) }
}

function parseCandidate(value: unknown): ExperimentSpecCandidate {
  try {
    return parseExperimentSpecCandidate(value)
  } catch (error) {
    throw new GeoResearchError('EXPERIMENT_SPEC_INVALID', 'ExperimentSpec candidate schema is invalid', { cause: error })
  }
}

function exactAgent(execution: Pick<ToolExecution, 'agent'>, operation: string): Agent {
  if (execution.agent === undefined) throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', `${operation} requires an exact live Agent`)
  return execution.agent
}

function exactRecord(value: unknown, field: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${field} must be an object`)
  const record = value as Record<string, unknown>
  const unexpected = Object.keys(record).filter(key => !allowed.includes(key))
  if (unexpected.length > 0) throw new TypeError(`${field} contains unsupported fields: ${unexpected.join(', ')}`)
  return record
}

function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new TypeError(`${field} is invalid`)
  return value
}

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer`)
  return value
}

function positiveNumber(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive integer`)
  return value as number
}

function renderJson(_args: unknown, value: JsonValue) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}

void COMMIT_RETRIES
