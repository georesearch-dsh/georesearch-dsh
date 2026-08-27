import type {
  ArtifactRef,
  ResearchBrief,
  RunRecord,
} from './phase2.js'
import {
  PROJECT_SNAPSHOT_SCHEMA,
  RESEARCH_BRIEF_SCHEMA,
  RUN_RECORD_SCHEMA,
  parseResearchBrief,
  parseRunRecord,
} from './phase2.js'
import type { EvidenceRecord, SourceRecord } from './phase3.js'
import {
  EVIDENCE_RECORD_SCHEMA,
  SOURCE_RECORD_SCHEMA,
  parseEvidenceRecord,
  parseSourceRecord,
} from './phase3.js'
import type { ExperimentSpec, ResultRecord } from './phase5.js'
import {
  EXPERIMENT_SPEC_SCHEMA,
  RESULT_RECORD_SCHEMA,
  parseExperimentSpec,
  parseResultRecord,
} from './phase5.js'
import type { Sha256Digest } from './index.js'

void PROJECT_SNAPSHOT_SCHEMA

export const PHASE6_SCHEMA_VERSION = 1 as const

export const VALIDATION_SUBJECT_KINDS = [
  'geodata-report',
  'dataset-manifest',
  'experiment-spec',
  'run',
  'result',
  'evidence',
  'reproduction-report',
  'claim',
  'research-brief',
  'manuscript',
] as const
export type ValidationSubjectKind = typeof VALIDATION_SUBJECT_KINDS[number]

export interface ValidationSubjectRef {
  readonly kind: ValidationSubjectKind
  readonly subjectId: string
  readonly digest: Sha256Digest
}

export interface ValidationValidatorSpec {
  readonly validatorId: string
  readonly version: string
  readonly mandatory: boolean
  readonly configDigest: Sha256Digest
}

export interface ValidationFinding {
  readonly findingId: string
  readonly validatorId: string
  readonly severity: 'info' | 'warning' | 'error' | 'hard'
  readonly code: string
  readonly message: string
  readonly subjectIds: readonly string[]
}

export interface ValidationPlan {
  readonly schemaVersion: 1
  readonly planId: string
  readonly projectId: string
  readonly workspaceId: string
  readonly workspaceBindingVersion: number
  readonly domain: 'geodata' | 'experiment' | 'citation' | 'manuscript'
  readonly subjects: readonly ValidationSubjectRef[]
  readonly validators: readonly ValidationValidatorSpec[]
  readonly policyDigest: Sha256Digest
  readonly createdAt: string
  readonly digest: Sha256Digest
}

export interface ValidationValidatorResult extends ValidationValidatorSpec {
  readonly status: 'passed' | 'failed' | 'blocked' | 'error' | 'not-applicable'
  readonly findings: readonly ValidationFinding[]
}

export interface ValidationReport {
  readonly schemaVersion: 1
  readonly reportId: string
  readonly projectId: string
  readonly workspaceId: string
  readonly workspaceBindingVersion: number
  readonly planId: string
  readonly planDigest: Sha256Digest
  readonly subjects: readonly ValidationSubjectRef[]
  readonly validatorResults: readonly ValidationValidatorResult[]
  readonly overall: 'passed' | 'failed' | 'blocked'
  readonly completedAt: string
  readonly digest: Sha256Digest
}

export function deriveValidationOverall(
  plan: Pick<ValidationPlan, 'validators'>,
  results: readonly ValidationValidatorResult[],
): ValidationReport['overall'] {
  if (plan.validators.length === 0 || results.length === 0) return 'blocked'
  const byId = new Map(results.map(result => [result.validatorId, result]))
  if (byId.size !== results.length || results.length !== plan.validators.length) return 'blocked'
  for (const expected of plan.validators) {
    const actual = byId.get(expected.validatorId)
    if (actual === undefined
      || actual.version !== expected.version
      || actual.mandatory !== expected.mandatory
      || actual.configDigest !== expected.configDigest) return 'blocked'
  }
  if (results.some(result => result.mandatory && (result.status === 'blocked' || result.status === 'error'))) {
    return 'blocked'
  }
  if (results.some(result => result.status === 'failed')) return 'failed'
  return 'passed'
}

export interface ReviewProposal {
  readonly schemaVersion: 1
  readonly kind: 'review'
  readonly reviewId: string
  readonly subjectRefs: readonly ValidationSubjectRef[]
  readonly validationReportIds: readonly string[]
  readonly findings: readonly ValidationFinding[]
  readonly recommendation: 'accept' | 'revise' | 'reject'
  readonly supersedesReviewIds: readonly string[]
}

export interface ReviewRecord extends ReviewProposal {
  readonly projectId: string
  readonly workspaceId: string
  readonly workspaceBindingVersion: number
  readonly createdAt: string
  readonly digest: Sha256Digest
}

export const CLAIM_TYPES = [
  'literature-fact',
  'experimental-observation',
  'derived-calculation',
  'scientific-inference',
  'hypothesis',
  'speculation',
] as const
export type ClaimType = typeof CLAIM_TYPES[number]

export const CLAIM_SUPPORT_STATES = [
  'proposed',
  'source-backed',
  'experiment-supported',
  'independently-checked',
  'contradicted',
  'insufficient-evidence',
  'rejected',
] as const
export type ClaimSupportState = typeof CLAIM_SUPPORT_STATES[number]

export const MANUSCRIPT_SECTION_IDS = [
  'abstract',
  'introduction',
  'related-work',
  'methods',
  'results',
  'discussion',
  'conclusion',
  'future-work',
] as const
export type ManuscriptSectionId = typeof MANUSCRIPT_SECTION_IDS[number]

export interface ClaimSupportRef {
  readonly kind: 'evidence' | 'result' | 'claim' | 'hypothesis'
  readonly recordId: string
  readonly digest: Sha256Digest
}

export interface ClaimCalculationProposal {
  readonly operation: 'difference' | 'ratio' | 'percent-change' | 'mean'
  readonly operandResultIds: readonly string[]
}

export interface ClaimCalculation extends ClaimCalculationProposal {
  readonly value: number
  readonly inputDigests: readonly Sha256Digest[]
}

export interface ClaimProposal {
  readonly schemaVersion: 1
  readonly kind: 'claim'
  readonly claimId: string
  readonly statement: string
  readonly claimType: ClaimType
  readonly supportRefs: readonly ClaimSupportRef[]
  readonly calculation: ClaimCalculationProposal | null
  readonly limitations: readonly string[]
  readonly intendedSections: readonly ManuscriptSectionId[]
  readonly validationReportIds: readonly string[]
  readonly reviewRecordIds: readonly string[]
}

export interface ClaimApprovalRecord {
  readonly requested: 'pending' | 'approved' | 'rejected'
  readonly outcome: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'unavailable'
  readonly source: 'user' | 'coordinator'
  readonly callId: string
  readonly decidedAt: string
}

export interface ClaimRecord extends Omit<ClaimProposal, 'calculation'> {
  readonly projectId: string
  readonly workspaceId: string
  readonly workspaceBindingVersion: number
  readonly calculation: ClaimCalculation | null
  readonly supportState: ClaimSupportState
  readonly approvalState: 'pending' | 'approved' | 'rejected'
  readonly integrity: 'verified' | 'failed'
  readonly validity: 'current' | 'stale'
  readonly approval: ClaimApprovalRecord
  readonly committedAt: string
  readonly digest: Sha256Digest
}

export interface WritingPacket {
  readonly schemaVersion: 1
  readonly packetId: string
  readonly projectId: string
  readonly workspaceId: string
  readonly workspaceBindingVersion: number
  readonly researchBrief: ResearchBrief
  readonly claims: readonly ClaimRecord[]
  readonly sources: readonly SourceRecord[]
  readonly evidence: readonly EvidenceRecord[]
  readonly experimentSpecs: readonly ExperimentSpec[]
  readonly runs: readonly RunRecord[]
  readonly results: readonly ResultRecord[]
  readonly validationReports: readonly ValidationReport[]
  readonly artifactRefs: readonly ArtifactRef[]
  readonly limitations: readonly string[]
  readonly forbiddenClaimIds: readonly string[]
  readonly builtAt: string
  readonly digest: Sha256Digest
}

export interface ManuscriptNumericRef {
  readonly literal: string
  readonly claimId: string
  readonly resultId: string
}

export interface ManuscriptBlock {
  readonly blockId: string
  readonly text: string
  readonly claimIds: readonly string[]
  readonly evidenceIds: readonly string[]
  readonly resultIds: readonly string[]
  readonly numericRefs: readonly ManuscriptNumericRef[]
}

export interface ManuscriptSection {
  readonly sectionId: ManuscriptSectionId
  readonly title: string
  readonly blocks: readonly ManuscriptBlock[]
}

export interface ManuscriptCandidate {
  readonly schemaVersion: 1
  readonly kind: 'manuscript'
  readonly manuscriptId: string
  readonly packetId: string
  readonly packetDigest: Sha256Digest
  readonly title: string
  readonly sections: readonly ManuscriptSection[]
}

export interface ManuscriptAudit {
  readonly schemaVersion: 1
  readonly auditId: string
  readonly projectId: string
  readonly manuscriptId: string
  readonly packetId: string
  readonly packetDigest: Sha256Digest
  readonly checks: {
    readonly packetCurrent: boolean
    readonly claimsEligible: boolean
    readonly forbiddenClaimsAbsent: boolean
    readonly numbersTraceable: boolean
    readonly literatureTraceable: boolean
    readonly sectionsAllowed: boolean
  }
  readonly findings: readonly ValidationFinding[]
  readonly overall: 'passed' | 'failed' | 'blocked'
  readonly auditedAt: string
  readonly digest: Sha256Digest
}

export interface ManuscriptRecord extends ManuscriptCandidate {
  readonly projectId: string
  readonly workspaceId: string
  readonly workspaceBindingVersion: number
  readonly auditId: string
  readonly status: 'validated' | 'blocked'
  readonly createdAt: string
  readonly digest: Sha256Digest
}

const DIGEST_SCHEMA = Object.freeze({ type: 'string', pattern: '^sha256:[0-9a-f]{64}$' })
const TEXT_SCHEMA = Object.freeze({ type: 'string', minLength: 1 })
const ID_ARRAY_SCHEMA = Object.freeze({ type: 'array', items: TEXT_SCHEMA, uniqueItems: true })
const ARTIFACT_REF_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: { artifactId: TEXT_SCHEMA, digest: DIGEST_SCHEMA, kind: TEXT_SCHEMA },
  required: ['artifactId', 'digest', 'kind'],
})
const SUBJECT_REF_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: VALIDATION_SUBJECT_KINDS },
    subjectId: TEXT_SCHEMA,
    digest: DIGEST_SCHEMA,
  },
  required: ['kind', 'subjectId', 'digest'],
})
const VALIDATOR_SPEC_PROPERTIES = Object.freeze({
  validatorId: TEXT_SCHEMA,
  version: TEXT_SCHEMA,
  mandatory: { type: 'boolean' },
  configDigest: DIGEST_SCHEMA,
})
const VALIDATOR_SPEC_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: VALIDATOR_SPEC_PROPERTIES,
  required: ['validatorId', 'version', 'mandatory', 'configDigest'],
})
const FINDING_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    findingId: TEXT_SCHEMA,
    validatorId: TEXT_SCHEMA,
    severity: { type: 'string', enum: ['info', 'warning', 'error', 'hard'] },
    code: TEXT_SCHEMA,
    message: TEXT_SCHEMA,
    subjectIds: ID_ARRAY_SCHEMA,
  },
  required: ['findingId', 'validatorId', 'severity', 'code', 'message', 'subjectIds'],
})
const VALIDATOR_RESULT_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    ...VALIDATOR_SPEC_PROPERTIES,
    status: { type: 'string', enum: ['passed', 'failed', 'blocked', 'error', 'not-applicable'] },
    findings: { type: 'array', items: FINDING_SCHEMA },
  },
  required: ['validatorId', 'version', 'mandatory', 'configDigest', 'status', 'findings'],
})

export const VALIDATION_PLAN_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 }, planId: TEXT_SCHEMA, projectId: TEXT_SCHEMA,
    workspaceId: TEXT_SCHEMA, workspaceBindingVersion: { type: 'integer', minimum: 1 },
    domain: { type: 'string', enum: ['geodata', 'experiment', 'citation', 'manuscript'] },
    subjects: { type: 'array', minItems: 1, items: SUBJECT_REF_SCHEMA },
    validators: { type: 'array', minItems: 1, items: VALIDATOR_SPEC_SCHEMA },
    policyDigest: DIGEST_SCHEMA, createdAt: TEXT_SCHEMA, digest: DIGEST_SCHEMA,
  },
  required: [
    'schemaVersion', 'planId', 'projectId', 'workspaceId', 'workspaceBindingVersion',
    'domain', 'subjects', 'validators', 'policyDigest', 'createdAt', 'digest',
  ],
})

export const VALIDATION_REPORT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 }, reportId: TEXT_SCHEMA, projectId: TEXT_SCHEMA,
    workspaceId: TEXT_SCHEMA, workspaceBindingVersion: { type: 'integer', minimum: 1 },
    planId: TEXT_SCHEMA, planDigest: DIGEST_SCHEMA,
    subjects: { type: 'array', minItems: 1, items: SUBJECT_REF_SCHEMA },
    validatorResults: { type: 'array', minItems: 1, items: VALIDATOR_RESULT_SCHEMA },
    overall: { type: 'string', enum: ['passed', 'failed', 'blocked'] },
    completedAt: TEXT_SCHEMA, digest: DIGEST_SCHEMA,
  },
  required: [
    'schemaVersion', 'reportId', 'projectId', 'workspaceId', 'workspaceBindingVersion',
    'planId', 'planDigest', 'subjects', 'validatorResults', 'overall', 'completedAt', 'digest',
  ],
})

const REVIEW_PROPOSAL_PROPERTIES = Object.freeze({
  schemaVersion: { const: 1 }, kind: { const: 'review' }, reviewId: TEXT_SCHEMA,
  subjectRefs: { type: 'array', minItems: 1, items: SUBJECT_REF_SCHEMA },
  validationReportIds: ID_ARRAY_SCHEMA,
  findings: { type: 'array', items: FINDING_SCHEMA },
  recommendation: { type: 'string', enum: ['accept', 'revise', 'reject'] },
  supersedesReviewIds: ID_ARRAY_SCHEMA,
})
const REVIEW_PROPOSAL_REQUIRED = [
  'schemaVersion', 'kind', 'reviewId', 'subjectRefs', 'validationReportIds',
  'findings', 'recommendation', 'supersedesReviewIds',
] as const

export const REVIEW_PROPOSAL_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: REVIEW_PROPOSAL_PROPERTIES,
  required: REVIEW_PROPOSAL_REQUIRED,
})

export const REVIEW_RECORD_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    ...REVIEW_PROPOSAL_PROPERTIES,
    projectId: TEXT_SCHEMA, workspaceId: TEXT_SCHEMA,
    workspaceBindingVersion: { type: 'integer', minimum: 1 },
    createdAt: TEXT_SCHEMA, digest: DIGEST_SCHEMA,
  },
  required: [
    ...REVIEW_PROPOSAL_REQUIRED, 'projectId', 'workspaceId', 'workspaceBindingVersion',
    'createdAt', 'digest',
  ],
})

const SUPPORT_REF_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['evidence', 'result', 'claim', 'hypothesis'] },
    recordId: TEXT_SCHEMA, digest: DIGEST_SCHEMA,
  },
  required: ['kind', 'recordId', 'digest'],
})
const CALCULATION_PROPOSAL_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    operation: { type: 'string', enum: ['difference', 'ratio', 'percent-change', 'mean'] },
    operandResultIds: { type: 'array', minItems: 1, items: TEXT_SCHEMA },
  },
  required: ['operation', 'operandResultIds'],
})
const CLAIM_PROPOSAL_PROPERTIES = Object.freeze({
  schemaVersion: { const: 1 }, kind: { const: 'claim' }, claimId: TEXT_SCHEMA,
  statement: TEXT_SCHEMA, claimType: { type: 'string', enum: CLAIM_TYPES },
  supportRefs: { type: 'array', items: SUPPORT_REF_SCHEMA },
  calculation: { oneOf: [CALCULATION_PROPOSAL_SCHEMA, { type: 'null' }] },
  limitations: { type: 'array', items: TEXT_SCHEMA },
  intendedSections: { type: 'array', minItems: 1, items: { type: 'string', enum: MANUSCRIPT_SECTION_IDS } },
  validationReportIds: ID_ARRAY_SCHEMA,
  reviewRecordIds: ID_ARRAY_SCHEMA,
})
const CLAIM_PROPOSAL_REQUIRED = [
  'schemaVersion', 'kind', 'claimId', 'statement', 'claimType', 'supportRefs',
  'calculation', 'limitations', 'intendedSections', 'validationReportIds', 'reviewRecordIds',
] as const

export const CLAIM_PROPOSAL_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: CLAIM_PROPOSAL_PROPERTIES,
  required: CLAIM_PROPOSAL_REQUIRED,
})

const CALCULATION_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    ...(CALCULATION_PROPOSAL_SCHEMA.properties as Record<string, unknown>),
    value: { type: 'number' },
    inputDigests: { type: 'array', minItems: 1, items: DIGEST_SCHEMA },
  },
  required: ['operation', 'operandResultIds', 'value', 'inputDigests'],
})
const APPROVAL_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    requested: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
    outcome: { type: 'string', enum: ['pending', 'approved', 'rejected', 'cancelled', 'unavailable'] },
    source: { type: 'string', enum: ['user', 'coordinator'] },
    callId: TEXT_SCHEMA, decidedAt: TEXT_SCHEMA,
  },
  required: ['requested', 'outcome', 'source', 'callId', 'decidedAt'],
})

export const CLAIM_RECORD_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    ...CLAIM_PROPOSAL_PROPERTIES,
    projectId: TEXT_SCHEMA, workspaceId: TEXT_SCHEMA,
    workspaceBindingVersion: { type: 'integer', minimum: 1 },
    calculation: { oneOf: [CALCULATION_SCHEMA, { type: 'null' }] },
    supportState: { type: 'string', enum: CLAIM_SUPPORT_STATES },
    approvalState: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
    integrity: { type: 'string', enum: ['verified', 'failed'] },
    validity: { type: 'string', enum: ['current', 'stale'] },
    approval: APPROVAL_SCHEMA, committedAt: TEXT_SCHEMA, digest: DIGEST_SCHEMA,
  },
  required: [
    ...CLAIM_PROPOSAL_REQUIRED, 'projectId', 'workspaceId', 'workspaceBindingVersion',
    'supportState', 'approvalState', 'integrity', 'validity', 'approval', 'committedAt', 'digest',
  ],
})

export const WRITING_PACKET_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 }, packetId: TEXT_SCHEMA, projectId: TEXT_SCHEMA,
    workspaceId: TEXT_SCHEMA, workspaceBindingVersion: { type: 'integer', minimum: 1 },
    researchBrief: RESEARCH_BRIEF_SCHEMA,
    claims: { type: 'array', items: CLAIM_RECORD_SCHEMA },
    sources: { type: 'array', items: SOURCE_RECORD_SCHEMA },
    evidence: { type: 'array', items: EVIDENCE_RECORD_SCHEMA },
    experimentSpecs: { type: 'array', items: EXPERIMENT_SPEC_SCHEMA },
    runs: { type: 'array', items: RUN_RECORD_SCHEMA },
    results: { type: 'array', items: RESULT_RECORD_SCHEMA },
    validationReports: { type: 'array', items: VALIDATION_REPORT_SCHEMA },
    artifactRefs: { type: 'array', items: ARTIFACT_REF_SCHEMA },
    limitations: { type: 'array', items: TEXT_SCHEMA },
    forbiddenClaimIds: ID_ARRAY_SCHEMA,
    builtAt: TEXT_SCHEMA, digest: DIGEST_SCHEMA,
  },
  required: [
    'schemaVersion', 'packetId', 'projectId', 'workspaceId', 'workspaceBindingVersion',
    'researchBrief', 'claims', 'sources', 'evidence', 'experimentSpecs', 'runs', 'results',
    'validationReports', 'artifactRefs', 'limitations', 'forbiddenClaimIds', 'builtAt', 'digest',
  ],
})

const NUMERIC_REF_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: { literal: TEXT_SCHEMA, claimId: TEXT_SCHEMA, resultId: TEXT_SCHEMA },
  required: ['literal', 'claimId', 'resultId'],
})
const MANUSCRIPT_BLOCK_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    blockId: TEXT_SCHEMA, text: TEXT_SCHEMA,
    claimIds: { type: 'array', minItems: 1, items: TEXT_SCHEMA },
    evidenceIds: ID_ARRAY_SCHEMA, resultIds: ID_ARRAY_SCHEMA,
    numericRefs: { type: 'array', items: NUMERIC_REF_SCHEMA },
  },
  required: ['blockId', 'text', 'claimIds', 'evidenceIds', 'resultIds', 'numericRefs'],
})
const MANUSCRIPT_SECTION_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    sectionId: { type: 'string', enum: MANUSCRIPT_SECTION_IDS },
    title: TEXT_SCHEMA,
    blocks: { type: 'array', minItems: 1, items: MANUSCRIPT_BLOCK_SCHEMA },
  },
  required: ['sectionId', 'title', 'blocks'],
})
const MANUSCRIPT_CANDIDATE_PROPERTIES = Object.freeze({
  schemaVersion: { const: 1 }, kind: { const: 'manuscript' }, manuscriptId: TEXT_SCHEMA,
  packetId: TEXT_SCHEMA, packetDigest: DIGEST_SCHEMA, title: TEXT_SCHEMA,
  sections: { type: 'array', minItems: 1, items: MANUSCRIPT_SECTION_SCHEMA },
})
const MANUSCRIPT_CANDIDATE_REQUIRED = [
  'schemaVersion', 'kind', 'manuscriptId', 'packetId', 'packetDigest', 'title', 'sections',
] as const

export const MANUSCRIPT_CANDIDATE_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: MANUSCRIPT_CANDIDATE_PROPERTIES,
  required: MANUSCRIPT_CANDIDATE_REQUIRED,
})

export const MANUSCRIPT_AUDIT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 }, auditId: TEXT_SCHEMA, projectId: TEXT_SCHEMA,
    manuscriptId: TEXT_SCHEMA, packetId: TEXT_SCHEMA, packetDigest: DIGEST_SCHEMA,
    checks: {
      type: 'object', additionalProperties: false,
      properties: {
        packetCurrent: { type: 'boolean' }, claimsEligible: { type: 'boolean' },
        forbiddenClaimsAbsent: { type: 'boolean' }, numbersTraceable: { type: 'boolean' },
        literatureTraceable: { type: 'boolean' }, sectionsAllowed: { type: 'boolean' },
      },
      required: [
        'packetCurrent', 'claimsEligible', 'forbiddenClaimsAbsent', 'numbersTraceable',
        'literatureTraceable', 'sectionsAllowed',
      ],
    },
    findings: { type: 'array', items: FINDING_SCHEMA },
    overall: { type: 'string', enum: ['passed', 'failed', 'blocked'] },
    auditedAt: TEXT_SCHEMA, digest: DIGEST_SCHEMA,
  },
  required: [
    'schemaVersion', 'auditId', 'projectId', 'manuscriptId', 'packetId', 'packetDigest',
    'checks', 'findings', 'overall', 'auditedAt', 'digest',
  ],
})

export const MANUSCRIPT_RECORD_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    ...MANUSCRIPT_CANDIDATE_PROPERTIES,
    projectId: TEXT_SCHEMA, workspaceId: TEXT_SCHEMA,
    workspaceBindingVersion: { type: 'integer', minimum: 1 },
    auditId: TEXT_SCHEMA, status: { type: 'string', enum: ['validated', 'blocked'] },
    createdAt: TEXT_SCHEMA, digest: DIGEST_SCHEMA,
  },
  required: [
    ...MANUSCRIPT_CANDIDATE_REQUIRED, 'projectId', 'workspaceId', 'workspaceBindingVersion',
    'auditId', 'status', 'createdAt', 'digest',
  ],
})

export function parseValidationPlan(value: unknown): ValidationPlan {
  const record = exactRecord(value, 'ValidationPlan', [
    'schemaVersion', 'planId', 'projectId', 'workspaceId', 'workspaceBindingVersion',
    'domain', 'subjects', 'validators', 'policyDigest', 'createdAt', 'digest',
  ])
  version(record.schemaVersion, 'ValidationPlan.schemaVersion')
  const subjects = array(record.subjects, 'ValidationPlan.subjects').map((entry, index) => parseSubjectRef(entry, `ValidationPlan.subjects[${index}]`))
  const validators = array(record.validators, 'ValidationPlan.validators').map((entry, index) => parseValidatorSpec(entry, `ValidationPlan.validators[${index}]`))
  nonEmpty(subjects, 'ValidationPlan.subjects')
  nonEmpty(validators, 'ValidationPlan.validators')
  unique(subjects.map(subject => `${subject.kind}:${subject.subjectId}`), 'ValidationPlan subjects')
  unique(validators.map(validator => validator.validatorId), 'ValidationPlan validators')
  return {
    schemaVersion: 1,
    planId: id(record.planId, 'ValidationPlan.planId'),
    projectId: id(record.projectId, 'ValidationPlan.projectId'),
    workspaceId: id(record.workspaceId, 'ValidationPlan.workspaceId'),
    workspaceBindingVersion: positive(record.workspaceBindingVersion, 'ValidationPlan.workspaceBindingVersion'),
    domain: enumValue(record.domain, ['geodata', 'experiment', 'citation', 'manuscript'] as const, 'ValidationPlan.domain'),
    subjects,
    validators,
    policyDigest: digest(record.policyDigest, 'ValidationPlan.policyDigest'),
    createdAt: timestamp(record.createdAt, 'ValidationPlan.createdAt'),
    digest: digest(record.digest, 'ValidationPlan.digest'),
  }
}

export function parseValidationReport(value: unknown): ValidationReport {
  const record = exactRecord(value, 'ValidationReport', [
    'schemaVersion', 'reportId', 'projectId', 'workspaceId', 'workspaceBindingVersion',
    'planId', 'planDigest', 'subjects', 'validatorResults', 'overall', 'completedAt', 'digest',
  ])
  version(record.schemaVersion, 'ValidationReport.schemaVersion')
  const subjects = array(record.subjects, 'ValidationReport.subjects').map((entry, index) => parseSubjectRef(entry, `ValidationReport.subjects[${index}]`))
  const validatorResults = array(record.validatorResults, 'ValidationReport.validatorResults').map((entry, index) => parseValidatorResult(entry, `ValidationReport.validatorResults[${index}]`))
  nonEmpty(subjects, 'ValidationReport.subjects')
  nonEmpty(validatorResults, 'ValidationReport.validatorResults')
  unique(validatorResults.map(result => result.validatorId), 'ValidationReport validators')
  return {
    schemaVersion: 1,
    reportId: id(record.reportId, 'ValidationReport.reportId'),
    projectId: id(record.projectId, 'ValidationReport.projectId'),
    workspaceId: id(record.workspaceId, 'ValidationReport.workspaceId'),
    workspaceBindingVersion: positive(record.workspaceBindingVersion, 'ValidationReport.workspaceBindingVersion'),
    planId: id(record.planId, 'ValidationReport.planId'),
    planDigest: digest(record.planDigest, 'ValidationReport.planDigest'),
    subjects,
    validatorResults,
    overall: enumValue(record.overall, ['passed', 'failed', 'blocked'] as const, 'ValidationReport.overall'),
    completedAt: timestamp(record.completedAt, 'ValidationReport.completedAt'),
    digest: digest(record.digest, 'ValidationReport.digest'),
  }
}

export function parseReviewProposal(value: unknown): ReviewProposal {
  const record = exactRecord(value, 'ReviewProposal', [...REVIEW_PROPOSAL_REQUIRED])
  version(record.schemaVersion, 'ReviewProposal.schemaVersion')
  literal(record.kind, 'review', 'ReviewProposal.kind')
  const subjectRefs = array(record.subjectRefs, 'ReviewProposal.subjectRefs').map((entry, index) => parseSubjectRef(entry, `ReviewProposal.subjectRefs[${index}]`))
  nonEmpty(subjectRefs, 'ReviewProposal.subjectRefs')
  return {
    schemaVersion: 1, kind: 'review',
    reviewId: id(record.reviewId, 'ReviewProposal.reviewId'),
    subjectRefs,
    validationReportIds: idArray(record.validationReportIds, 'ReviewProposal.validationReportIds'),
    findings: array(record.findings, 'ReviewProposal.findings').map((entry, index) => parseFinding(entry, `ReviewProposal.findings[${index}]`)),
    recommendation: enumValue(record.recommendation, ['accept', 'revise', 'reject'] as const, 'ReviewProposal.recommendation'),
    supersedesReviewIds: idArray(record.supersedesReviewIds, 'ReviewProposal.supersedesReviewIds'),
  }
}

export function parseValidationSubjectRef(value: unknown): ValidationSubjectRef {
  return parseSubjectRef(value, 'ValidationSubjectRef')
}

export function parseReviewRecord(value: unknown): ReviewRecord {
  const record = exactRecord(value, 'ReviewRecord', [
    ...REVIEW_PROPOSAL_REQUIRED, 'projectId', 'workspaceId', 'workspaceBindingVersion', 'createdAt', 'digest',
  ])
  const proposal = parseReviewProposal(pick(record, REVIEW_PROPOSAL_REQUIRED))
  return {
    ...proposal,
    projectId: id(record.projectId, 'ReviewRecord.projectId'),
    workspaceId: id(record.workspaceId, 'ReviewRecord.workspaceId'),
    workspaceBindingVersion: positive(record.workspaceBindingVersion, 'ReviewRecord.workspaceBindingVersion'),
    createdAt: timestamp(record.createdAt, 'ReviewRecord.createdAt'),
    digest: digest(record.digest, 'ReviewRecord.digest'),
  }
}

export function parseClaimProposal(value: unknown): ClaimProposal {
  const record = exactRecord(value, 'ClaimProposal', [...CLAIM_PROPOSAL_REQUIRED])
  version(record.schemaVersion, 'ClaimProposal.schemaVersion')
  literal(record.kind, 'claim', 'ClaimProposal.kind')
  const supportRefs = array(record.supportRefs, 'ClaimProposal.supportRefs').map((entry, index) => parseSupportRef(entry, `ClaimProposal.supportRefs[${index}]`))
  unique(supportRefs.map(ref => `${ref.kind}:${ref.recordId}`), 'ClaimProposal support refs')
  const intendedSections = enumArray(record.intendedSections, MANUSCRIPT_SECTION_IDS, 'ClaimProposal.intendedSections')
  nonEmpty(intendedSections, 'ClaimProposal.intendedSections')
  return {
    schemaVersion: 1, kind: 'claim',
    claimId: id(record.claimId, 'ClaimProposal.claimId'),
    statement: text(record.statement, 'ClaimProposal.statement'),
    claimType: enumValue(record.claimType, CLAIM_TYPES, 'ClaimProposal.claimType'),
    supportRefs,
    calculation: record.calculation === null ? null : parseCalculationProposal(record.calculation),
    limitations: textArray(record.limitations, 'ClaimProposal.limitations'),
    intendedSections,
    validationReportIds: idArray(record.validationReportIds, 'ClaimProposal.validationReportIds'),
    reviewRecordIds: idArray(record.reviewRecordIds, 'ClaimProposal.reviewRecordIds'),
  }
}

export function parseClaimRecord(value: unknown): ClaimRecord {
  const record = exactRecord(value, 'ClaimRecord', [
    ...CLAIM_PROPOSAL_REQUIRED, 'projectId', 'workspaceId', 'workspaceBindingVersion',
    'supportState', 'approvalState', 'integrity', 'validity', 'approval', 'committedAt', 'digest',
  ])
  const proposal = parseClaimProposal(pick(record, CLAIM_PROPOSAL_REQUIRED))
  return {
    ...proposal,
    projectId: id(record.projectId, 'ClaimRecord.projectId'),
    workspaceId: id(record.workspaceId, 'ClaimRecord.workspaceId'),
    workspaceBindingVersion: positive(record.workspaceBindingVersion, 'ClaimRecord.workspaceBindingVersion'),
    calculation: record.calculation === null ? null : parseCalculation(record.calculation),
    supportState: enumValue(record.supportState, CLAIM_SUPPORT_STATES, 'ClaimRecord.supportState'),
    approvalState: enumValue(record.approvalState, ['pending', 'approved', 'rejected'] as const, 'ClaimRecord.approvalState'),
    integrity: enumValue(record.integrity, ['verified', 'failed'] as const, 'ClaimRecord.integrity'),
    validity: enumValue(record.validity, ['current', 'stale'] as const, 'ClaimRecord.validity'),
    approval: parseApproval(record.approval),
    committedAt: timestamp(record.committedAt, 'ClaimRecord.committedAt'),
    digest: digest(record.digest, 'ClaimRecord.digest'),
  }
}

export function parseWritingPacket(value: unknown): WritingPacket {
  const record = exactRecord(value, 'WritingPacket', [
    'schemaVersion', 'packetId', 'projectId', 'workspaceId', 'workspaceBindingVersion',
    'researchBrief', 'claims', 'sources', 'evidence', 'experimentSpecs', 'runs', 'results',
    'validationReports', 'artifactRefs', 'limitations', 'forbiddenClaimIds', 'builtAt', 'digest',
  ])
  version(record.schemaVersion, 'WritingPacket.schemaVersion')
  return {
    schemaVersion: 1,
    packetId: id(record.packetId, 'WritingPacket.packetId'),
    projectId: id(record.projectId, 'WritingPacket.projectId'),
    workspaceId: id(record.workspaceId, 'WritingPacket.workspaceId'),
    workspaceBindingVersion: positive(record.workspaceBindingVersion, 'WritingPacket.workspaceBindingVersion'),
    researchBrief: parseResearchBrief(record.researchBrief),
    claims: array(record.claims, 'WritingPacket.claims').map(parseClaimRecord),
    sources: array(record.sources, 'WritingPacket.sources').map(parseSourceRecord),
    evidence: array(record.evidence, 'WritingPacket.evidence').map(parseEvidenceRecord),
    experimentSpecs: array(record.experimentSpecs, 'WritingPacket.experimentSpecs').map(parseExperimentSpec),
    runs: array(record.runs, 'WritingPacket.runs').map(parseRunRecord),
    results: array(record.results, 'WritingPacket.results').map(parseResultRecord),
    validationReports: array(record.validationReports, 'WritingPacket.validationReports').map(parseValidationReport),
    artifactRefs: array(record.artifactRefs, 'WritingPacket.artifactRefs').map((entry, index) => parseArtifactRef(entry, `WritingPacket.artifactRefs[${index}]`)),
    limitations: textArray(record.limitations, 'WritingPacket.limitations'),
    forbiddenClaimIds: idArray(record.forbiddenClaimIds, 'WritingPacket.forbiddenClaimIds'),
    builtAt: timestamp(record.builtAt, 'WritingPacket.builtAt'),
    digest: digest(record.digest, 'WritingPacket.digest'),
  }
}

export function parseManuscriptCandidate(value: unknown): ManuscriptCandidate {
  const record = exactRecord(value, 'ManuscriptCandidate', [...MANUSCRIPT_CANDIDATE_REQUIRED])
  version(record.schemaVersion, 'ManuscriptCandidate.schemaVersion')
  literal(record.kind, 'manuscript', 'ManuscriptCandidate.kind')
  const sections = array(record.sections, 'ManuscriptCandidate.sections').map((entry, index) => parseSection(entry, `ManuscriptCandidate.sections[${index}]`))
  nonEmpty(sections, 'ManuscriptCandidate.sections')
  unique(sections.map(section => section.sectionId), 'ManuscriptCandidate sections')
  return {
    schemaVersion: 1, kind: 'manuscript',
    manuscriptId: id(record.manuscriptId, 'ManuscriptCandidate.manuscriptId'),
    packetId: id(record.packetId, 'ManuscriptCandidate.packetId'),
    packetDigest: digest(record.packetDigest, 'ManuscriptCandidate.packetDigest'),
    title: text(record.title, 'ManuscriptCandidate.title'),
    sections,
  }
}

export function parseManuscriptAudit(value: unknown): ManuscriptAudit {
  const record = exactRecord(value, 'ManuscriptAudit', [
    'schemaVersion', 'auditId', 'projectId', 'manuscriptId', 'packetId', 'packetDigest',
    'checks', 'findings', 'overall', 'auditedAt', 'digest',
  ])
  version(record.schemaVersion, 'ManuscriptAudit.schemaVersion')
  const checks = exactRecord(record.checks, 'ManuscriptAudit.checks', [
    'packetCurrent', 'claimsEligible', 'forbiddenClaimsAbsent', 'numbersTraceable',
    'literatureTraceable', 'sectionsAllowed',
  ])
  return {
    schemaVersion: 1,
    auditId: id(record.auditId, 'ManuscriptAudit.auditId'),
    projectId: id(record.projectId, 'ManuscriptAudit.projectId'),
    manuscriptId: id(record.manuscriptId, 'ManuscriptAudit.manuscriptId'),
    packetId: id(record.packetId, 'ManuscriptAudit.packetId'),
    packetDigest: digest(record.packetDigest, 'ManuscriptAudit.packetDigest'),
    checks: {
      packetCurrent: bool(checks.packetCurrent, 'ManuscriptAudit.checks.packetCurrent'),
      claimsEligible: bool(checks.claimsEligible, 'ManuscriptAudit.checks.claimsEligible'),
      forbiddenClaimsAbsent: bool(checks.forbiddenClaimsAbsent, 'ManuscriptAudit.checks.forbiddenClaimsAbsent'),
      numbersTraceable: bool(checks.numbersTraceable, 'ManuscriptAudit.checks.numbersTraceable'),
      literatureTraceable: bool(checks.literatureTraceable, 'ManuscriptAudit.checks.literatureTraceable'),
      sectionsAllowed: bool(checks.sectionsAllowed, 'ManuscriptAudit.checks.sectionsAllowed'),
    },
    findings: array(record.findings, 'ManuscriptAudit.findings').map((entry, index) => parseFinding(entry, `ManuscriptAudit.findings[${index}]`)),
    overall: enumValue(record.overall, ['passed', 'failed', 'blocked'] as const, 'ManuscriptAudit.overall'),
    auditedAt: timestamp(record.auditedAt, 'ManuscriptAudit.auditedAt'),
    digest: digest(record.digest, 'ManuscriptAudit.digest'),
  }
}

export function parseManuscriptRecord(value: unknown): ManuscriptRecord {
  const record = exactRecord(value, 'ManuscriptRecord', [
    ...MANUSCRIPT_CANDIDATE_REQUIRED, 'projectId', 'workspaceId', 'workspaceBindingVersion',
    'auditId', 'status', 'createdAt', 'digest',
  ])
  const candidate = parseManuscriptCandidate(pick(record, MANUSCRIPT_CANDIDATE_REQUIRED))
  return {
    ...candidate,
    projectId: id(record.projectId, 'ManuscriptRecord.projectId'),
    workspaceId: id(record.workspaceId, 'ManuscriptRecord.workspaceId'),
    workspaceBindingVersion: positive(record.workspaceBindingVersion, 'ManuscriptRecord.workspaceBindingVersion'),
    auditId: id(record.auditId, 'ManuscriptRecord.auditId'),
    status: enumValue(record.status, ['validated', 'blocked'] as const, 'ManuscriptRecord.status'),
    createdAt: timestamp(record.createdAt, 'ManuscriptRecord.createdAt'),
    digest: digest(record.digest, 'ManuscriptRecord.digest'),
  }
}

function parseSubjectRef(value: unknown, field: string): ValidationSubjectRef {
  const record = exactRecord(value, field, ['kind', 'subjectId', 'digest'])
  return {
    kind: enumValue(record.kind, VALIDATION_SUBJECT_KINDS, `${field}.kind`),
    subjectId: id(record.subjectId, `${field}.subjectId`),
    digest: digest(record.digest, `${field}.digest`),
  }
}

function parseValidatorSpec(value: unknown, field: string): ValidationValidatorSpec {
  const record = exactRecord(value, field, ['validatorId', 'version', 'mandatory', 'configDigest'])
  return {
    validatorId: id(record.validatorId, `${field}.validatorId`),
    version: text(record.version, `${field}.version`),
    mandatory: bool(record.mandatory, `${field}.mandatory`),
    configDigest: digest(record.configDigest, `${field}.configDigest`),
  }
}

function parseValidatorResult(value: unknown, field: string): ValidationValidatorResult {
  const record = exactRecord(value, field, ['validatorId', 'version', 'mandatory', 'configDigest', 'status', 'findings'])
  return {
    ...parseValidatorSpec(pick(record, ['validatorId', 'version', 'mandatory', 'configDigest']), field),
    status: enumValue(record.status, ['passed', 'failed', 'blocked', 'error', 'not-applicable'] as const, `${field}.status`),
    findings: array(record.findings, `${field}.findings`).map((entry, index) => parseFinding(entry, `${field}.findings[${index}]`)),
  }
}

function parseFinding(value: unknown, field: string): ValidationFinding {
  const record = exactRecord(value, field, ['findingId', 'validatorId', 'severity', 'code', 'message', 'subjectIds'])
  return {
    findingId: id(record.findingId, `${field}.findingId`),
    validatorId: id(record.validatorId, `${field}.validatorId`),
    severity: enumValue(record.severity, ['info', 'warning', 'error', 'hard'] as const, `${field}.severity`),
    code: id(record.code, `${field}.code`),
    message: text(record.message, `${field}.message`),
    subjectIds: idArray(record.subjectIds, `${field}.subjectIds`),
  }
}

function parseSupportRef(value: unknown, field: string): ClaimSupportRef {
  const record = exactRecord(value, field, ['kind', 'recordId', 'digest'])
  return {
    kind: enumValue(record.kind, ['evidence', 'result', 'claim', 'hypothesis'] as const, `${field}.kind`),
    recordId: id(record.recordId, `${field}.recordId`),
    digest: digest(record.digest, `${field}.digest`),
  }
}

function parseCalculationProposal(value: unknown): ClaimCalculationProposal {
  const record = exactRecord(value, 'ClaimCalculationProposal', ['operation', 'operandResultIds'])
  return {
    operation: enumValue(record.operation, ['difference', 'ratio', 'percent-change', 'mean'] as const, 'ClaimCalculationProposal.operation'),
    operandResultIds: idArray(record.operandResultIds, 'ClaimCalculationProposal.operandResultIds'),
  }
}

function parseCalculation(value: unknown): ClaimCalculation {
  const record = exactRecord(value, 'ClaimCalculation', ['operation', 'operandResultIds', 'value', 'inputDigests'])
  const proposal = parseCalculationProposal(pick(record, ['operation', 'operandResultIds']))
  const numeric = number(record.value, 'ClaimCalculation.value')
  const inputDigests = digestArray(record.inputDigests, 'ClaimCalculation.inputDigests')
  nonEmpty(inputDigests, 'ClaimCalculation.inputDigests')
  return { ...proposal, value: numeric, inputDigests }
}

function parseApproval(value: unknown): ClaimApprovalRecord {
  const record = exactRecord(value, 'ClaimApprovalRecord', ['requested', 'outcome', 'source', 'callId', 'decidedAt'])
  return {
    requested: enumValue(record.requested, ['pending', 'approved', 'rejected'] as const, 'ClaimApprovalRecord.requested'),
    outcome: enumValue(record.outcome, ['pending', 'approved', 'rejected', 'cancelled', 'unavailable'] as const, 'ClaimApprovalRecord.outcome'),
    source: enumValue(record.source, ['user', 'coordinator'] as const, 'ClaimApprovalRecord.source'),
    callId: id(record.callId, 'ClaimApprovalRecord.callId'),
    decidedAt: timestamp(record.decidedAt, 'ClaimApprovalRecord.decidedAt'),
  }
}

function parseArtifactRef(value: unknown, field: string): ArtifactRef {
  const record = exactRecord(value, field, ['artifactId', 'digest', 'kind'])
  return {
    artifactId: id(record.artifactId, `${field}.artifactId`),
    digest: digest(record.digest, `${field}.digest`),
    kind: text(record.kind, `${field}.kind`),
  }
}

function parseSection(value: unknown, field: string): ManuscriptSection {
  const record = exactRecord(value, field, ['sectionId', 'title', 'blocks'])
  const blocks = array(record.blocks, `${field}.blocks`).map((entry, index) => parseBlock(entry, `${field}.blocks[${index}]`))
  nonEmpty(blocks, `${field}.blocks`)
  unique(blocks.map(block => block.blockId), `${field} block IDs`)
  return {
    sectionId: enumValue(record.sectionId, MANUSCRIPT_SECTION_IDS, `${field}.sectionId`),
    title: text(record.title, `${field}.title`),
    blocks,
  }
}

function parseBlock(value: unknown, field: string): ManuscriptBlock {
  const record = exactRecord(value, field, ['blockId', 'text', 'claimIds', 'evidenceIds', 'resultIds', 'numericRefs'])
  const claimIds = idArray(record.claimIds, `${field}.claimIds`)
  nonEmpty(claimIds, `${field}.claimIds`)
  return {
    blockId: id(record.blockId, `${field}.blockId`),
    text: text(record.text, `${field}.text`),
    claimIds,
    evidenceIds: idArray(record.evidenceIds, `${field}.evidenceIds`),
    resultIds: idArray(record.resultIds, `${field}.resultIds`),
    numericRefs: array(record.numericRefs, `${field}.numericRefs`).map((entry, index) => parseNumericRef(entry, `${field}.numericRefs[${index}]`)),
  }
}

function parseNumericRef(value: unknown, field: string): ManuscriptNumericRef {
  const record = exactRecord(value, field, ['literal', 'claimId', 'resultId'])
  return {
    literal: text(record.literal, `${field}.literal`),
    claimId: id(record.claimId, `${field}.claimId`),
    resultId: id(record.resultId, `${field}.resultId`),
  }
}

function exactRecord(value: unknown, field: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${field} must be an object`)
  const record = value as Record<string, unknown>
  const unexpected = Object.keys(record).filter(key => !allowed.includes(key))
  const missing = allowed.filter(key => !Object.hasOwn(record, key))
  if (unexpected.length > 0) throw new TypeError(`${field} contains unsupported fields: ${unexpected.join(', ')}`)
  if (missing.length > 0) throw new TypeError(`${field} is missing fields: ${missing.join(', ')}`)
  return record
}

function pick(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map(key => [key, record[key]]))
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  return value
}

function nonEmpty<T>(value: readonly T[], field: string): void {
  if (value.length === 0) throw new TypeError(`${field} must not be empty`)
}

function unique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${field} must be unique`)
}

function idArray(value: unknown, field: string): string[] {
  const values = array(value, field).map((entry, index) => id(entry, `${field}[${index}]`))
  unique(values, field)
  return values
}

function textArray(value: unknown, field: string): string[] {
  return array(value, field).map((entry, index) => text(entry, `${field}[${index}]`))
}

function digestArray(value: unknown, field: string): Sha256Digest[] {
  return array(value, field).map((entry, index) => digest(entry, `${field}[${index}]`))
}

function enumArray<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number][] {
  const values = array(value, field).map((entry, index) => enumValue(entry, allowed, `${field}[${index}]`))
  unique(values, field)
  return values
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new TypeError(`${field} is invalid`)
  return value as T[number]
}

function version(value: unknown, field: string): void {
  if (value !== 1) throw new TypeError(`${field} must be 1`)
}

function literal(value: unknown, expected: string, field: string): void {
  if (value !== expected) throw new TypeError(`${field} must be ${expected}`)
}

function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(value)) throw new TypeError(`${field} is invalid`)
  return value
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${field} must be non-empty`)
  return value
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be boolean`)
  return value
}

function number(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${field} must be finite`)
  return value
}

function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive integer`)
  return value as number
}

function digest(value: unknown, field: string): Sha256Digest {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) throw new TypeError(`${field} must be a SHA-256 digest`)
  return value as Sha256Digest
}

function timestamp(value: unknown, field: string): string {
  const result = text(value, field)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(result)) throw new TypeError(`${field} must be UTC`)
  return result
}
