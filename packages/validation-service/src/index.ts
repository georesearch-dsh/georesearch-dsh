import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@georesearch/dsh-installation-guard'
import type {} from '@georesearch/dsh-policy'
import type {} from '@georesearch/dsh-project-service'
import {
  operationIdentity,
  registerTool,
  type Agent,
  type ToolDefinition,
  type ToolExecution,
} from '@georesearch/dsh-compat-rc5'
import {
  GeoResearchError,
  REVIEW_PROPOSAL_SCHEMA,
  REVIEW_RECORD_SCHEMA,
  VALIDATION_SUBJECT_KINDS,
  VALIDATION_PLAN_SCHEMA,
  VALIDATION_REPORT_SCHEMA,
  deriveValidationOverall,
  digestJson,
  operationKeyFor,
  parseReviewProposal,
  parseValidationSubjectRef,
  requestDigestFor,
  type EvidenceRecord,
  type GeodataCheck,
  type JsonValue,
  type ProjectStateFile,
  type ReviewRecord,
  type Sha256Digest,
  type ValidationFinding,
  type ValidationPlan,
  type ValidationReport,
  type ValidationSubjectRef,
  type ValidationValidatorResult,
  type ValidationValidatorSpec,
} from '@georesearch/dsh-contracts'
import type {
  GeoResearchProjectService,
  ReviewRecordCommitRequest,
  ValidationCommitRequest,
} from '@georesearch/dsh-project-service'

declare module '@deepseek-ai/cordis' {
  interface Context {
    geoResearchValidation: GeoResearchValidationService
  }
}

export const name = 'georesearch-validation-service'
export const inject = [
  'geoResearchInstallation',
  'geoResearchPolicy',
  'geoResearchProjects',
  'tools',
]

export interface ValidationProjectPort {
  resolveAgent(agent: Agent): ReturnType<GeoResearchProjectService['resolveAgent']>
  loadProject(projectId: string): ReturnType<GeoResearchProjectService['loadProject']>
  commitValidation(projectId: string, request: ValidationCommitRequest): ReturnType<GeoResearchProjectService['commitValidation']>
  commitReviewRecord(projectId: string, request: ReviewRecordCommitRequest): ReturnType<GeoResearchProjectService['commitReviewRecord']>
}

export interface ValidationHostPort {
  requireReviewer(agent: Agent): void
}

export interface ValidationCoordinatorPorts {
  readonly projects: ValidationProjectPort
  readonly host: ValidationHostPort
}

export interface ValidationOutcome {
  readonly plan: ValidationPlan
  readonly report: ValidationReport
}

const VERSION = '1.0.0'

export class ValidationCoordinator {
  private readonly clock: () => string

  constructor(
    private readonly ports: ValidationCoordinatorPorts,
    clock: () => string = () => new Date().toISOString(),
  ) {
    this.clock = clock
  }

  async validateGeodata(
    execution: ToolExecution,
    expectedGeneration: number,
    reportId: string,
  ): Promise<ValidationOutcome> {
    const { current, resolved, operationKey } = await this.context(execution, expectedGeneration, 'geodata_validate')
    const report = current.state.geodataReports?.[reportId]
    if (report === undefined) throw new GeoResearchError('GEODATA_INVALID', `geodata report ${reportId} is unknown`)
    const subjects: ValidationSubjectRef[] = [{ kind: 'geodata-report', subjectId: reportId, digest: report.digest }]
    const validators = specs('geodata', [
      ['geodata.subject-current', true],
      ['geodata.mandatory-checks', true],
      ['geodata.crs', true],
      ['geodata.alignment', true],
      ['geodata.nodata', true],
      ['geodata.spatial-leakage', true],
    ])
    const results = [
      passed(validators[0]!),
      resultFromChecks(validators[1]!, report.checks.filter(check => check.mandatory), subjects),
      condition(validators[2]!, report.assets.every(asset => asset.crs.authority !== null), 'CRS_MISSING', 'Every geodata asset must declare a CRS.', subjects),
      resultFromChecks(validators[3]!, checksById(report.checks, ['alignment']), subjects, true),
      resultFromChecks(validators[4]!, checksById(report.checks, ['nodata']), subjects, true),
      resultFromChecks(validators[5]!, checksById(report.checks, ['spatial-leakage', 'temporal-leakage']), subjects, true),
    ]
    return await this.commit(execution, current, resolved.binding.workspaceId, resolved.binding.bindingVersion, operationKey, 'geodata', subjects, validators, results, { reportId })
  }

  async validateExperiment(
    execution: ToolExecution,
    expectedGeneration: number,
    resultIds: readonly string[],
  ): Promise<ValidationOutcome> {
    const { current, resolved, operationKey } = await this.context(execution, expectedGeneration, 'experiment_validate')
    const uniqueIds = uniqueNonEmpty(resultIds, 'resultIds')
    const records = uniqueIds.map(resultId => {
      const result = current.state.results?.[resultId]
      if (result === undefined) throw new GeoResearchError('RESULT_NOT_FOUND', `result ${resultId} is unknown`)
      return result
    })
    const subjects: ValidationSubjectRef[] = records
      .map(result => ({ kind: 'result' as const, subjectId: result.resultId, digest: result.digest }))
      .sort(subjectOrder)
    const validators = specs('experiment', [
      ['experiment.subject-current', true],
      ['experiment.formal-run-lineage', true],
      ['experiment.metric-contract', true],
      ['experiment.dataset-binding', true],
      ['experiment.test-set-independence', true],
      ['experiment.result-set', true],
    ])
    const runLineage = records.every(result => {
      const run = current.state.runs[result.runId]
      return run !== undefined && run.kind === 'formal' && run.state === 'succeeded'
        && digestJson(run) === result.runDigest
        && run.experimentSpecDigest === result.experimentSpecDigest
    })
    const metrics = records.every(result => {
      const spec = current.state.experimentSpecs?.[result.experimentSpecId]
      const metric = spec?.metrics.find(candidate => candidate.metricId === result.metricId)
      return spec?.digest === result.experimentSpecDigest
        && metric?.unit === result.unit
        && metric.aggregation === result.aggregation
    })
    const datasets = records.every(result => result.datasetDigests.every(datasetDigest => (
      Object.values(current.state.datasetManifests ?? {}).some(manifest => (
        manifest.digest === datasetDigest && manifest.status === 'verified'
      ))
    )))
    const results = [
      passed(validators[0]!),
      condition(validators[1]!, runLineage, 'FORMAL_RUN_LINEAGE_INVALID', 'Every ResultRecord must trace to a succeeded formal Run.', subjects),
      condition(validators[2]!, metrics, 'METRIC_CONTRACT_MISMATCH', 'Result metrics must match the frozen ExperimentSpec.', subjects),
      condition(validators[3]!, datasets, 'DATASET_BINDING_INVALID', 'Result datasets must remain verified and current.', subjects),
      condition(validators[4]!, !experimentHasTestSetTuning(current.state, records), 'TEST_SET_TUNING_DETECTED', 'An ExperimentSpec amendment was made after observing a Run bound to testing data.', subjects),
      condition(validators[5]!, records.length === uniqueIds.length, 'RESULT_SET_MISMATCH', 'The actual result set must match the ValidationPlan.', subjects),
    ]
    return await this.commit(execution, current, resolved.binding.workspaceId, resolved.binding.bindingVersion, operationKey, 'experiment', subjects, validators, results, { resultIds: uniqueIds })
  }

  async validateCitation(
    execution: ToolExecution,
    expectedGeneration: number,
    evidenceIds: readonly string[],
  ): Promise<ValidationOutcome> {
    const { current, resolved, operationKey } = await this.context(execution, expectedGeneration, 'citation_validate')
    const uniqueIds = uniqueNonEmpty(evidenceIds, 'evidenceIds')
    const records = uniqueIds.map(evidenceId => {
      const evidence = current.state.evidence?.[evidenceId]
      if (evidence === undefined) throw new GeoResearchError('EVIDENCE_NOT_FOUND', `evidence ${evidenceId} is unknown`)
      return evidence
    })
    const subjects: ValidationSubjectRef[] = records
      .map(evidence => ({ kind: 'evidence' as const, subjectId: evidence.evidenceId, digest: evidence.digest }))
      .sort(subjectOrder)
    const validators = specs('citation', [
      ['citation.subject-current', true],
      ['citation.source-registered', true],
      ['citation.artifact-current', true],
      ['citation.locator-lineage', true],
      ['citation.review-state', true],
    ])
    const sources = records.every(evidence => current.state.sources?.[evidence.sourceId] !== undefined)
    const artifacts = records.every(evidence => {
      const artifact = current.state.artifacts[evidence.artifactId]
      return artifact?.digest === evidence.artifactDigest
        && artifact.materialization === 'committed'
        && artifact.integrity === 'verified'
        && artifact.validity === 'current'
    })
    const lineage = records.every(evidence => evidence.locator.pageStart >= 1
      && evidence.locator.pageEnd >= evidence.locator.pageStart
      && evidence.extractionLineage.parserId.length > 0
      && evidence.extractionLineage.parserVersion.length > 0)
    const results = [
      passed(validators[0]!),
      condition(validators[1]!, sources, 'CITATION_SOURCE_MISSING', 'Every citation must reference a registered SourceRecord.', subjects),
      condition(validators[2]!, artifacts, 'CITATION_ARTIFACT_STALE', 'Citation artifacts must remain current and digest-matched.', subjects),
      condition(validators[3]!, lineage, 'CITATION_LINEAGE_MISSING', 'Citation page and parser lineage must be complete.', subjects),
      citationReviewState(validators[4]!, records, subjects),
    ]
    return await this.commit(execution, current, resolved.binding.workspaceId, resolved.binding.bindingVersion, operationKey, 'citation', subjects, validators, results, { evidenceIds: uniqueIds })
  }

  async reviewCandidate(
    execution: ToolExecution,
    expectedGeneration: number,
    value: unknown,
  ): Promise<ReviewRecord> {
    const agent = exactAgent(execution, 'review_candidate')
    this.ports.host.requireReviewer(agent)
    positive(expectedGeneration, 'expectedGeneration')
    const resolved = await this.ports.projects.resolveAgent(agent)
    const current = await this.ports.projects.loadProject(resolved.stateFile.projectId)
    if (current.generation !== expectedGeneration) {
      throw new GeoResearchError('PROJECT_GENERATION_CONFLICT', `expected generation ${expectedGeneration}, found ${current.generation}`)
    }
    const proposal = parseReviewProposal(value)
    const createdAt = this.clock()
    const body = {
      ...proposal,
      projectId: current.projectId,
      workspaceId: resolved.binding.workspaceId,
      workspaceBindingVersion: resolved.binding.bindingVersion,
      createdAt,
    }
    const reviewRecord: ReviewRecord = { ...body, digest: digestJson(body) }
    const operation = 'review_candidate'
    await this.ports.projects.commitReviewRecord(current.projectId, {
      expectedGeneration,
      operationKey: operationKeyFor(operationIdentity(execution, current.projectId, operation)),
      requestDigest: requestDigestFor(operation, proposal as unknown as JsonValue),
      reviewRecord,
    })
    return reviewRecord
  }

  async readSubject(execution: ToolExecution, value: unknown): Promise<{
    readonly subject: ValidationSubjectRef
    readonly record: JsonValue
  }> {
    const agent = exactAgent(execution, 'review_subject_read')
    this.ports.host.requireReviewer(agent)
    const subject = parseValidationSubjectRef(value)
    const resolved = await this.ports.projects.resolveAgent(agent)
    const current = await this.ports.projects.loadProject(resolved.stateFile.projectId)
    const record = reviewSubjectRecord(current.state, subject)
    if (record === undefined) {
      throw new GeoResearchError('REVIEW_INVALID', `${subject.kind} ${subject.subjectId} is stale or unavailable`)
    }
    return { subject, record }
  }

  private async context(execution: ToolExecution, expectedGeneration: number, operation: string) {
    const agent = exactAgent(execution, operation)
    this.ports.host.requireReviewer(agent)
    positive(expectedGeneration, 'expectedGeneration')
    const resolved = await this.ports.projects.resolveAgent(agent)
    const current = await this.ports.projects.loadProject(resolved.stateFile.projectId)
    if (current.generation !== expectedGeneration) {
      throw new GeoResearchError('PROJECT_GENERATION_CONFLICT', `expected generation ${expectedGeneration}, found ${current.generation}`)
    }
    return {
      current,
      resolved,
      operationKey: operationKeyFor(operationIdentity(execution, current.projectId, operation)),
    }
  }

  private async commit(
    execution: ToolExecution,
    current: ProjectStateFile,
    workspaceId: string,
    workspaceBindingVersion: number,
    operationKey: Sha256Digest,
    domain: ValidationPlan['domain'],
    subjects: readonly ValidationSubjectRef[],
    validators: readonly ValidationValidatorSpec[],
    validatorResults: readonly ValidationValidatorResult[],
    request: JsonValue,
  ): Promise<ValidationOutcome> {
    const createdAt = this.clock()
    const token = operationKey.slice('sha256:'.length, 'sha256:'.length + 24)
    const planBody = {
      schemaVersion: 1 as const,
      planId: `validation-plan-${token}`,
      projectId: current.projectId,
      workspaceId,
      workspaceBindingVersion,
      domain,
      subjects: [...subjects].sort(subjectOrder),
      validators,
      policyDigest: digestJson({ phase: 'phase6', domain, validators }),
      createdAt,
    }
    const plan: ValidationPlan = { ...planBody, digest: digestJson(planBody) }
    const completedAt = this.clock()
    const reportBody = {
      schemaVersion: 1 as const,
      reportId: `validation-report-${token}`,
      projectId: current.projectId,
      workspaceId,
      workspaceBindingVersion,
      planId: plan.planId,
      planDigest: plan.digest,
      subjects: plan.subjects,
      validatorResults,
      overall: deriveValidationOverall(plan, validatorResults),
      completedAt,
    }
    const report: ValidationReport = { ...reportBody, digest: digestJson(reportBody) }
    await this.ports.projects.commitValidation(current.projectId, {
      expectedGeneration: current.generation,
      operationKey,
      requestDigest: requestDigestFor(`${domain}_validate`, request),
      validationPlan: plan,
      validationReport: report,
    })
    void execution
    return { plan, report }
  }
}

export class GeoResearchValidationService extends Service {
  readonly coordinator: ValidationCoordinator

  constructor(ctx: Context) {
    super(ctx, 'geoResearchValidation')
    this.coordinator = new ValidationCoordinator({
      projects: ctx.geoResearchProjects,
      host: new HarnessValidationHost(ctx),
    })
  }

  validateGeodata(execution: ToolExecution, expectedGeneration: number, reportId: string) {
    return this.coordinator.validateGeodata(execution, expectedGeneration, reportId)
  }

  validateExperiment(execution: ToolExecution, expectedGeneration: number, resultIds: readonly string[]) {
    return this.coordinator.validateExperiment(execution, expectedGeneration, resultIds)
  }

  validateCitation(execution: ToolExecution, expectedGeneration: number, evidenceIds: readonly string[]) {
    return this.coordinator.validateCitation(execution, expectedGeneration, evidenceIds)
  }

  reviewCandidate(execution: ToolExecution, expectedGeneration: number, value: unknown) {
    return this.coordinator.reviewCandidate(execution, expectedGeneration, value)
  }

  readSubject(execution: ToolExecution, value: unknown) {
    return this.coordinator.readSubject(execution, value)
  }
}

class HarnessValidationHost implements ValidationHostPort {
  constructor(private readonly ctx: Context) {}

  requireReviewer(agent: Agent): void {
    this.ctx.geoResearchInstallation.assertCurrent()
    const actor = this.ctx.geoResearchPolicy.actorFor(agent)
    if (actor !== 'reviewer') {
      throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', `reviewer operation is not authorized for ${actor ?? 'an unbound actor'}`)
    }
  }
}

export function apply(ctx: Context): void {
  ctx.geoResearchInstallation.assertCurrent()
  new GeoResearchValidationService(ctx)
  for (const tool of validationTools(ctx)) registerTool(ctx, tool)
}

export function validationTools(ctx: Context): readonly ToolDefinition[] {
  const generation = { type: 'integer', minimum: 1 } as const
  const idSchema = { type: 'string', minLength: 1 } as const
  return [
    {
      name: 'geodata_validate',
      description: 'Run the Host-mandated deterministic geodata ValidationPlan and commit its immutable report.',
      parameters: strictParameters({ expectedGeneration: generation, reportId: idSchema }, ['expectedGeneration', 'reportId']),
      output: validationOutputSchema(),
      async execute(args, execution) {
        const record = exactArgs(args, ['expectedGeneration', 'reportId'])
        return ctx.geoResearchValidation.validateGeodata(execution, positive(record.expectedGeneration, 'expectedGeneration'), id(record.reportId, 'reportId')) as unknown as Promise<JsonValue>
      },
    },
    {
      name: 'experiment_validate',
      description: 'Recompute mandatory formal-run, metric, and dataset lineage checks for an exact ResultRecord set.',
      parameters: strictParameters({
        expectedGeneration: generation,
        resultIds: { type: 'array', minItems: 1, uniqueItems: true, items: idSchema },
      }, ['expectedGeneration', 'resultIds']),
      output: validationOutputSchema(),
      async execute(args, execution) {
        const record = exactArgs(args, ['expectedGeneration', 'resultIds'])
        return ctx.geoResearchValidation.validateExperiment(execution, positive(record.expectedGeneration, 'expectedGeneration'), stringArray(record.resultIds, 'resultIds')) as unknown as Promise<JsonValue>
      },
    },
    {
      name: 'citation_validate',
      description: 'Validate current Source, Artifact, page, parser lineage, and review state for exact EvidenceRecords.',
      parameters: strictParameters({
        expectedGeneration: generation,
        evidenceIds: { type: 'array', minItems: 1, uniqueItems: true, items: idSchema },
      }, ['expectedGeneration', 'evidenceIds']),
      output: validationOutputSchema(),
      async execute(args, execution) {
        const record = exactArgs(args, ['expectedGeneration', 'evidenceIds'])
        return ctx.geoResearchValidation.validateCitation(execution, positive(record.expectedGeneration, 'expectedGeneration'), stringArray(record.evidenceIds, 'evidenceIds')) as unknown as Promise<JsonValue>
      },
    },
    {
      name: 'review_subject_read',
      description: 'Read one exact digest-bound research subject supplied by the Host delegation contract.',
      parameters: strictParameters({
        subject: {
          type: 'object', additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: [...VALIDATION_SUBJECT_KINDS] },
            subjectId: idSchema,
            digest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
          },
          required: ['kind', 'subjectId', 'digest'],
        },
      }, ['subject']),
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: {
            subject: {
              type: 'object', additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: [...VALIDATION_SUBJECT_KINDS] },
                subjectId: idSchema,
                digest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
              },
              required: ['kind', 'subjectId', 'digest'],
            },
            record: { type: 'object' },
          },
          required: ['subject', 'record'],
        },
        render: renderJson,
      },
      async execute(args, execution) {
        const record = exactArgs(args, ['subject'])
        return ctx.geoResearchValidation.readSubject(execution, record.subject) as unknown as Promise<JsonValue>
      },
    },
    {
      name: 'review_candidate',
      description: 'Commit a strict independent ReviewRecord without modifying its subject. For a read-only proposal review, expectedGeneration must equal delegation_bootstrap authority.generation; never use a hard-coded default.',
      parameters: strictParameters({ expectedGeneration: generation, candidate: REVIEW_PROPOSAL_SCHEMA }, ['expectedGeneration', 'candidate']),
      output: { schema: REVIEW_RECORD_SCHEMA, render: renderJson },
      async execute(args, execution) {
        const record = exactArgs(args, ['expectedGeneration', 'candidate'])
        return ctx.geoResearchValidation.reviewCandidate(execution, positive(record.expectedGeneration, 'expectedGeneration'), record.candidate) as unknown as Promise<JsonValue>
      },
    },
  ]
}

function specs(
  domain: string,
  entries: readonly (readonly [string, boolean])[],
): ValidationValidatorSpec[] {
  return entries.map(([validatorId, mandatory]) => ({
    validatorId,
    version: VERSION,
    mandatory,
    configDigest: digestJson({ validatorId, version: VERSION, domain, config: 'frozen-default' }),
  }))
}

function passed(spec: ValidationValidatorSpec): ValidationValidatorResult {
  return { ...spec, status: 'passed', findings: [] }
}

function condition(
  spec: ValidationValidatorSpec,
  ok: boolean,
  code: string,
  message: string,
  subjects: readonly ValidationSubjectRef[],
): ValidationValidatorResult {
  return ok ? passed(spec) : {
    ...spec,
    status: 'failed',
    findings: [finding(spec.validatorId, code, message, subjects, 'hard')],
  }
}

function resultFromChecks(
  spec: ValidationValidatorSpec,
  checks: readonly GeodataCheck[],
  subjects: readonly ValidationSubjectRef[],
  allowNotApplicable = false,
): ValidationValidatorResult {
  if (checks.length === 0) {
    return allowNotApplicable
      ? { ...spec, status: 'not-applicable', findings: [] }
      : { ...spec, status: 'blocked', findings: [finding(spec.validatorId, 'MANDATORY_VALIDATOR_INPUT_MISSING', 'The mandatory check set is empty.', subjects, 'hard')] }
  }
  const blocked = checks.filter(check => check.status === 'blocked')
  const failed = checks.filter(check => check.status === 'failed')
  if (blocked.length > 0) return {
    ...spec,
    status: 'blocked',
    findings: blocked.map(check => finding(spec.validatorId, check.code, check.message, subjects, 'hard')),
  }
  if (failed.length > 0) return {
    ...spec,
    status: 'failed',
    findings: failed.map(check => finding(spec.validatorId, check.code, check.message, subjects, 'hard')),
  }
  if (checks.every(check => check.status === 'not-applicable')) return { ...spec, status: 'not-applicable', findings: [] }
  return passed(spec)
}

function checksById(checks: readonly GeodataCheck[], ids: readonly string[]): GeodataCheck[] {
  return checks.filter(check => ids.includes(check.checkId))
}

function experimentHasTestSetTuning(
  state: ProjectStateFile['state'],
  results: readonly NonNullable<ProjectStateFile['state']['results']>[string][],
): boolean {
  const specsById = new Map(results.map(result => [
    result.experimentSpecId,
    state.experimentSpecs?.[result.experimentSpecId],
  ]))
  for (const spec of specsById.values()) {
    if (spec === undefined) return true
    const testingDigests = new Set(spec.datasets
      .filter(dataset => dataset.role === 'testing')
      .map(dataset => dataset.datasetDigest))
    for (const amendmentId of spec.amendmentIds) {
      const amendment = state.experimentAmendments?.[amendmentId]
      if (amendment === undefined) return true
      const amendmentTime = Date.parse(amendment.createdAt)
      if (!Number.isFinite(amendmentTime)) return true
      if (Object.values(state.results ?? {}).some(result => {
        if (result.experimentSpecId !== amendment.fromSpecId) return false
        const committedTime = Date.parse(result.committedAt)
        return !Number.isFinite(committedTime)
          || (committedTime <= amendmentTime && /^(?:test|testing|holdout)$/iu.test(result.scope.split.trim()))
      })) return true
      for (const runId of amendment.resultsSeenRunIds) {
        const run = state.runs[runId]
        if (run === undefined || run.datasetDigests.some(digest => testingDigests.has(digest))) return true
        if (Object.values(state.results ?? {}).some(result => (
          result.runId === runId && /^(?:test|testing|holdout)$/iu.test(result.scope.split.trim())
        ))) return true
      }
    }
  }
  return false
}

function citationReviewState(
  spec: ValidationValidatorSpec,
  records: readonly EvidenceRecord[],
  subjects: readonly ValidationSubjectRef[],
): ValidationValidatorResult {
  if (records.some(evidence => evidence.reviewStatus === 'rejected')) {
    return condition(spec, false, 'CITATION_REJECTED', 'Rejected Evidence cannot support a citation.', subjects)
  }
  if (records.some(evidence => evidence.reviewStatus === 'needs-review')) {
    return {
      ...spec,
      status: 'blocked',
      findings: [finding(
        spec.validatorId,
        'CITATION_REVIEW_REQUIRED',
        'Evidence requiring revision cannot support a citation until it is reviewed again.',
        subjects,
        'hard',
      )],
    }
  }
  if (records.some(evidence => evidence.reviewStatus === 'pending')) {
    return {
      ...spec,
      status: 'not-applicable',
      findings: [finding(
        spec.validatorId,
        'CITATION_REVIEW_PENDING',
        'Citation lineage is valid, but independent Evidence review is still pending.',
        subjects,
        'warning',
      )],
    }
  }
  return passed(spec)
}

function finding(
  validatorId: string,
  code: string,
  message: string,
  subjects: readonly ValidationSubjectRef[],
  severity: ValidationFinding['severity'],
): ValidationFinding {
  const subjectIds = subjects.map(subject => subject.subjectId).sort()
  return {
    findingId: `finding-${digestJson({ validatorId, code, subjectIds }).slice('sha256:'.length, 'sha256:'.length + 24)}`,
    validatorId,
    severity,
    code,
    message,
    subjectIds,
  }
}

function validationOutputSchema(): NonNullable<ToolDefinition['output']> {
  return {
    schema: {
      type: 'object' as const, additionalProperties: false,
      properties: { plan: VALIDATION_PLAN_SCHEMA, report: VALIDATION_REPORT_SCHEMA },
      required: ['plan', 'report'],
    },
    render: renderJson,
  }
}

function strictParameters(properties: Record<string, unknown>, required: readonly string[]) {
  return { type: 'object', additionalProperties: false, properties, required }
}

function exactArgs(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('tool arguments must be an object')
  const record = value as Record<string, unknown>
  const unexpected = Object.keys(record).filter(key => !allowed.includes(key))
  if (unexpected.length > 0) throw new TypeError(`tool arguments contain unsupported fields: ${unexpected.join(', ')}`)
  return record
}

function exactAgent(execution: Pick<ToolExecution, 'agent'>, operation: string): Agent {
  if (execution.agent === undefined) throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', `${operation} requires an exact live Agent`)
  return execution.agent
}

function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive integer`)
  return value as number
}

function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(value)) throw new TypeError(`${field} is invalid`)
  return value
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  return value.map((entry, index) => id(entry, `${field}[${index}]`))
}

function uniqueNonEmpty(values: readonly string[], field: string): string[] {
  if (values.length === 0 || new Set(values).size !== values.length) throw new TypeError(`${field} must be non-empty and unique`)
  return [...values].sort()
}

function subjectOrder(left: ValidationSubjectRef, right: ValidationSubjectRef): number {
  return `${left.kind}:${left.subjectId}`.localeCompare(`${right.kind}:${right.subjectId}`)
}

function reviewSubjectRecord(state: ProjectStateFile['state'], subject: ValidationSubjectRef): JsonValue | undefined {
  let record: unknown
  switch (subject.kind) {
    case 'geodata-report': record = state.geodataReports?.[subject.subjectId]; break
    case 'dataset-manifest': record = state.datasetManifests?.[subject.subjectId]; break
    case 'experiment-spec': record = state.experimentSpecs?.[subject.subjectId]; break
    case 'run': record = state.runs[subject.subjectId]; break
    case 'result': record = state.results?.[subject.subjectId]; break
    case 'evidence': record = state.evidence?.[subject.subjectId]; break
    case 'reproduction-report': record = state.reproductionReports?.[subject.subjectId]; break
    case 'claim': record = state.claims?.[subject.subjectId]; break
    case 'research-brief': record = state.researchBrief?.briefId === subject.subjectId ? state.researchBrief : undefined; break
    case 'manuscript': record = state.manuscripts?.[subject.subjectId]; break
  }
  if (record === undefined) return undefined
  const digest = subject.kind === 'run' ? digestJson(record) : (record as { readonly digest?: unknown }).digest
  return digest === subject.digest ? record as JsonValue : undefined
}

function renderJson(_args: unknown, value: JsonValue) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}
