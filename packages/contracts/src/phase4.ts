import type { ArtifactRef, RunRecord, Sha256Digest, TestSpec } from './index.js'

export const PHASE4_SCHEMA_VERSION = 1 as const

export const METHOD_CODE_DELTA_CLASSIFICATIONS = [
  'matches',
  'partially-matches',
  'differs',
  'missing-in-code',
  'not-described-in-paper',
  'unclear',
] as const

export type MethodCodeDeltaClassification = typeof METHOD_CODE_DELTA_CLASSIFICATIONS[number]

export const REPRODUCTION_SCOPES = [
  'exact',
  'metric-equivalent',
  'functional',
  'conceptual',
  'partial',
] as const

export type ReproductionScope = typeof REPRODUCTION_SCOPES[number]

export const REPRODUCTION_STATUSES = [
  'exactly-reproduced',
  'metric-equivalent',
  'functionally-reproduced',
  'conceptually-reproduced',
  'partially-reproduced',
  'blocked-by-missing-data',
  'blocked-by-environment',
  'failed-with-diagnosis',
] as const

export type ReproductionStatus = typeof REPRODUCTION_STATUSES[number]

export interface RepositoryProviderCapability {
  readonly providerId: 'git-cli'
  readonly providerVersion: string
  readonly shell: false
  readonly readOnlyCommands: true
  readonly maxFiles: number
  readonly maxChanges: number
  readonly maxHashedBytes: number
}

export interface RepositoryChange {
  readonly status: string
  readonly path: string
  readonly digest?: Sha256Digest
  readonly size?: number
}

export interface RepositoryLanguageSummary {
  readonly language: string
  readonly fileCount: number
}

export interface RepositoryBuildSystem {
  readonly name: string
  readonly manifestPaths: readonly string[]
}

export interface RepositoryCodeLocator {
  readonly path: string
  readonly lineStart: number
  readonly lineEnd: number
  readonly fileDigest: Sha256Digest
  readonly lineDigest: Sha256Digest
}

export interface MethodCodeDelta {
  readonly deltaId: string
  readonly evidenceId: string
  readonly paperStatement: string
  readonly classification: MethodCodeDeltaClassification
  readonly codeLocator?: RepositoryCodeLocator
  readonly summary: string
  readonly likelyImpact: string
  readonly limitations: readonly string[]
}

export interface ReproductionBlocker {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export interface RepositoryAudit {
  readonly schemaVersion: 1
  readonly auditId: string
  readonly projectId: string
  readonly workspaceId: string
  readonly workspaceBindingVersion: number
  readonly sourceId: string
  readonly sourceDigest: Sha256Digest
  readonly repository: {
    readonly capability: RepositoryProviderCapability
    readonly canonicalRoot: string
    readonly gitDir: string
    readonly gitCommonDir: string
    readonly remoteUrl: string | null
    readonly headCommit: string | null
    readonly branch: string | null
    readonly detached: boolean
    readonly tags: readonly string[]
    readonly targetRef: string | null
    readonly targetCommit: string | null
    readonly targetMatchesHead: boolean
    readonly dirty: boolean
    readonly changes: readonly RepositoryChange[]
  }
  readonly sourceTreeDigest: Sha256Digest
  readonly languages: readonly RepositoryLanguageSummary[]
  readonly buildSystems: readonly RepositoryBuildSystem[]
  readonly entryPoints: readonly string[]
  readonly configurationFiles: readonly string[]
  readonly dataDependencyPaths: readonly string[]
  readonly environmentFiles: readonly string[]
  readonly testPaths: readonly string[]
  readonly methodCodeDeltas: readonly MethodCodeDelta[]
  readonly blockers: readonly ReproductionBlocker[]
  readonly auditedAt: string
  readonly digest: Sha256Digest
}

export interface ReproductionTargetResult {
  readonly resultId: string
  readonly description: string
  readonly metric: string
  readonly expectedValue: string | null
  readonly unit: string | null
  readonly evidenceId: string | null
}

export interface ReproductionTolerance {
  readonly resultId: string
  readonly absolute: number | null
  readonly relative: number | null
}

export interface ReproductionPlanStep {
  readonly stepId: string
  readonly kind: 'inspect' | 'modify' | 'test' | 'formal-run' | 'compare'
  readonly description: string
  readonly expectedOutputs: readonly string[]
}

export interface ReproductionPlanBody {
  readonly schemaVersion: 1
  readonly planId: string
  readonly sourceId: string
  readonly repositoryAuditId: string
  readonly targetRepository: {
    readonly remoteUrl: string | null
    readonly commit: string
  }
  readonly targetData: readonly string[]
  readonly targetResults: readonly ReproductionTargetResult[]
  readonly scope: ReproductionScope
  readonly environmentRequirements: readonly string[]
  readonly missingMaterials: readonly string[]
  readonly steps: readonly ReproductionPlanStep[]
  readonly expectedOutputs: readonly string[]
  readonly tolerances: readonly ReproductionTolerance[]
  readonly blockers: readonly ReproductionBlocker[]
}

export interface ReproductionPlan extends ReproductionPlanBody {
  readonly projectId: string
  readonly workspaceId: string
  readonly workspaceBindingVersion: number
  readonly repositoryAuditDigest: Sha256Digest
  readonly sourceTreeDigest: Sha256Digest
  readonly status: 'candidate'
  readonly createdAt: string
  readonly digest: Sha256Digest
}

export interface ReproductionTestSpecRecord {
  readonly schemaVersion: 1
  readonly projectId: string
  readonly workspaceId: string
  readonly workspaceBindingVersion: number
  readonly planId: string
  readonly repositoryAuditId: string
  readonly sourceTreeDigest: Sha256Digest
  readonly spec: TestSpec
  readonly specDigest: Sha256Digest
  readonly registeredAt: string
  readonly digest: Sha256Digest
}

export interface ReproductionMetricResult {
  readonly resultId: string
  readonly expectedValue: string | null
  readonly observedValue: string | null
  readonly unit: string | null
  readonly comparison: 'match' | 'within-tolerance' | 'different' | 'unavailable'
}

export interface ReproductionModification {
  readonly path: string
  readonly description: string
  readonly reason: string
}

export interface ReproductionDiagnosis {
  readonly code: string
  readonly message: string
  readonly relatedRunIds: readonly string[]
  readonly relatedArtifactIds: readonly string[]
}

export interface ReproductionReportCandidate {
  readonly schemaVersion: 1
  readonly kind: 'reproduction-report'
  readonly planId: string
  readonly baselineAuditId: string
  readonly finalAuditId: string
  readonly runIds: readonly string[]
  readonly status: ReproductionStatus
  readonly metricResults: readonly ReproductionMetricResult[]
  readonly paperDescription: string
  readonly officialCodeBehavior: string
  readonly localImplementationAndEnvironment: string
  readonly necessaryModifications: readonly ReproductionModification[]
  readonly resultDifferences: readonly string[]
  readonly differenceSources: readonly string[]
  readonly unresolvedDetails: readonly string[]
  readonly diagnostics: readonly ReproductionDiagnosis[]
  readonly limitations: readonly string[]
}

export interface ReproductionReport extends ReproductionReportCandidate {
  readonly reportId: string
  readonly projectId: string
  readonly workspaceId: string
  readonly workspaceBindingVersion: number
  readonly planDigest: Sha256Digest
  readonly baselineAuditDigest: Sha256Digest
  readonly finalAuditDigest: Sha256Digest
  readonly reportArtifact: ArtifactRef
  readonly reviewStatus: 'pending' | 'accepted' | 'rejected' | 'needs-review'
  readonly committedAt: string
  readonly digest: Sha256Digest
}

export interface ReproductionReportOutcomeViolation {
  readonly code: 'REPRODUCTION_REPORT_INVALID' | 'REPRODUCTION_BASELINE_MODIFIED'
  readonly message: string
}

export function reproductionReportOutcomeViolation(
  candidate: ReproductionReportCandidate,
  plan: ReproductionPlan,
  baseline: RepositoryAudit,
  final: RepositoryAudit,
  runs: readonly RunRecord[],
  testSpecs: readonly ReproductionTestSpecRecord[],
): ReproductionReportOutcomeViolation | undefined {
  const reproduced = !candidate.status.startsWith('blocked-') && candidate.status !== 'failed-with-diagnosis'
  const allowedSuccess: Readonly<Record<ReproductionScope, readonly ReproductionStatus[]>> = {
    exact: [
      'exactly-reproduced', 'metric-equivalent', 'functionally-reproduced',
      'conceptually-reproduced', 'partially-reproduced',
    ],
    'metric-equivalent': [
      'metric-equivalent', 'functionally-reproduced', 'conceptually-reproduced', 'partially-reproduced',
    ],
    functional: ['functionally-reproduced', 'conceptually-reproduced', 'partially-reproduced'],
    conceptual: ['conceptually-reproduced', 'partially-reproduced'],
    partial: ['partially-reproduced'],
  }
  if (reproduced && !allowedSuccess[plan.scope].includes(candidate.status)) {
    return {
      code: 'REPRODUCTION_REPORT_INVALID',
      message: `${candidate.status} exceeds the declared ${plan.scope} reproduction scope`,
    }
  }

  const targets = new Map(plan.targetResults.map(result => [result.resultId, result]))
  for (const result of candidate.metricResults) {
    const target = targets.get(result.resultId)
    if (target === undefined) {
      return {
        code: 'REPRODUCTION_REPORT_INVALID',
        message: `metric result ${result.resultId} is not declared by the ReproductionPlan`,
      }
    }
    if (result.expectedValue !== target.expectedValue || result.unit !== target.unit) {
      return {
        code: 'REPRODUCTION_REPORT_INVALID',
        message: `metric result ${result.resultId} changes the plan's expected value or unit`,
      }
    }
  }

  if (reproduced && !runs.some(run => run.state === 'succeeded')) {
    return {
      code: 'REPRODUCTION_REPORT_INVALID',
      message: `${candidate.status} requires at least one succeeded run`,
    }
  }
  if (candidate.status === 'failed-with-diagnosis'
    && (candidate.diagnostics.length === 0
      || !runs.some(run => run.state === 'failed' || run.state === 'cancelled' || run.state === 'recovery-required'))) {
    return {
      code: 'REPRODUCTION_REPORT_INVALID',
      message: 'failed-with-diagnosis requires diagnostics and a failed terminal run',
    }
  }
  if (candidate.status.startsWith('blocked-')) {
    if (candidate.diagnostics.length === 0) {
      return {
        code: 'REPRODUCTION_REPORT_INVALID',
        message: 'blocked reproduction requires a verifiable diagnosis',
      }
    }
    const grounded = plan.missingMaterials.length > 0
      || plan.blockers.length > 0
      || baseline.blockers.length > 0
      || final.blockers.length > 0
      || candidate.diagnostics.some(diagnosis => (
        diagnosis.relatedRunIds.length > 0 || diagnosis.relatedArtifactIds.length > 0
      ))
    if (!grounded) {
      return {
        code: 'REPRODUCTION_REPORT_INVALID',
        message: 'blocked reproduction diagnosis is not grounded in a blocker, material, run, or Artifact',
      }
    }
  }
  if (candidate.necessaryModifications.length > 0 && baseline.sourceTreeDigest === final.sourceTreeDigest) {
    return {
      code: 'REPRODUCTION_REPORT_INVALID',
      message: 'necessary modifications are declared but the final source tree matches the baseline',
    }
  }
  if (candidate.status === 'exactly-reproduced') {
    if (baseline.sourceTreeDigest !== final.sourceTreeDigest
      || final.repository.dirty || candidate.necessaryModifications.length > 0) {
      return {
        code: 'REPRODUCTION_BASELINE_MODIFIED',
        message: 'exact reproduction cannot be claimed after source changes or necessary modifications',
      }
    }
  }
  if (candidate.status === 'metric-equivalent'
    && !candidate.metricResults.some(result => result.comparison === 'match' || result.comparison === 'within-tolerance')) {
    return {
      code: 'REPRODUCTION_REPORT_INVALID',
      message: 'metric-equivalent requires a matching metric result',
    }
  }
  for (const run of runs) {
    if (run.projectId !== plan.projectId
      || run.workspaceId !== plan.workspaceId
      || run.workspaceBindingVersion !== plan.workspaceBindingVersion
      || run.sourceTreeDigest !== final.sourceTreeDigest) {
      return {
        code: 'REPRODUCTION_REPORT_INVALID',
        message: 'a reported run is not bound to the final audited source tree',
      }
    }
    if (run.kind === 'local-test') {
      const bound = testSpecs.some(testSpec => testSpec.planId === plan.planId
        && testSpec.repositoryAuditId === final.auditId
        && testSpec.sourceTreeDigest === final.sourceTreeDigest
        && testSpec.specDigest === run.experimentSpecDigest)
      if (!bound) {
        return {
          code: 'REPRODUCTION_REPORT_INVALID',
          message: 'a reported local test is not bound to a registered TestSpec for the final audit',
        }
      }
    } else if (run.experimentSpecDigest !== plan.digest) {
      return {
        code: 'REPRODUCTION_REPORT_INVALID',
        message: 'a reported formal run is not bound to the ReproductionPlan digest',
      }
    }
  }
  return undefined
}

const DIGEST_SCHEMA = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' } as const
const ID_SCHEMA = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' } as const
const TEXT_SCHEMA = { type: 'string', minLength: 1 } as const
const NULLABLE_TEXT_SCHEMA = { type: ['string', 'null'], minLength: 1 } as const
const STRING_ARRAY_SCHEMA = { type: 'array', items: TEXT_SCHEMA } as const

const BLOCKER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: TEXT_SCHEMA,
    message: TEXT_SCHEMA,
    retryable: { type: 'boolean' },
  },
  required: ['code', 'message', 'retryable'],
} as const

const ARTIFACT_REF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    artifactId: TEXT_SCHEMA,
    digest: DIGEST_SCHEMA,
    kind: TEXT_SCHEMA,
  },
  required: ['artifactId', 'digest', 'kind'],
} as const

const REPOSITORY_CODE_LOCATOR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: TEXT_SCHEMA,
    lineStart: { type: 'integer', minimum: 1 },
    lineEnd: { type: 'integer', minimum: 1 },
    fileDigest: DIGEST_SCHEMA,
    lineDigest: DIGEST_SCHEMA,
  },
  required: ['path', 'lineStart', 'lineEnd', 'fileDigest', 'lineDigest'],
} as const

const METHOD_CODE_DELTA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    deltaId: ID_SCHEMA,
    evidenceId: TEXT_SCHEMA,
    paperStatement: TEXT_SCHEMA,
    classification: { type: 'string', enum: METHOD_CODE_DELTA_CLASSIFICATIONS },
    codeLocator: REPOSITORY_CODE_LOCATOR_SCHEMA,
    summary: TEXT_SCHEMA,
    likelyImpact: TEXT_SCHEMA,
    limitations: STRING_ARRAY_SCHEMA,
  },
  required: [
    'deltaId', 'evidenceId', 'paperStatement', 'classification', 'summary',
    'likelyImpact', 'limitations',
  ],
} as const

export const REPOSITORY_AUDIT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    auditId: ID_SCHEMA,
    projectId: TEXT_SCHEMA,
    workspaceId: TEXT_SCHEMA,
    workspaceBindingVersion: { type: 'integer', minimum: 1 },
    sourceId: TEXT_SCHEMA,
    sourceDigest: DIGEST_SCHEMA,
    repository: {
      type: 'object',
      additionalProperties: false,
      properties: {
        capability: {
          type: 'object',
          additionalProperties: false,
          properties: {
            providerId: { const: 'git-cli' },
            providerVersion: TEXT_SCHEMA,
            shell: { const: false },
            readOnlyCommands: { const: true },
            maxFiles: { type: 'integer', minimum: 1 },
            maxChanges: { type: 'integer', minimum: 1 },
            maxHashedBytes: { type: 'integer', minimum: 1 },
          },
          required: [
            'providerId', 'providerVersion', 'shell', 'readOnlyCommands',
            'maxFiles', 'maxChanges', 'maxHashedBytes',
          ],
        },
        canonicalRoot: TEXT_SCHEMA,
        gitDir: TEXT_SCHEMA,
        gitCommonDir: TEXT_SCHEMA,
        remoteUrl: NULLABLE_TEXT_SCHEMA,
        headCommit: NULLABLE_TEXT_SCHEMA,
        branch: NULLABLE_TEXT_SCHEMA,
        detached: { type: 'boolean' },
        tags: STRING_ARRAY_SCHEMA,
        targetRef: NULLABLE_TEXT_SCHEMA,
        targetCommit: NULLABLE_TEXT_SCHEMA,
        targetMatchesHead: { type: 'boolean' },
        dirty: { type: 'boolean' },
        changes: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              status: TEXT_SCHEMA,
              path: TEXT_SCHEMA,
              digest: DIGEST_SCHEMA,
              size: { type: 'integer', minimum: 0 },
            },
            required: ['status', 'path'],
          },
        },
      },
      required: [
        'capability', 'canonicalRoot', 'gitDir', 'gitCommonDir', 'remoteUrl',
        'headCommit', 'branch', 'detached', 'tags', 'targetRef', 'targetCommit',
        'targetMatchesHead', 'dirty', 'changes',
      ],
    },
    sourceTreeDigest: DIGEST_SCHEMA,
    languages: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { language: TEXT_SCHEMA, fileCount: { type: 'integer', minimum: 1 } },
        required: ['language', 'fileCount'],
      },
    },
    buildSystems: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: { name: TEXT_SCHEMA, manifestPaths: STRING_ARRAY_SCHEMA },
        required: ['name', 'manifestPaths'],
      },
    },
    entryPoints: STRING_ARRAY_SCHEMA,
    configurationFiles: STRING_ARRAY_SCHEMA,
    dataDependencyPaths: STRING_ARRAY_SCHEMA,
    environmentFiles: STRING_ARRAY_SCHEMA,
    testPaths: STRING_ARRAY_SCHEMA,
    methodCodeDeltas: { type: 'array', items: METHOD_CODE_DELTA_SCHEMA },
    blockers: { type: 'array', items: BLOCKER_SCHEMA },
    auditedAt: { type: 'string', format: 'date-time' },
    digest: DIGEST_SCHEMA,
  },
  required: [
    'schemaVersion', 'auditId', 'projectId', 'workspaceId', 'workspaceBindingVersion',
    'sourceId', 'sourceDigest', 'repository', 'sourceTreeDigest', 'languages',
    'buildSystems', 'entryPoints', 'configurationFiles', 'dataDependencyPaths',
    'environmentFiles', 'testPaths', 'methodCodeDeltas', 'blockers', 'auditedAt', 'digest',
  ],
})

const TARGET_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    resultId: ID_SCHEMA,
    description: TEXT_SCHEMA,
    metric: TEXT_SCHEMA,
    expectedValue: NULLABLE_TEXT_SCHEMA,
    unit: NULLABLE_TEXT_SCHEMA,
    evidenceId: NULLABLE_TEXT_SCHEMA,
  },
  required: ['resultId', 'description', 'metric', 'expectedValue', 'unit', 'evidenceId'],
} as const

const PLAN_STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    stepId: ID_SCHEMA,
    kind: { type: 'string', enum: ['inspect', 'modify', 'test', 'formal-run', 'compare'] },
    description: TEXT_SCHEMA,
    expectedOutputs: STRING_ARRAY_SCHEMA,
  },
  required: ['stepId', 'kind', 'description', 'expectedOutputs'],
} as const

const TOLERANCE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    resultId: ID_SCHEMA,
    absolute: { type: ['number', 'null'], minimum: 0 },
    relative: { type: ['number', 'null'], minimum: 0 },
  },
  required: ['resultId', 'absolute', 'relative'],
} as const

export const REPRODUCTION_PLAN_BODY_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    planId: ID_SCHEMA,
    sourceId: TEXT_SCHEMA,
    repositoryAuditId: TEXT_SCHEMA,
    targetRepository: {
      type: 'object',
      additionalProperties: false,
      properties: { remoteUrl: NULLABLE_TEXT_SCHEMA, commit: TEXT_SCHEMA },
      required: ['remoteUrl', 'commit'],
    },
    targetData: STRING_ARRAY_SCHEMA,
    targetResults: { type: 'array', items: TARGET_RESULT_SCHEMA },
    scope: { type: 'string', enum: REPRODUCTION_SCOPES },
    environmentRequirements: STRING_ARRAY_SCHEMA,
    missingMaterials: STRING_ARRAY_SCHEMA,
    steps: { type: 'array', minItems: 1, items: PLAN_STEP_SCHEMA },
    expectedOutputs: STRING_ARRAY_SCHEMA,
    tolerances: { type: 'array', items: TOLERANCE_SCHEMA },
    blockers: { type: 'array', items: BLOCKER_SCHEMA },
  },
  required: [
    'schemaVersion', 'planId', 'sourceId', 'repositoryAuditId', 'targetRepository',
    'targetData', 'targetResults', 'scope', 'environmentRequirements',
    'missingMaterials', 'steps', 'expectedOutputs', 'tolerances', 'blockers',
  ],
})

export const REPRODUCTION_PLAN_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  ...REPRODUCTION_PLAN_BODY_SCHEMA,
  properties: {
    ...(REPRODUCTION_PLAN_BODY_SCHEMA.properties as Record<string, unknown>),
    projectId: TEXT_SCHEMA,
    workspaceId: TEXT_SCHEMA,
    workspaceBindingVersion: { type: 'integer', minimum: 1 },
    repositoryAuditDigest: DIGEST_SCHEMA,
    sourceTreeDigest: DIGEST_SCHEMA,
    status: { const: 'candidate' },
    createdAt: { type: 'string', format: 'date-time' },
    digest: DIGEST_SCHEMA,
  },
  required: [
    ...(REPRODUCTION_PLAN_BODY_SCHEMA.required as readonly string[]),
    'projectId', 'workspaceId', 'workspaceBindingVersion', 'repositoryAuditDigest',
    'sourceTreeDigest', 'status', 'createdAt', 'digest',
  ],
})

const TEST_SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    testSpecId: ID_SCHEMA,
    runner: {
      type: 'string',
      enum: ['package-script', 'pytest', 'vitest', 'jest', 'tsc', 'eslint', 'ruff', 'mypy', 'smoke'],
    },
    argv: { type: 'array', minItems: 1, items: { type: 'string' } },
    cwdRelative: TEXT_SCHEMA,
    timeoutMs: { type: 'integer', minimum: 1 },
    graceMs: { type: 'integer', minimum: 1 },
    environment: { type: 'object', additionalProperties: { type: 'string' } },
  },
  required: [
    'schemaVersion', 'testSpecId', 'runner', 'argv', 'cwdRelative',
    'timeoutMs', 'graceMs', 'environment',
  ],
} as const

export const REPRODUCTION_TEST_SPEC_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    projectId: TEXT_SCHEMA,
    workspaceId: TEXT_SCHEMA,
    workspaceBindingVersion: { type: 'integer', minimum: 1 },
    planId: TEXT_SCHEMA,
    repositoryAuditId: TEXT_SCHEMA,
    sourceTreeDigest: DIGEST_SCHEMA,
    spec: TEST_SPEC_SCHEMA,
    specDigest: DIGEST_SCHEMA,
    registeredAt: { type: 'string', format: 'date-time' },
    digest: DIGEST_SCHEMA,
  },
  required: [
    'schemaVersion', 'projectId', 'workspaceId', 'workspaceBindingVersion',
    'planId', 'repositoryAuditId', 'sourceTreeDigest', 'spec', 'specDigest',
    'registeredAt', 'digest',
  ],
})

const METRIC_RESULT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    resultId: ID_SCHEMA,
    expectedValue: NULLABLE_TEXT_SCHEMA,
    observedValue: NULLABLE_TEXT_SCHEMA,
    unit: NULLABLE_TEXT_SCHEMA,
    comparison: { type: 'string', enum: ['match', 'within-tolerance', 'different', 'unavailable'] },
  },
  required: ['resultId', 'expectedValue', 'observedValue', 'unit', 'comparison'],
} as const

const MODIFICATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { path: TEXT_SCHEMA, description: TEXT_SCHEMA, reason: TEXT_SCHEMA },
  required: ['path', 'description', 'reason'],
} as const

const DIAGNOSIS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: TEXT_SCHEMA,
    message: TEXT_SCHEMA,
    relatedRunIds: STRING_ARRAY_SCHEMA,
    relatedArtifactIds: STRING_ARRAY_SCHEMA,
  },
  required: ['code', 'message', 'relatedRunIds', 'relatedArtifactIds'],
} as const

export const REPRODUCTION_REPORT_CANDIDATE_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    kind: { const: 'reproduction-report' },
    planId: TEXT_SCHEMA,
    baselineAuditId: TEXT_SCHEMA,
    finalAuditId: TEXT_SCHEMA,
    runIds: STRING_ARRAY_SCHEMA,
    status: { type: 'string', enum: REPRODUCTION_STATUSES },
    metricResults: { type: 'array', items: METRIC_RESULT_SCHEMA },
    paperDescription: TEXT_SCHEMA,
    officialCodeBehavior: TEXT_SCHEMA,
    localImplementationAndEnvironment: TEXT_SCHEMA,
    necessaryModifications: { type: 'array', items: MODIFICATION_SCHEMA },
    resultDifferences: STRING_ARRAY_SCHEMA,
    differenceSources: STRING_ARRAY_SCHEMA,
    unresolvedDetails: STRING_ARRAY_SCHEMA,
    diagnostics: { type: 'array', items: DIAGNOSIS_SCHEMA },
    limitations: STRING_ARRAY_SCHEMA,
  },
  required: [
    'schemaVersion', 'kind', 'planId', 'baselineAuditId', 'finalAuditId', 'runIds',
    'status', 'metricResults', 'paperDescription', 'officialCodeBehavior',
    'localImplementationAndEnvironment', 'necessaryModifications', 'resultDifferences',
    'differenceSources', 'unresolvedDetails', 'diagnostics', 'limitations',
  ],
})

export const REPRODUCTION_REPORT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  ...REPRODUCTION_REPORT_CANDIDATE_SCHEMA,
  properties: {
    ...(REPRODUCTION_REPORT_CANDIDATE_SCHEMA.properties as Record<string, unknown>),
    reportId: ID_SCHEMA,
    projectId: TEXT_SCHEMA,
    workspaceId: TEXT_SCHEMA,
    workspaceBindingVersion: { type: 'integer', minimum: 1 },
    planDigest: DIGEST_SCHEMA,
    baselineAuditDigest: DIGEST_SCHEMA,
    finalAuditDigest: DIGEST_SCHEMA,
    reportArtifact: ARTIFACT_REF_SCHEMA,
    reviewStatus: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'needs-review'] },
    committedAt: { type: 'string', format: 'date-time' },
    digest: DIGEST_SCHEMA,
  },
  required: [
    ...(REPRODUCTION_REPORT_CANDIDATE_SCHEMA.required as readonly string[]),
    'reportId', 'projectId', 'workspaceId', 'workspaceBindingVersion', 'planDigest',
    'baselineAuditDigest', 'finalAuditDigest', 'reportArtifact', 'reviewStatus',
    'committedAt', 'digest',
  ],
})

export function parseRepositoryAudit(value: unknown): RepositoryAudit {
  const record = exactRecord(value, 'RepositoryAudit', [
    'schemaVersion', 'auditId', 'projectId', 'workspaceId', 'workspaceBindingVersion',
    'sourceId', 'sourceDigest', 'repository', 'sourceTreeDigest', 'languages',
    'buildSystems', 'entryPoints', 'configurationFiles', 'dataDependencyPaths',
    'environmentFiles', 'testPaths', 'methodCodeDeltas', 'blockers', 'auditedAt', 'digest',
  ])
  if (record.schemaVersion !== 1) throw new TypeError('RepositoryAudit.schemaVersion must be 1')
  const repository = exactRecord(record.repository, 'RepositoryAudit.repository', [
    'capability', 'canonicalRoot', 'gitDir', 'gitCommonDir', 'remoteUrl', 'headCommit',
    'branch', 'detached', 'tags', 'targetRef', 'targetCommit', 'targetMatchesHead',
    'dirty', 'changes',
  ])
  const capability = exactRecord(repository.capability, 'RepositoryAudit.repository.capability', [
    'providerId', 'providerVersion', 'shell', 'readOnlyCommands', 'maxFiles',
    'maxChanges', 'maxHashedBytes',
  ])
  if (capability.providerId !== 'git-cli' || capability.shell !== false || capability.readOnlyCommands !== true) {
    throw new TypeError('RepositoryAudit repository capability is invalid')
  }
  const audit: RepositoryAudit = {
    schemaVersion: 1,
    auditId: id(record.auditId, 'RepositoryAudit.auditId'),
    projectId: text(record.projectId, 'RepositoryAudit.projectId'),
    workspaceId: text(record.workspaceId, 'RepositoryAudit.workspaceId'),
    workspaceBindingVersion: positiveInteger(record.workspaceBindingVersion, 'RepositoryAudit.workspaceBindingVersion'),
    sourceId: text(record.sourceId, 'RepositoryAudit.sourceId'),
    sourceDigest: digest(record.sourceDigest, 'RepositoryAudit.sourceDigest'),
    repository: {
      capability: {
        providerId: 'git-cli',
        providerVersion: text(capability.providerVersion, 'RepositoryAudit.repository.capability.providerVersion'),
        shell: false,
        readOnlyCommands: true,
        maxFiles: positiveInteger(capability.maxFiles, 'RepositoryAudit.repository.capability.maxFiles'),
        maxChanges: positiveInteger(capability.maxChanges, 'RepositoryAudit.repository.capability.maxChanges'),
        maxHashedBytes: positiveInteger(capability.maxHashedBytes, 'RepositoryAudit.repository.capability.maxHashedBytes'),
      },
      canonicalRoot: text(repository.canonicalRoot, 'RepositoryAudit.repository.canonicalRoot'),
      gitDir: text(repository.gitDir, 'RepositoryAudit.repository.gitDir'),
      gitCommonDir: text(repository.gitCommonDir, 'RepositoryAudit.repository.gitCommonDir'),
      remoteUrl: nullableText(repository.remoteUrl, 'RepositoryAudit.repository.remoteUrl'),
      headCommit: nullableText(repository.headCommit, 'RepositoryAudit.repository.headCommit'),
      branch: nullableText(repository.branch, 'RepositoryAudit.repository.branch'),
      detached: booleanValue(repository.detached, 'RepositoryAudit.repository.detached'),
      tags: stringArray(repository.tags, 'RepositoryAudit.repository.tags'),
      targetRef: nullableText(repository.targetRef, 'RepositoryAudit.repository.targetRef'),
      targetCommit: nullableText(repository.targetCommit, 'RepositoryAudit.repository.targetCommit'),
      targetMatchesHead: booleanValue(repository.targetMatchesHead, 'RepositoryAudit.repository.targetMatchesHead'),
      dirty: booleanValue(repository.dirty, 'RepositoryAudit.repository.dirty'),
      changes: objectArray(repository.changes, 'RepositoryAudit.repository.changes').map((item, index) => {
        const change = exactRecord(item, `RepositoryAudit.repository.changes[${index}]`, ['status', 'path', 'digest', 'size'])
        return {
          status: text(change.status, `RepositoryAudit.repository.changes[${index}].status`),
          path: relativePath(change.path, `RepositoryAudit.repository.changes[${index}].path`),
          ...(change.digest === undefined ? {} : { digest: digest(change.digest, `RepositoryAudit.repository.changes[${index}].digest`) }),
          ...(change.size === undefined ? {} : { size: nonNegativeInteger(change.size, `RepositoryAudit.repository.changes[${index}].size`) }),
        }
      }),
    },
    sourceTreeDigest: digest(record.sourceTreeDigest, 'RepositoryAudit.sourceTreeDigest'),
    languages: objectArray(record.languages, 'RepositoryAudit.languages').map((item, index) => {
      const language = exactRecord(item, `RepositoryAudit.languages[${index}]`, ['language', 'fileCount'])
      return {
        language: text(language.language, `RepositoryAudit.languages[${index}].language`),
        fileCount: positiveInteger(language.fileCount, `RepositoryAudit.languages[${index}].fileCount`),
      }
    }),
    buildSystems: objectArray(record.buildSystems, 'RepositoryAudit.buildSystems').map((item, index) => {
      const system = exactRecord(item, `RepositoryAudit.buildSystems[${index}]`, ['name', 'manifestPaths'])
      return {
        name: text(system.name, `RepositoryAudit.buildSystems[${index}].name`),
        manifestPaths: stringArray(system.manifestPaths, `RepositoryAudit.buildSystems[${index}].manifestPaths`)
          .map((path, pathIndex) => relativePath(path, `RepositoryAudit.buildSystems[${index}].manifestPaths[${pathIndex}]`)),
      }
    }),
    entryPoints: relativePathArray(record.entryPoints, 'RepositoryAudit.entryPoints'),
    configurationFiles: relativePathArray(record.configurationFiles, 'RepositoryAudit.configurationFiles'),
    dataDependencyPaths: relativePathArray(record.dataDependencyPaths, 'RepositoryAudit.dataDependencyPaths'),
    environmentFiles: relativePathArray(record.environmentFiles, 'RepositoryAudit.environmentFiles'),
    testPaths: relativePathArray(record.testPaths, 'RepositoryAudit.testPaths'),
    methodCodeDeltas: objectArray(record.methodCodeDeltas, 'RepositoryAudit.methodCodeDeltas')
      .map((item, index) => parseMethodCodeDelta(item, `RepositoryAudit.methodCodeDeltas[${index}]`)),
    blockers: objectArray(record.blockers, 'RepositoryAudit.blockers')
      .map((item, index) => parseBlocker(item, `RepositoryAudit.blockers[${index}]`)),
    auditedAt: utc(record.auditedAt, 'RepositoryAudit.auditedAt'),
    digest: digest(record.digest, 'RepositoryAudit.digest'),
  }
  assertUnique(audit.repository.tags, 'RepositoryAudit.repository.tags')
  assertUnique(audit.methodCodeDeltas.map(delta => delta.deltaId), 'RepositoryAudit.methodCodeDeltas deltaId')
  return audit
}

export function parseReproductionPlanBody(value: unknown): ReproductionPlanBody {
  const record = exactRecord(value, 'ReproductionPlanBody', [
    'schemaVersion', 'planId', 'sourceId', 'repositoryAuditId', 'targetRepository',
    'targetData', 'targetResults', 'scope', 'environmentRequirements',
    'missingMaterials', 'steps', 'expectedOutputs', 'tolerances', 'blockers',
  ])
  if (record.schemaVersion !== 1) throw new TypeError('ReproductionPlanBody.schemaVersion must be 1')
  const targetRepository = exactRecord(record.targetRepository, 'ReproductionPlanBody.targetRepository', ['remoteUrl', 'commit'])
  const scope = enumValue(record.scope, REPRODUCTION_SCOPES, 'ReproductionPlanBody.scope')
  const body: ReproductionPlanBody = {
    schemaVersion: 1,
    planId: id(record.planId, 'ReproductionPlanBody.planId'),
    sourceId: text(record.sourceId, 'ReproductionPlanBody.sourceId'),
    repositoryAuditId: text(record.repositoryAuditId, 'ReproductionPlanBody.repositoryAuditId'),
    targetRepository: {
      remoteUrl: nullableText(targetRepository.remoteUrl, 'ReproductionPlanBody.targetRepository.remoteUrl'),
      commit: text(targetRepository.commit, 'ReproductionPlanBody.targetRepository.commit'),
    },
    targetData: stringArray(record.targetData, 'ReproductionPlanBody.targetData'),
    targetResults: objectArray(record.targetResults, 'ReproductionPlanBody.targetResults').map((item, index) => {
      const result = exactRecord(item, `ReproductionPlanBody.targetResults[${index}]`, [
        'resultId', 'description', 'metric', 'expectedValue', 'unit', 'evidenceId',
      ])
      return {
        resultId: id(result.resultId, `ReproductionPlanBody.targetResults[${index}].resultId`),
        description: text(result.description, `ReproductionPlanBody.targetResults[${index}].description`),
        metric: text(result.metric, `ReproductionPlanBody.targetResults[${index}].metric`),
        expectedValue: nullableText(result.expectedValue, `ReproductionPlanBody.targetResults[${index}].expectedValue`),
        unit: nullableText(result.unit, `ReproductionPlanBody.targetResults[${index}].unit`),
        evidenceId: nullableText(result.evidenceId, `ReproductionPlanBody.targetResults[${index}].evidenceId`),
      }
    }),
    scope,
    environmentRequirements: stringArray(record.environmentRequirements, 'ReproductionPlanBody.environmentRequirements'),
    missingMaterials: stringArray(record.missingMaterials, 'ReproductionPlanBody.missingMaterials'),
    steps: objectArray(record.steps, 'ReproductionPlanBody.steps').map((item, index) => {
      const step = exactRecord(item, `ReproductionPlanBody.steps[${index}]`, [
        'stepId', 'kind', 'description', 'expectedOutputs',
      ])
      return {
        stepId: id(step.stepId, `ReproductionPlanBody.steps[${index}].stepId`),
        kind: enumValue(step.kind, ['inspect', 'modify', 'test', 'formal-run', 'compare'] as const, `ReproductionPlanBody.steps[${index}].kind`),
        description: text(step.description, `ReproductionPlanBody.steps[${index}].description`),
        expectedOutputs: stringArray(step.expectedOutputs, `ReproductionPlanBody.steps[${index}].expectedOutputs`),
      }
    }),
    expectedOutputs: stringArray(record.expectedOutputs, 'ReproductionPlanBody.expectedOutputs'),
    tolerances: objectArray(record.tolerances, 'ReproductionPlanBody.tolerances').map((item, index) => {
      const tolerance = exactRecord(item, `ReproductionPlanBody.tolerances[${index}]`, ['resultId', 'absolute', 'relative'])
      const absolute = nullableNonNegativeNumber(tolerance.absolute, `ReproductionPlanBody.tolerances[${index}].absolute`)
      const relative = nullableNonNegativeNumber(tolerance.relative, `ReproductionPlanBody.tolerances[${index}].relative`)
      if (absolute === null && relative === null) throw new TypeError('ReproductionPlan tolerance requires absolute or relative')
      return { resultId: id(tolerance.resultId, `ReproductionPlanBody.tolerances[${index}].resultId`), absolute, relative }
    }),
    blockers: objectArray(record.blockers, 'ReproductionPlanBody.blockers')
      .map((item, index) => parseBlocker(item, `ReproductionPlanBody.blockers[${index}]`)),
  }
  if (body.steps.length === 0) throw new TypeError('ReproductionPlanBody.steps must not be empty')
  assertUnique(body.targetResults.map(result => result.resultId), 'ReproductionPlanBody.targetResults resultId')
  assertUnique(body.steps.map(step => step.stepId), 'ReproductionPlanBody.steps stepId')
  assertUnique(body.tolerances.map(tolerance => tolerance.resultId), 'ReproductionPlanBody.tolerances resultId')
  const resultIds = new Set(body.targetResults.map(result => result.resultId))
  if (body.tolerances.some(tolerance => !resultIds.has(tolerance.resultId))) {
    throw new TypeError('ReproductionPlan tolerance references an unknown resultId')
  }
  return body
}

export function parseReproductionPlan(value: unknown): ReproductionPlan {
  const record = exactRecord(value, 'ReproductionPlan', [
    'schemaVersion', 'planId', 'sourceId', 'repositoryAuditId', 'targetRepository',
    'targetData', 'targetResults', 'scope', 'environmentRequirements',
    'missingMaterials', 'steps', 'expectedOutputs', 'tolerances', 'blockers',
    'projectId', 'workspaceId', 'workspaceBindingVersion', 'repositoryAuditDigest',
    'sourceTreeDigest', 'status', 'createdAt', 'digest',
  ])
  const body = parseReproductionPlanBody(Object.fromEntries(
    Object.entries(record).filter(([key]) => ![
      'projectId', 'workspaceId', 'workspaceBindingVersion', 'repositoryAuditDigest',
      'sourceTreeDigest', 'status', 'createdAt', 'digest',
    ].includes(key)),
  ))
  if (record.status !== 'candidate') throw new TypeError('ReproductionPlan.status must be candidate')
  return {
    ...body,
    projectId: text(record.projectId, 'ReproductionPlan.projectId'),
    workspaceId: text(record.workspaceId, 'ReproductionPlan.workspaceId'),
    workspaceBindingVersion: positiveInteger(record.workspaceBindingVersion, 'ReproductionPlan.workspaceBindingVersion'),
    repositoryAuditDigest: digest(record.repositoryAuditDigest, 'ReproductionPlan.repositoryAuditDigest'),
    sourceTreeDigest: digest(record.sourceTreeDigest, 'ReproductionPlan.sourceTreeDigest'),
    status: 'candidate',
    createdAt: utc(record.createdAt, 'ReproductionPlan.createdAt'),
    digest: digest(record.digest, 'ReproductionPlan.digest'),
  }
}

export function parseReproductionTestSpecRecord(value: unknown): ReproductionTestSpecRecord {
  const record = exactRecord(value, 'ReproductionTestSpecRecord', [
    'schemaVersion', 'projectId', 'workspaceId', 'workspaceBindingVersion',
    'planId', 'repositoryAuditId', 'sourceTreeDigest', 'spec', 'specDigest',
    'registeredAt', 'digest',
  ])
  if (record.schemaVersion !== 1) throw new TypeError('ReproductionTestSpecRecord.schemaVersion must be 1')
  const spec = parseTestSpecShape(record.spec)
  return {
    schemaVersion: 1,
    projectId: text(record.projectId, 'ReproductionTestSpecRecord.projectId'),
    workspaceId: text(record.workspaceId, 'ReproductionTestSpecRecord.workspaceId'),
    workspaceBindingVersion: positiveInteger(record.workspaceBindingVersion, 'ReproductionTestSpecRecord.workspaceBindingVersion'),
    planId: text(record.planId, 'ReproductionTestSpecRecord.planId'),
    repositoryAuditId: text(record.repositoryAuditId, 'ReproductionTestSpecRecord.repositoryAuditId'),
    sourceTreeDigest: digest(record.sourceTreeDigest, 'ReproductionTestSpecRecord.sourceTreeDigest'),
    spec,
    specDigest: digest(record.specDigest, 'ReproductionTestSpecRecord.specDigest'),
    registeredAt: utc(record.registeredAt, 'ReproductionTestSpecRecord.registeredAt'),
    digest: digest(record.digest, 'ReproductionTestSpecRecord.digest'),
  }
}

export function parseReproductionReportCandidate(value: unknown): ReproductionReportCandidate {
  const record = exactRecord(value, 'ReproductionReportCandidate', [
    'schemaVersion', 'kind', 'planId', 'baselineAuditId', 'finalAuditId', 'runIds',
    'status', 'metricResults', 'paperDescription', 'officialCodeBehavior',
    'localImplementationAndEnvironment', 'necessaryModifications', 'resultDifferences',
    'differenceSources', 'unresolvedDetails', 'diagnostics', 'limitations',
  ])
  if (record.schemaVersion !== 1 || record.kind !== 'reproduction-report') {
    throw new TypeError('ReproductionReportCandidate header is invalid')
  }
  const candidate: ReproductionReportCandidate = {
    schemaVersion: 1,
    kind: 'reproduction-report',
    planId: text(record.planId, 'ReproductionReportCandidate.planId'),
    baselineAuditId: text(record.baselineAuditId, 'ReproductionReportCandidate.baselineAuditId'),
    finalAuditId: text(record.finalAuditId, 'ReproductionReportCandidate.finalAuditId'),
    runIds: stringArray(record.runIds, 'ReproductionReportCandidate.runIds'),
    status: enumValue(record.status, REPRODUCTION_STATUSES, 'ReproductionReportCandidate.status'),
    metricResults: objectArray(record.metricResults, 'ReproductionReportCandidate.metricResults').map((item, index) => {
      const result = exactRecord(item, `ReproductionReportCandidate.metricResults[${index}]`, [
        'resultId', 'expectedValue', 'observedValue', 'unit', 'comparison',
      ])
      return {
        resultId: id(result.resultId, `ReproductionReportCandidate.metricResults[${index}].resultId`),
        expectedValue: nullableText(result.expectedValue, `ReproductionReportCandidate.metricResults[${index}].expectedValue`),
        observedValue: nullableText(result.observedValue, `ReproductionReportCandidate.metricResults[${index}].observedValue`),
        unit: nullableText(result.unit, `ReproductionReportCandidate.metricResults[${index}].unit`),
        comparison: enumValue(
          result.comparison,
          ['match', 'within-tolerance', 'different', 'unavailable'] as const,
          `ReproductionReportCandidate.metricResults[${index}].comparison`,
        ),
      }
    }),
    paperDescription: text(record.paperDescription, 'ReproductionReportCandidate.paperDescription'),
    officialCodeBehavior: text(record.officialCodeBehavior, 'ReproductionReportCandidate.officialCodeBehavior'),
    localImplementationAndEnvironment: text(record.localImplementationAndEnvironment, 'ReproductionReportCandidate.localImplementationAndEnvironment'),
    necessaryModifications: objectArray(record.necessaryModifications, 'ReproductionReportCandidate.necessaryModifications')
      .map((item, index) => {
        const modification = exactRecord(item, `ReproductionReportCandidate.necessaryModifications[${index}]`, [
          'path', 'description', 'reason',
        ])
        return {
          path: relativePath(modification.path, `ReproductionReportCandidate.necessaryModifications[${index}].path`),
          description: text(modification.description, `ReproductionReportCandidate.necessaryModifications[${index}].description`),
          reason: text(modification.reason, `ReproductionReportCandidate.necessaryModifications[${index}].reason`),
        }
      }),
    resultDifferences: stringArray(record.resultDifferences, 'ReproductionReportCandidate.resultDifferences'),
    differenceSources: stringArray(record.differenceSources, 'ReproductionReportCandidate.differenceSources'),
    unresolvedDetails: stringArray(record.unresolvedDetails, 'ReproductionReportCandidate.unresolvedDetails'),
    diagnostics: objectArray(record.diagnostics, 'ReproductionReportCandidate.diagnostics').map((item, index) => {
      const diagnosis = exactRecord(item, `ReproductionReportCandidate.diagnostics[${index}]`, [
        'code', 'message', 'relatedRunIds', 'relatedArtifactIds',
      ])
      return {
        code: text(diagnosis.code, `ReproductionReportCandidate.diagnostics[${index}].code`),
        message: text(diagnosis.message, `ReproductionReportCandidate.diagnostics[${index}].message`),
        relatedRunIds: stringArray(diagnosis.relatedRunIds, `ReproductionReportCandidate.diagnostics[${index}].relatedRunIds`),
        relatedArtifactIds: stringArray(diagnosis.relatedArtifactIds, `ReproductionReportCandidate.diagnostics[${index}].relatedArtifactIds`),
      }
    }),
    limitations: stringArray(record.limitations, 'ReproductionReportCandidate.limitations'),
  }
  assertUnique(candidate.runIds, 'ReproductionReportCandidate.runIds')
  assertUnique(candidate.metricResults.map(result => result.resultId), 'ReproductionReportCandidate.metricResults resultId')
  return candidate
}

export function parseReproductionReport(value: unknown): ReproductionReport {
  const record = exactRecord(value, 'ReproductionReport', [
    'schemaVersion', 'kind', 'planId', 'baselineAuditId', 'finalAuditId', 'runIds',
    'status', 'metricResults', 'paperDescription', 'officialCodeBehavior',
    'localImplementationAndEnvironment', 'necessaryModifications', 'resultDifferences',
    'differenceSources', 'unresolvedDetails', 'diagnostics', 'limitations',
    'reportId', 'projectId', 'workspaceId', 'workspaceBindingVersion', 'planDigest',
    'baselineAuditDigest', 'finalAuditDigest', 'reportArtifact', 'reviewStatus',
    'committedAt', 'digest',
  ])
  const candidate = parseReproductionReportCandidate(Object.fromEntries(
    Object.entries(record).filter(([key]) => ![
      'reportId', 'projectId', 'workspaceId', 'workspaceBindingVersion', 'planDigest',
      'baselineAuditDigest', 'finalAuditDigest', 'reportArtifact', 'reviewStatus',
      'committedAt', 'digest',
    ].includes(key)),
  ))
  const reviewStatus = enumValue(
    record.reviewStatus,
    ['pending', 'accepted', 'rejected', 'needs-review'] as const,
    'ReproductionReport.reviewStatus',
  )
  const artifact = exactRecord(record.reportArtifact, 'ReproductionReport.reportArtifact', ['artifactId', 'digest', 'kind'])
  return {
    ...candidate,
    reportId: id(record.reportId, 'ReproductionReport.reportId'),
    projectId: text(record.projectId, 'ReproductionReport.projectId'),
    workspaceId: text(record.workspaceId, 'ReproductionReport.workspaceId'),
    workspaceBindingVersion: positiveInteger(record.workspaceBindingVersion, 'ReproductionReport.workspaceBindingVersion'),
    planDigest: digest(record.planDigest, 'ReproductionReport.planDigest'),
    baselineAuditDigest: digest(record.baselineAuditDigest, 'ReproductionReport.baselineAuditDigest'),
    finalAuditDigest: digest(record.finalAuditDigest, 'ReproductionReport.finalAuditDigest'),
    reportArtifact: {
      artifactId: text(artifact.artifactId, 'ReproductionReport.reportArtifact.artifactId'),
      digest: digest(artifact.digest, 'ReproductionReport.reportArtifact.digest'),
      kind: text(artifact.kind, 'ReproductionReport.reportArtifact.kind'),
    },
    reviewStatus,
    committedAt: utc(record.committedAt, 'ReproductionReport.committedAt'),
    digest: digest(record.digest, 'ReproductionReport.digest'),
  }
}

function parseTestSpecShape(value: unknown): TestSpec {
  const record = exactRecord(value, 'TestSpec', [
    'schemaVersion', 'testSpecId', 'runner', 'argv', 'cwdRelative', 'timeoutMs',
    'graceMs', 'environment',
  ])
  if (record.schemaVersion !== 1) throw new TypeError('TestSpec.schemaVersion must be 1')
  const runner = enumValue(
    record.runner,
    ['package-script', 'pytest', 'vitest', 'jest', 'tsc', 'eslint', 'ruff', 'mypy', 'smoke'] as const,
    'TestSpec.runner',
  )
  const environment = exactRecord(record.environment, 'TestSpec.environment', Object.keys(objectRecord(record.environment, 'TestSpec.environment')))
  return {
    schemaVersion: 1,
    testSpecId: id(record.testSpecId, 'TestSpec.testSpecId'),
    runner,
    argv: stringArray(record.argv, 'TestSpec.argv', true),
    cwdRelative: relativePath(record.cwdRelative, 'TestSpec.cwdRelative'),
    timeoutMs: positiveInteger(record.timeoutMs, 'TestSpec.timeoutMs'),
    graceMs: positiveInteger(record.graceMs, 'TestSpec.graceMs'),
    environment: Object.fromEntries(Object.entries(environment).map(([key, item]) => [key, textAllowEmpty(item, `TestSpec.environment.${key}`)])),
  }
}

function parseMethodCodeDelta(value: unknown, field: string): MethodCodeDelta {
  const record = exactRecord(value, field, [
    'deltaId', 'evidenceId', 'paperStatement', 'classification', 'codeLocator',
    'summary', 'likelyImpact', 'limitations',
  ])
  const locator = record.codeLocator === undefined ? undefined : parseCodeLocator(record.codeLocator, `${field}.codeLocator`)
  return {
    deltaId: id(record.deltaId, `${field}.deltaId`),
    evidenceId: text(record.evidenceId, `${field}.evidenceId`),
    paperStatement: text(record.paperStatement, `${field}.paperStatement`),
    classification: enumValue(record.classification, METHOD_CODE_DELTA_CLASSIFICATIONS, `${field}.classification`),
    ...(locator === undefined ? {} : { codeLocator: locator }),
    summary: text(record.summary, `${field}.summary`),
    likelyImpact: text(record.likelyImpact, `${field}.likelyImpact`),
    limitations: stringArray(record.limitations, `${field}.limitations`),
  }
}

function parseCodeLocator(value: unknown, field: string): RepositoryCodeLocator {
  const record = exactRecord(value, field, ['path', 'lineStart', 'lineEnd', 'fileDigest', 'lineDigest'])
  const lineStart = positiveInteger(record.lineStart, `${field}.lineStart`)
  const lineEnd = positiveInteger(record.lineEnd, `${field}.lineEnd`)
  if (lineEnd < lineStart) throw new TypeError(`${field}.lineEnd must be at least lineStart`)
  return {
    path: relativePath(record.path, `${field}.path`),
    lineStart,
    lineEnd,
    fileDigest: digest(record.fileDigest, `${field}.fileDigest`),
    lineDigest: digest(record.lineDigest, `${field}.lineDigest`),
  }
}

function parseBlocker(value: unknown, field: string): ReproductionBlocker {
  const record = exactRecord(value, field, ['code', 'message', 'retryable'])
  return {
    code: text(record.code, `${field}.code`),
    message: text(record.message, `${field}.message`),
    retryable: booleanValue(record.retryable, `${field}.retryable`),
  }
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

function textAllowEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new TypeError(`${field} must be NUL-free text`)
  return value
}

function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field)
}

function id(value: unknown, field: string): string {
  const result = text(value, field)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(result)) throw new TypeError(`${field} is not a valid identifier`)
  return result
}

function digest(value: unknown, field: string): Sha256Digest {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) throw new TypeError(`${field} must be a SHA-256 digest`)
  return value as Sha256Digest
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive safe integer`)
  return value as number
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${field} must be a non-negative safe integer`)
  return value as number
}

function nullableNonNegativeNumber(value: unknown, field: string): number | null {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new TypeError(`${field} must be null or a non-negative number`)
  return value
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be boolean`)
  return value
}

function utc(value: unknown, field: string): string {
  const result = text(value, field)
  const parsed = new Date(result)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== result) throw new TypeError(`${field} must be canonical UTC`)
  return result
}

function stringArray(value: unknown, field: string, allowEmpty = false): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  return value.map((item, index) => allowEmpty ? textAllowEmpty(item, `${field}[${index}]`) : text(item, `${field}[${index}]`))
}

function relativePathArray(value: unknown, field: string): string[] {
  return stringArray(value, field).map((path, index) => relativePath(path, `${field}[${index}]`))
}

function relativePath(value: unknown, field: string): string {
  const path = text(value, field).replaceAll('\\', '/')
  if (path.startsWith('/') || /^[A-Za-z]:\//u.test(path) || path === '..' || path.startsWith('../') || path.includes('/../')) {
    throw new TypeError(`${field} must remain inside the repository`)
  }
  return path
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, field: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new TypeError(`${field} is invalid`)
  return value as T[number]
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${field} must be unique`)
}
