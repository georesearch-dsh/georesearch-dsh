import { createHash } from 'node:crypto'
import type { Sha256Digest } from './index.js'
import type { EvidenceRecord, SourceRecord } from './phase3.js'
import type {
  RepositoryAudit,
  ReproductionPlan,
  ReproductionReport,
  ReproductionTestSpecRecord,
} from './phase4.js'
import type {
  DatasetManifest,
  ExperimentAmendment,
  ExperimentSpec,
  GeodataInspectionReport,
  ResultRecord,
} from './phase5.js'
import type {
  ClaimRecord,
  ManuscriptAudit,
  ManuscriptRecord,
  ReviewRecord,
  ValidationPlan,
  ValidationReport,
  WritingPacket,
} from './phase6.js'

export const PROJECT_SCHEMA_VERSION = 1 as const
export const PROJECT_EVENT_SCHEMA_VERSION = 1 as const
export const PROJECT_REDUCER_VERSION = 1 as const

export type JsonPrimitive = null | boolean | number | string
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export interface FileIdentity {
  readonly volumeIdentity: string
  readonly fileIdentity: string
}

export interface CanonicalPathIdentity extends FileIdentity {
  readonly canonicalPath: string
}

export interface WorkspaceBinding {
  readonly schemaVersion: 1
  readonly bindingVersion: number
  readonly workspaceId: string
  readonly projectId: string
  readonly canonicalPath: string
  readonly volumeIdentity: string
  readonly directoryFileIdentity: string
  readonly gitCommonDirIdentity?: FileIdentity
  readonly gitWorktreeIdentity?: FileIdentity
  readonly attachedAt: string
  readonly verifiedAt: string
}

export interface ProjectBinding {
  readonly schemaVersion: 1
  readonly projectId: string
  readonly bindingId: string
  readonly workspaceIds: readonly string[]
  readonly createdAt: string
  readonly updatedAt: string
}

export interface OperationIdentity {
  readonly projectId: string
  readonly agentId: string
  readonly sessionId: string
  readonly rootCallId: string
  readonly callId: string
  readonly operation: string
}

export interface OperationErrorRecord {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export interface OperationRecord {
  readonly schemaVersion: 1
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly operation: string
  readonly state: 'in-progress' | 'committed' | 'failed-final' | 'recovery-required'
  readonly createdAt: string
  readonly updatedAt: string
  readonly exactResult?: JsonValue
  readonly exactResultDigest?: Sha256Digest
  readonly exactError?: OperationErrorRecord
}

export type ArtifactMaterialization = 'candidate' | 'committed' | 'rejected' | 'quarantined'
export type ArtifactIntegrity = 'unchecked' | 'verified' | 'corrupt' | 'missing'
export type ArtifactValidity = 'current' | 'stale' | 'superseded'

export interface ArtifactRef {
  readonly artifactId: string
  readonly digest: Sha256Digest
  readonly kind: string
}

export interface ArtifactLineage {
  readonly inputDigests: readonly Sha256Digest[]
  readonly transformationType: string
  readonly codeDigest?: Sha256Digest
  readonly configDigest?: Sha256Digest
  readonly outputDigest: Sha256Digest
}

export interface ArtifactRecord extends ArtifactRef {
  readonly schemaVersion: 1
  readonly size: number
  readonly mediaType: string
  readonly sourceRelativePath?: string
  readonly workspaceId: string
  readonly materialization: ArtifactMaterialization
  readonly integrity: ArtifactIntegrity
  readonly validity: ArtifactValidity
  readonly objectPath: string
  readonly lineage: ArtifactLineage
  readonly committedAt: string
}

export interface ResearchRegion {
  readonly description: string
  readonly bbox?: readonly [number, number, number, number]
  readonly crs?: string
}

export interface ResearchTimeRange {
  readonly start: string | null
  readonly end: string | null
}

export interface ResearchHypothesis {
  readonly hypothesisId: string
  readonly statement: string
}

export interface UserConfirmationRecord {
  readonly confirmed: true
  readonly confirmedAt: string
  readonly confirmedBy: 'user'
  readonly auditNote: string
}

export interface ResearchBriefBody {
  readonly schemaVersion: 1
  readonly briefId: string
  readonly title: string
  readonly researchQuestion: string
  readonly background: string
  readonly motivation: string
  readonly region: ResearchRegion
  readonly timeRange: ResearchTimeRange
  readonly researchSubjects: readonly string[]
  readonly dataModalities: readonly string[]
  readonly hypotheses: readonly ResearchHypothesis[]
  readonly expectedContributions: readonly string[]
  readonly constraints: readonly string[]
  readonly knownAssumptions: readonly string[]
  readonly successCriteria: readonly string[]
  readonly userConfirmation: UserConfirmationRecord
}

export interface ResearchBrief extends ResearchBriefBody {
  readonly digest: Sha256Digest
  readonly committedAt: string
}

export const PROJECT_READINESS_DOMAINS = [
  'scope',
  'evidence',
  'reproduction',
  'protocol',
  'implementation',
  'runs',
  'validation',
  'claims',
  'manuscript',
] as const

export type ProjectReadinessDomain = typeof PROJECT_READINESS_DOMAINS[number]
export type ProjectReadiness = 'missing' | 'in-progress' | 'ready' | 'blocked' | 'stale'

export interface ProjectSnapshot {
  readonly schemaVersion: 1
  readonly projectId: string
  readonly generation: number
  readonly stateDigest: Sha256Digest
  readonly workspaceId: string
  readonly readiness: Readonly<Record<ProjectReadinessDomain, ProjectReadiness>>
  readonly activeTaskIds: readonly string[]
  readonly visibleArtifacts: readonly ArtifactRef[]
  readonly blockers: readonly string[]
  readonly staleIndicators: readonly string[]
}

export type RunKind = 'local-test' | 'formal'
export type RunState =
  | 'starting'
  | 'running'
  | 'collecting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'recovery-required'

export type RunSandboxRecord =
  | {
      readonly mode: 'read-only' | 'workspace-write'
      readonly enforcement: 'full' | 'partial'
    }
  | {
      readonly mode: 'danger-full-access'
      readonly enforcement?: never
    }

export interface RunFailureClassification {
  readonly code: string
  readonly message: string
  readonly retryable: boolean
}

export interface RunApprovalAudit {
  readonly outcome: 'allowed-once'
  readonly callId: string
  readonly approvedAt: string
}

export interface RunResourceLimits {
  readonly timeoutMs: number
  readonly graceMs: number
  readonly stdoutMaxBytes: number
  readonly stderrMaxBytes: number
}

export interface RunRecord {
  readonly schemaVersion: 1
  readonly runId: string
  readonly kind: RunKind
  readonly projectId: string
  readonly workspaceId: string
  readonly workspaceBindingVersion: number
  readonly experimentSpecDigest: Sha256Digest
  readonly sourceTreeDigest: Sha256Digest
  readonly environmentDigest: Sha256Digest
  readonly datasetDigests: readonly Sha256Digest[]
  readonly seed?: number
  readonly argv: readonly string[]
  readonly argvDigest: Sha256Digest
  readonly cwd: CanonicalPathIdentity
  readonly state: RunState
  readonly launchId: string
  readonly pid?: number
  readonly processCreationTime?: string
  readonly supervisorReceiptDigest?: Sha256Digest
  readonly resourceLimits: RunResourceLimits
  readonly stdoutPath: string
  readonly stderrPath: string
  readonly startedAt?: string
  readonly endedAt?: string
  readonly exitCode?: number | null
  readonly sandbox: RunSandboxRecord
  readonly approval?: RunApprovalAudit
  readonly outputArtifactRefs: readonly ArtifactRef[]
  readonly failureClassification?: RunFailureClassification
}

export interface RunLaunchIntent {
  readonly schemaVersion: 1
  readonly projectId: string
  readonly runId: string
  readonly launchId: string
  readonly argv: readonly string[]
  readonly argvDigest: Sha256Digest
  readonly cwd: CanonicalPathIdentity
  readonly environmentDigest: Sha256Digest
  readonly stdoutPath: string
  readonly stderrPath: string
  readonly createdAt: string
}

export interface RunLaunchReceipt {
  readonly schemaVersion: 1
  readonly projectId: string
  readonly runId: string
  readonly launchId: string
  readonly pid: number
  readonly processCreationTime: string
  readonly stdoutPath: string
  readonly stderrPath: string
  readonly createdAt: string
  readonly digest: Sha256Digest
}

export interface RunExitMarker {
  readonly schemaVersion: 1
  readonly projectId: string
  readonly runId: string
  readonly launchId: string
  readonly exitCode: number | null
  readonly signal: string | null
  readonly endedAt: string
  readonly stdoutDigest: Sha256Digest
  readonly stderrDigest: Sha256Digest
  readonly terminationReason?: 'cancelled' | 'timeout'
}

export function parseRunExitMarker(value: unknown): RunExitMarker {
  const record = exactPlainRecord(value, 'RunExitMarker', [
    'schemaVersion', 'projectId', 'runId', 'launchId', 'exitCode', 'signal',
    'endedAt', 'stdoutDigest', 'stderrDigest', 'terminationReason',
  ])
  schemaOne(record)
  if (record.terminationReason !== undefined
    && record.terminationReason !== 'cancelled'
    && record.terminationReason !== 'timeout') {
    throw new TypeError('RunExitMarker.terminationReason is invalid')
  }
  return {
    schemaVersion: 1,
    projectId: text(record.projectId, 'RunExitMarker.projectId'),
    runId: text(record.runId, 'RunExitMarker.runId'),
    launchId: text(record.launchId, 'RunExitMarker.launchId'),
    exitCode: nullableInteger(record.exitCode, 'RunExitMarker.exitCode'),
    signal: record.signal === null ? null : text(record.signal, 'RunExitMarker.signal'),
    endedAt: utc(record.endedAt, 'RunExitMarker.endedAt'),
    stdoutDigest: digest(record.stdoutDigest, 'RunExitMarker.stdoutDigest'),
    stderrDigest: digest(record.stderrDigest, 'RunExitMarker.stderrDigest'),
    ...(record.terminationReason === undefined ? {} : { terminationReason: record.terminationReason }),
  }
}

export interface FormalRunPlan {
  readonly schemaVersion: 1
  readonly runId: string
  readonly argv: readonly string[]
  readonly argvDigest: Sha256Digest
  readonly experimentSpecDigest: Sha256Digest
  readonly sourceTreeDigest: Sha256Digest
  readonly environmentDigest: Sha256Digest
  readonly datasetDigests: readonly Sha256Digest[]
  readonly seed: number
  readonly resourceLimits: RunResourceLimits
  readonly environment: Readonly<Record<string, string>>
}

export type TestRunnerKind = 'package-script' | 'pytest' | 'vitest' | 'jest' | 'tsc' | 'eslint' | 'ruff' | 'mypy' | 'smoke'

export interface TestSpec {
  readonly schemaVersion: 1
  readonly testSpecId: string
  readonly runner: TestRunnerKind
  readonly argv: readonly string[]
  readonly cwdRelative: string
  readonly timeoutMs: number
  readonly graceMs: number
  readonly environment: Readonly<Record<string, string>>
}

export interface ProjectReducerState {
  readonly schemaVersion: 1
  readonly projectId: string
  readonly projectBinding: ProjectBinding
  readonly workspaceBindings: Readonly<Record<string, WorkspaceBinding>>
  readonly researchBrief?: ResearchBrief
  readonly artifacts: Readonly<Record<string, ArtifactRecord>>
  readonly runs: Readonly<Record<string, RunRecord>>
  readonly sources?: Readonly<Record<string, SourceRecord>>
  readonly evidence?: Readonly<Record<string, EvidenceRecord>>
  readonly repositoryAudits?: Readonly<Record<string, RepositoryAudit>>
  readonly reproductionPlans?: Readonly<Record<string, ReproductionPlan>>
  readonly reproductionTestSpecs?: Readonly<Record<string, ReproductionTestSpecRecord>>
  readonly reproductionReports?: Readonly<Record<string, ReproductionReport>>
  readonly geodataReports?: Readonly<Record<string, GeodataInspectionReport>>
  readonly datasetManifests?: Readonly<Record<string, DatasetManifest>>
  readonly experimentSpecs?: Readonly<Record<string, ExperimentSpec>>
  readonly experimentAmendments?: Readonly<Record<string, ExperimentAmendment>>
  readonly results?: Readonly<Record<string, ResultRecord>>
  readonly validationPlans?: Readonly<Record<string, ValidationPlan>>
  readonly validationReports?: Readonly<Record<string, ValidationReport>>
  readonly reviewRecords?: Readonly<Record<string, ReviewRecord>>
  readonly claims?: Readonly<Record<string, ClaimRecord>>
  readonly writingPackets?: Readonly<Record<string, WritingPacket>>
  readonly manuscripts?: Readonly<Record<string, ManuscriptRecord>>
  readonly manuscriptAudits?: Readonly<Record<string, ManuscriptAudit>>
  readonly activeTaskIds: readonly string[]
  readonly blockers: readonly string[]
  readonly staleIndicators: readonly string[]
}

export interface ProjectStateFile {
  readonly schemaVersion: 1
  readonly projectId: string
  readonly generation: number
  readonly lastEventSeq: number
  readonly lastEventHash: Sha256Digest | null
  readonly state: ProjectReducerState
  readonly digest: Sha256Digest
}

export interface ProjectEvent {
  readonly eventSchemaVersion: 1
  readonly reducerVersion: 1
  readonly seq: number
  readonly time: string
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly type: string
  readonly data: JsonValue
  readonly previousHash: Sha256Digest | null
  readonly hash: Sha256Digest
}

export const RESEARCH_BRIEF_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    briefId: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    researchQuestion: { type: 'string', minLength: 1 },
    background: { type: 'string', minLength: 1 },
    motivation: { type: 'string', minLength: 1 },
    region: {
      type: 'object',
      additionalProperties: false,
      properties: {
        description: { type: 'string', minLength: 1 },
        bbox: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number' } },
        crs: { type: 'string', minLength: 1 },
      },
      required: ['description'],
    },
    timeRange: {
      type: 'object',
      additionalProperties: false,
      properties: {
        start: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
        end: { oneOf: [{ type: 'string', minLength: 1 }, { type: 'null' }] },
      },
      required: ['start', 'end'],
    },
    researchSubjects: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    dataModalities: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    hypotheses: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          hypothesisId: { type: 'string', minLength: 1 },
          statement: { type: 'string', minLength: 1 },
        },
        required: ['hypothesisId', 'statement'],
      },
    },
    expectedContributions: { type: 'array', items: { type: 'string', minLength: 1 } },
    constraints: { type: 'array', items: { type: 'string', minLength: 1 } },
    knownAssumptions: { type: 'array', items: { type: 'string', minLength: 1 } },
    successCriteria: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    userConfirmation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        confirmed: { const: true },
        confirmedAt: { type: 'string', minLength: 1 },
        confirmedBy: { const: 'user' },
        auditNote: { type: 'string', minLength: 1 },
      },
      required: ['confirmed', 'confirmedAt', 'confirmedBy', 'auditNote'],
    },
    digest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
    committedAt: { type: 'string', minLength: 1 },
  },
  required: [
    'schemaVersion', 'briefId', 'title', 'researchQuestion', 'background', 'motivation',
    'region', 'timeRange', 'researchSubjects', 'dataModalities', 'hypotheses',
    'expectedContributions', 'constraints', 'knownAssumptions', 'successCriteria',
    'userConfirmation', 'digest', 'committedAt',
  ],
})

export const PROJECT_SNAPSHOT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    projectId: { type: 'string', minLength: 1 },
    generation: { type: 'integer', minimum: 0 },
    stateDigest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
    workspaceId: { type: 'string', minLength: 1 },
    readiness: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(PROJECT_READINESS_DOMAINS.map(domain => [domain, {
        type: 'string',
        enum: ['missing', 'in-progress', 'ready', 'blocked', 'stale'],
      }])),
      required: [...PROJECT_READINESS_DOMAINS],
    },
    activeTaskIds: { type: 'array', items: { type: 'string', minLength: 1 } },
    visibleArtifacts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          artifactId: { type: 'string', minLength: 1 },
          digest: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' },
          kind: { type: 'string', minLength: 1 },
        },
        required: ['artifactId', 'digest', 'kind'],
      },
    },
    blockers: { type: 'array', items: { type: 'string', minLength: 1 } },
    staleIndicators: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
  required: [
    'schemaVersion', 'projectId', 'generation', 'stateDigest', 'workspaceId',
    'readiness', 'activeTaskIds', 'visibleArtifacts', 'blockers', 'staleIndicators',
  ],
})

const SHA256_SCHEMA = Object.freeze({ type: 'string', pattern: '^sha256:[0-9a-f]{64}$' })
const UTC_TIMESTAMP_SCHEMA = Object.freeze({
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
})
const ARTIFACT_REF_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    artifactId: { type: 'string', minLength: 1 },
    digest: SHA256_SCHEMA,
    kind: { type: 'string', minLength: 1 },
  },
  required: ['artifactId', 'digest', 'kind'],
})
const RUN_RESOURCE_LIMITS_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    timeoutMs: { type: 'integer', minimum: 1 },
    graceMs: { type: 'integer', minimum: 1 },
    stdoutMaxBytes: { type: 'integer', minimum: 1 },
    stderrMaxBytes: { type: 'integer', minimum: 1 },
  },
  required: ['timeoutMs', 'graceMs', 'stdoutMaxBytes', 'stderrMaxBytes'],
})

export const RUN_RECORD_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    runId: { type: 'string', minLength: 1 },
    kind: { type: 'string', enum: ['local-test', 'formal'] },
    projectId: { type: 'string', minLength: 1 },
    workspaceId: { type: 'string', minLength: 1 },
    workspaceBindingVersion: { type: 'integer', minimum: 1 },
    experimentSpecDigest: SHA256_SCHEMA,
    sourceTreeDigest: SHA256_SCHEMA,
    environmentDigest: SHA256_SCHEMA,
    datasetDigests: { type: 'array', uniqueItems: true, items: SHA256_SCHEMA },
    seed: { type: 'integer', minimum: 0 },
    argv: { type: 'array', minItems: 1, items: { type: 'string' } },
    argvDigest: SHA256_SCHEMA,
    cwd: {
      type: 'object',
      additionalProperties: false,
      properties: {
        canonicalPath: { type: 'string', minLength: 1 },
        volumeIdentity: { type: 'string', minLength: 1 },
        fileIdentity: { type: 'string', minLength: 1 },
      },
      required: ['canonicalPath', 'volumeIdentity', 'fileIdentity'],
    },
    state: {
      type: 'string',
      enum: ['starting', 'running', 'collecting', 'succeeded', 'failed', 'cancelled', 'recovery-required'],
    },
    launchId: { type: 'string', minLength: 1 },
    pid: { type: 'integer', minimum: 1 },
    processCreationTime: UTC_TIMESTAMP_SCHEMA,
    supervisorReceiptDigest: SHA256_SCHEMA,
    resourceLimits: RUN_RESOURCE_LIMITS_SCHEMA,
    stdoutPath: { type: 'string', minLength: 1 },
    stderrPath: { type: 'string', minLength: 1 },
    startedAt: UTC_TIMESTAMP_SCHEMA,
    endedAt: UTC_TIMESTAMP_SCHEMA,
    exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
    sandbox: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
        enforcement: { type: 'string', enum: ['full', 'partial'] },
      },
      required: ['mode'],
      allOf: [
        {
          if: { properties: { mode: { enum: ['read-only', 'workspace-write'] } }, required: ['mode'] },
          then: { required: ['enforcement'] },
        },
        {
          if: { properties: { mode: { const: 'danger-full-access' } }, required: ['mode'] },
          then: { not: { required: ['enforcement'] } },
        },
      ],
    },
    approval: {
      type: 'object',
      additionalProperties: false,
      properties: {
        outcome: { const: 'allowed-once' },
        callId: { type: 'string', minLength: 1 },
        approvedAt: UTC_TIMESTAMP_SCHEMA,
      },
      required: ['outcome', 'callId', 'approvedAt'],
    },
    outputArtifactRefs: { type: 'array', items: ARTIFACT_REF_SCHEMA },
    failureClassification: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', minLength: 1 },
        message: { type: 'string', minLength: 1 },
        retryable: { type: 'boolean' },
      },
      required: ['code', 'message', 'retryable'],
    },
  },
  required: [
    'schemaVersion', 'runId', 'kind', 'projectId', 'workspaceId',
    'workspaceBindingVersion', 'experimentSpecDigest', 'sourceTreeDigest',
    'environmentDigest', 'datasetDigests', 'argv', 'argvDigest', 'cwd', 'state',
    'launchId', 'resourceLimits', 'stdoutPath', 'stderrPath', 'sandbox',
    'outputArtifactRefs',
  ],
  allOf: [
    {
      if: { properties: { kind: { const: 'formal' } }, required: ['kind'] },
      then: { required: ['seed'] },
    },
    {
      if: { properties: { state: { const: 'running' } }, required: ['state'] },
      then: { required: ['pid', 'processCreationTime', 'supervisorReceiptDigest', 'startedAt'] },
    },
    {
      if: {
        properties: { state: { enum: ['collecting', 'succeeded', 'failed', 'cancelled'] } },
        required: ['state'],
      },
      then: { required: ['endedAt', 'exitCode'] },
    },
    {
      if: { properties: { state: { const: 'succeeded' } }, required: ['state'] },
      then: { properties: { exitCode: { const: 0 } } },
    },
  ],
})

export function operationKeyFor(identity: OperationIdentity): Sha256Digest {
  return digestCanonical({ domain: 'georesearch.operation-key/v1', ...identity })
}

export function requestDigestFor(operation: string, request: JsonValue): Sha256Digest {
  return digestCanonical({ domain: 'georesearch.operation-request/v1', operation, request })
}

const RESEARCH_BRIEF_BODY_FIELDS = [
  'schemaVersion',
  'briefId',
  'title',
  'researchQuestion',
  'background',
  'motivation',
  'region',
  'timeRange',
  'researchSubjects',
  'dataModalities',
  'hypotheses',
  'expectedContributions',
  'constraints',
  'knownAssumptions',
  'successCriteria',
  'userConfirmation',
] as const

export function parseResearchBriefBody(value: unknown): ResearchBriefBody {
  const record = exactPlainRecord(value, 'ResearchBrief', RESEARCH_BRIEF_BODY_FIELDS)
  schemaOne(record)
  const region = exactPlainRecord(record.region, 'ResearchBrief.region', ['description', 'bbox', 'crs'])
  const timeRange = exactPlainRecord(record.timeRange, 'ResearchBrief.timeRange', ['start', 'end'])
  const confirmation = exactPlainRecord(
    record.userConfirmation,
    'ResearchBrief.userConfirmation',
    ['confirmed', 'confirmedAt', 'confirmedBy', 'auditNote'],
  )
  const bbox = region.bbox === undefined ? undefined : numberTuple4(region.bbox, 'ResearchBrief.region.bbox')
  if (confirmation.confirmed !== true || confirmation.confirmedBy !== 'user') {
    throw new TypeError('ResearchBrief.userConfirmation must record an explicit user confirmation')
  }
  return {
    schemaVersion: 1,
    briefId: text(record.briefId, 'ResearchBrief.briefId'),
    title: text(record.title, 'ResearchBrief.title'),
    researchQuestion: text(record.researchQuestion, 'ResearchBrief.researchQuestion'),
    background: text(record.background, 'ResearchBrief.background'),
    motivation: text(record.motivation, 'ResearchBrief.motivation'),
    region: {
      description: text(region.description, 'ResearchBrief.region.description'),
      ...(bbox === undefined ? {} : { bbox }),
      ...(region.crs === undefined ? {} : { crs: text(region.crs, 'ResearchBrief.region.crs') }),
    },
    timeRange: {
      start: nullableText(timeRange.start, 'ResearchBrief.timeRange.start'),
      end: nullableText(timeRange.end, 'ResearchBrief.timeRange.end'),
    },
    researchSubjects: textArray(record.researchSubjects, 'ResearchBrief.researchSubjects', true),
    dataModalities: textArray(record.dataModalities, 'ResearchBrief.dataModalities', true),
    hypotheses: objectArray(record.hypotheses, 'ResearchBrief.hypotheses').map((item, index) => {
      const hypothesis = exactPlainRecord(
        item,
        `ResearchBrief.hypotheses[${index}]`,
        ['hypothesisId', 'statement'],
      )
      return {
        hypothesisId: text(hypothesis.hypothesisId, `ResearchBrief.hypotheses[${index}].hypothesisId`),
        statement: text(hypothesis.statement, `ResearchBrief.hypotheses[${index}].statement`),
      }
    }),
    expectedContributions: textArray(record.expectedContributions, 'ResearchBrief.expectedContributions'),
    constraints: textArray(record.constraints, 'ResearchBrief.constraints'),
    knownAssumptions: textArray(record.knownAssumptions, 'ResearchBrief.knownAssumptions'),
    successCriteria: textArray(record.successCriteria, 'ResearchBrief.successCriteria', true),
    userConfirmation: {
      confirmed: true,
      confirmedAt: utc(confirmation.confirmedAt, 'ResearchBrief.userConfirmation.confirmedAt'),
      confirmedBy: 'user',
      auditNote: text(confirmation.auditNote, 'ResearchBrief.userConfirmation.auditNote'),
    },
  }
}

export function parseResearchBrief(value: unknown): ResearchBrief {
  const record = exactPlainRecord(value, 'ResearchBrief', [
    ...RESEARCH_BRIEF_BODY_FIELDS,
    'digest',
    'committedAt',
  ])
  const body = parseResearchBriefBody(Object.fromEntries(
    RESEARCH_BRIEF_BODY_FIELDS.map(field => [field, record[field]]),
  ))
  return {
    ...body,
    digest: digest(record.digest, 'ResearchBrief.digest'),
    committedAt: utc(record.committedAt, 'ResearchBrief.committedAt'),
  }
}

export function parseProjectSnapshot(value: unknown): ProjectSnapshot {
  const record = exactPlainRecord(value, 'ProjectSnapshot', [
    'schemaVersion', 'projectId', 'generation', 'stateDigest', 'workspaceId',
    'readiness', 'activeTaskIds', 'visibleArtifacts', 'blockers', 'staleIndicators',
  ])
  schemaOne(record)
  const readinessValue = exactPlainRecord(record.readiness, 'ProjectSnapshot.readiness', PROJECT_READINESS_DOMAINS)
  const readiness = Object.fromEntries(PROJECT_READINESS_DOMAINS.map(domain => {
    const value = readinessValue[domain]
    if (value !== 'missing' && value !== 'in-progress' && value !== 'ready'
      && value !== 'blocked' && value !== 'stale') {
      throw new TypeError(`ProjectSnapshot.readiness.${domain} is invalid`)
    }
    return [domain, value]
  })) as unknown as Record<ProjectReadinessDomain, ProjectReadiness>
  return {
    schemaVersion: 1,
    projectId: text(record.projectId, 'ProjectSnapshot.projectId'),
    generation: nonNegativeInteger(record.generation, 'ProjectSnapshot.generation'),
    stateDigest: digest(record.stateDigest, 'ProjectSnapshot.stateDigest'),
    workspaceId: text(record.workspaceId, 'ProjectSnapshot.workspaceId'),
    readiness,
    activeTaskIds: textArray(record.activeTaskIds, 'ProjectSnapshot.activeTaskIds'),
    visibleArtifacts: objectArray(record.visibleArtifacts, 'ProjectSnapshot.visibleArtifacts').map((item, index) => {
      const artifact = exactPlainRecord(item, `ProjectSnapshot.visibleArtifacts[${index}]`, ['artifactId', 'digest', 'kind'])
      return {
        artifactId: text(artifact.artifactId, `ProjectSnapshot.visibleArtifacts[${index}].artifactId`),
        digest: digest(artifact.digest, `ProjectSnapshot.visibleArtifacts[${index}].digest`),
        kind: text(artifact.kind, `ProjectSnapshot.visibleArtifacts[${index}].kind`),
      }
    }),
    blockers: textArray(record.blockers, 'ProjectSnapshot.blockers'),
    staleIndicators: textArray(record.staleIndicators, 'ProjectSnapshot.staleIndicators'),
  }
}

export function parseRunRecord(value: unknown): RunRecord {
  const record = exactPlainRecord(value, 'RunRecord', [
    'schemaVersion', 'runId', 'kind', 'projectId', 'workspaceId',
    'workspaceBindingVersion', 'experimentSpecDigest', 'sourceTreeDigest',
    'environmentDigest', 'datasetDigests', 'seed', 'argv', 'argvDigest', 'cwd', 'state',
    'launchId', 'pid', 'processCreationTime', 'supervisorReceiptDigest',
    'resourceLimits', 'stdoutPath', 'stderrPath', 'startedAt', 'endedAt',
    'exitCode', 'sandbox', 'approval', 'outputArtifactRefs', 'failureClassification',
  ])
  schemaOne(record)
  if (record.kind !== 'local-test' && record.kind !== 'formal') throw new TypeError('RunRecord.kind is invalid')
  const state = runState(record.state)
  const argv = stringArgv(record.argv, 'RunRecord.argv')
  const argvDigest = digest(record.argvDigest, 'RunRecord.argvDigest')
  if (digestCanonical(argv) !== argvDigest) throw new TypeError('RunRecord.argvDigest does not match argv')
  const datasetDigests = digestList(record.datasetDigests, 'RunRecord.datasetDigests')
  if (new Set(datasetDigests).size !== datasetDigests.length) throw new TypeError('RunRecord.datasetDigests must be unique')
  const seed = record.seed === undefined ? undefined : nonNegativeInteger(record.seed, 'RunRecord.seed')
  const cwd = exactPlainRecord(record.cwd, 'RunRecord.cwd', ['canonicalPath', 'volumeIdentity', 'fileIdentity'])
  const limits = exactPlainRecord(
    record.resourceLimits,
    'RunRecord.resourceLimits',
    ['timeoutMs', 'graceMs', 'stdoutMaxBytes', 'stderrMaxBytes'],
  )
  const sandbox = exactPlainRecord(record.sandbox, 'RunRecord.sandbox', ['mode', 'enforcement'])
  if (sandbox.mode !== 'read-only' && sandbox.mode !== 'workspace-write'
    && sandbox.mode !== 'danger-full-access') throw new TypeError('RunRecord.sandbox.mode is invalid')
  let sandboxRecord: RunSandboxRecord
  if (sandbox.mode === 'danger-full-access') {
    if (sandbox.enforcement !== undefined) {
      throw new TypeError('danger-full-access RunRecord cannot report sandbox enforcement')
    }
    sandboxRecord = { mode: sandbox.mode }
  } else {
    if (sandbox.enforcement !== 'full' && sandbox.enforcement !== 'partial') {
      throw new TypeError('confined RunRecord requires valid sandbox enforcement')
    }
    sandboxRecord = { mode: sandbox.mode, enforcement: sandbox.enforcement }
  }
  const approval = record.approval === undefined ? undefined : parseRunApproval(record.approval)
  if (record.kind === 'formal' && seed === undefined) {
    throw new TypeError('formal RunRecord requires seed')
  }
  const pid = record.pid === undefined ? undefined : positiveInteger(record.pid, 'RunRecord.pid')
  const processCreationTime = record.processCreationTime === undefined
    ? undefined
    : utc(record.processCreationTime, 'RunRecord.processCreationTime')
  const supervisorReceiptDigest = record.supervisorReceiptDigest === undefined
    ? undefined
    : digest(record.supervisorReceiptDigest, 'RunRecord.supervisorReceiptDigest')
  const startedAt = record.startedAt === undefined ? undefined : utc(record.startedAt, 'RunRecord.startedAt')
  const endedAt = record.endedAt === undefined ? undefined : utc(record.endedAt, 'RunRecord.endedAt')
  const exitCode = record.exitCode === undefined ? undefined : nullableInteger(record.exitCode, 'RunRecord.exitCode')
  if (state === 'running' && (pid === undefined || processCreationTime === undefined
    || supervisorReceiptDigest === undefined || startedAt === undefined)) {
    throw new TypeError('running RunRecord requires process receipt facts and startedAt')
  }
  if ((state === 'collecting' || state === 'succeeded' || state === 'failed' || state === 'cancelled')
    && (endedAt === undefined || exitCode === undefined)) {
    throw new TypeError(`${state} RunRecord requires endedAt and exitCode`)
  }
  if (state === 'succeeded' && exitCode !== 0) throw new TypeError('succeeded RunRecord exitCode must be 0')
  const failureClassification = record.failureClassification === undefined
    ? undefined
    : parseRunFailure(record.failureClassification)
  return {
    schemaVersion: 1,
    runId: text(record.runId, 'RunRecord.runId'),
    kind: record.kind,
    projectId: text(record.projectId, 'RunRecord.projectId'),
    workspaceId: text(record.workspaceId, 'RunRecord.workspaceId'),
    workspaceBindingVersion: positiveInteger(record.workspaceBindingVersion, 'RunRecord.workspaceBindingVersion'),
    experimentSpecDigest: digest(record.experimentSpecDigest, 'RunRecord.experimentSpecDigest'),
    sourceTreeDigest: digest(record.sourceTreeDigest, 'RunRecord.sourceTreeDigest'),
    environmentDigest: digest(record.environmentDigest, 'RunRecord.environmentDigest'),
    datasetDigests,
    ...(seed === undefined ? {} : { seed }),
    argv,
    argvDigest,
    cwd: {
      canonicalPath: text(cwd.canonicalPath, 'RunRecord.cwd.canonicalPath'),
      volumeIdentity: text(cwd.volumeIdentity, 'RunRecord.cwd.volumeIdentity'),
      fileIdentity: text(cwd.fileIdentity, 'RunRecord.cwd.fileIdentity'),
    },
    state,
    launchId: text(record.launchId, 'RunRecord.launchId'),
    ...(pid === undefined ? {} : { pid }),
    ...(processCreationTime === undefined ? {} : { processCreationTime }),
    ...(supervisorReceiptDigest === undefined ? {} : { supervisorReceiptDigest }),
    resourceLimits: {
      timeoutMs: positiveInteger(limits.timeoutMs, 'RunRecord.resourceLimits.timeoutMs'),
      graceMs: positiveInteger(limits.graceMs, 'RunRecord.resourceLimits.graceMs'),
      stdoutMaxBytes: positiveInteger(limits.stdoutMaxBytes, 'RunRecord.resourceLimits.stdoutMaxBytes'),
      stderrMaxBytes: positiveInteger(limits.stderrMaxBytes, 'RunRecord.resourceLimits.stderrMaxBytes'),
    },
    stdoutPath: text(record.stdoutPath, 'RunRecord.stdoutPath'),
    stderrPath: text(record.stderrPath, 'RunRecord.stderrPath'),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
    ...(exitCode === undefined ? {} : { exitCode }),
    sandbox: sandboxRecord,
    ...(approval === undefined ? {} : { approval }),
    outputArtifactRefs: objectArray(record.outputArtifactRefs, 'RunRecord.outputArtifactRefs').map((item, index) => {
      const artifact = exactPlainRecord(item, `RunRecord.outputArtifactRefs[${index}]`, ['artifactId', 'digest', 'kind'])
      return {
        artifactId: text(artifact.artifactId, `RunRecord.outputArtifactRefs[${index}].artifactId`),
        digest: digest(artifact.digest, `RunRecord.outputArtifactRefs[${index}].digest`),
        kind: text(artifact.kind, `RunRecord.outputArtifactRefs[${index}].kind`),
      }
    }),
    ...(failureClassification === undefined ? {} : { failureClassification }),
  }
}

function digestCanonical(value: unknown): Sha256Digest {
  return `sha256:${createHash('sha256').update(canonicalize(value), 'utf8').digest('hex')}`
}

function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers')
      return JSON.stringify(Object.is(value, -0) ? 0 : value)
    case 'string': return JSON.stringify(value)
    case 'object': {
      const record = plainRecord(value, 'canonical JSON value')
      return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(',')}}`
    }
    default: throw new TypeError(`canonical JSON rejects ${typeof value}`)
  }
}

function plainRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactPlainRecord(
  value: unknown,
  field: string,
  allowedFields: readonly string[],
): Record<string, unknown> {
  const record = plainRecord(value, field)
  const unexpected = Object.keys(record).filter(key => !allowedFields.includes(key))
  if (unexpected.length > 0) throw new TypeError(`${field} contains unsupported fields: ${unexpected.join(', ')}`)
  return record
}

function schemaOne(record: Record<string, unknown>): void {
  if (record.schemaVersion !== 1) throw new TypeError('schemaVersion must be 1')
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${field} must be a non-empty string`)
  return value
}

function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field)
}

function textArray(value: unknown, field: string, requireNonEmpty = false): string[] {
  if (!Array.isArray(value) || (requireNonEmpty && value.length === 0)) throw new TypeError(`${field} must be an array`)
  return value.map((item, index) => text(item, `${field}[${index}]`))
}

function objectArray(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  return value.map((item, index) => plainRecord(item, `${field}[${index}]`))
}

function numberTuple4(value: unknown, field: string): readonly [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4 || !value.every(item => typeof item === 'number' && Number.isFinite(item))) {
    throw new TypeError(`${field} must contain four finite numbers`)
  }
  return [value[0] as number, value[1] as number, value[2] as number, value[3] as number]
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${field} must be a non-negative integer`)
  return value as number
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive integer`)
  return value as number
}

function nullableInteger(value: unknown, field: string): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value)) throw new TypeError(`${field} must be an integer or null`)
  return value as number
}

function digest(value: unknown, field: string): Sha256Digest {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new TypeError(`${field} is invalid`)
  return value as Sha256Digest
}

function digestList(value: unknown, field: string): Sha256Digest[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  return value.map((item, index) => digest(item, `${field}[${index}]`))
}

function stringArgv(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new TypeError(`${field} must be a non-empty array`)
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.includes('\0')) throw new TypeError(`${field}[${index}] is invalid`)
    return item
  })
}

function runState(value: unknown): RunState {
  const states: readonly RunState[] = [
    'starting', 'running', 'collecting', 'succeeded', 'failed', 'cancelled', 'recovery-required',
  ]
  if (typeof value !== 'string' || !states.includes(value as RunState)) throw new TypeError('RunRecord.state is invalid')
  return value as RunState
}

function parseRunApproval(value: unknown): RunApprovalAudit {
  const record = exactPlainRecord(value, 'RunRecord.approval', ['outcome', 'callId', 'approvedAt'])
  if (record.outcome !== 'allowed-once') throw new TypeError('RunRecord.approval.outcome is invalid')
  return {
    outcome: 'allowed-once',
    callId: text(record.callId, 'RunRecord.approval.callId'),
    approvedAt: utc(record.approvedAt, 'RunRecord.approval.approvedAt'),
  }
}

function parseRunFailure(value: unknown): RunFailureClassification {
  const record = exactPlainRecord(value, 'RunRecord.failureClassification', ['code', 'message', 'retryable'])
  if (typeof record.retryable !== 'boolean') throw new TypeError('RunRecord.failureClassification.retryable must be boolean')
  return {
    code: text(record.code, 'RunRecord.failureClassification.code'),
    message: text(record.message, 'RunRecord.failureClassification.message'),
    retryable: record.retryable,
  }
}

function utc(value: unknown, field: string): string {
  const result = text(value, field)
  const date = new Date(result)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== result) throw new TypeError(`${field} must be canonical UTC`)
  return result
}
