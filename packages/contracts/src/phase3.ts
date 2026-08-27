import { createHash } from 'node:crypto'
import type { JsonValue } from './phase2.js'
import type { Sha256Digest } from './index.js'

export const PHASE3_SCHEMA_VERSION = 1 as const

export const LITERATURE_STOP_REASONS = [
  'result-limit',
  'page-limit',
  'rate-limited',
  'timeout',
  'cancelled',
  'provider-failure',
  'no-new-items',
] as const

export type LiteratureStopReason = typeof LITERATURE_STOP_REASONS[number]
export type LiteratureCompleteness = 'complete' | 'partial'
export type EvidenceRelation =
  | 'supports'
  | 'partially-supports'
  | 'contradicts'
  | 'background-only'
  | 'insufficient'

export interface LiteratureSearchFilters {
  readonly yearStart: number | null
  readonly yearEnd: number | null
  readonly publicationTypes: readonly string[]
}

export interface LiteratureSearchRequest {
  readonly query: string
  readonly filters: LiteratureSearchFilters
  readonly maxResults: number
}

export interface LiteratureContinuationRequest {
  readonly continuationId: string
}

export interface LiteratureAuthor {
  readonly name: string
  readonly orcid: string | null
}

export interface LiteratureItem {
  readonly providerItemId: string
  readonly title: string
  readonly authors: readonly LiteratureAuthor[]
  readonly year: number | null
  readonly venue: string | null
  readonly doi: string | null
  readonly stableIdentifier: string
  readonly sourceType: string
  readonly url: string | null
}

export interface LiteratureWarning {
  readonly code: string
  readonly message: string
}

export interface LiteratureProviderTrace {
  readonly providerId: string
  readonly providerVersion: string
  readonly retrievedAt: string
  readonly credentialRef: string | null
  readonly credentialBindingEpoch: number
  readonly requestId: string | null
}

export interface LiteratureSearchChainTrace {
  readonly chainId: string
  readonly generation: number
  readonly requestDigest: Sha256Digest
  readonly pagesAdvancedTotal: number
  readonly uniqueItemsTotal: number
}

export interface LiteratureContinuationRef {
  readonly continuationId: string
  readonly generation: number
  readonly expiresAt: string
}

export interface LiteratureSearchResult {
  readonly items: readonly LiteratureItem[]
  readonly completeness: LiteratureCompleteness
  readonly stopReason?: LiteratureStopReason
  readonly continuationRef?: LiteratureContinuationRef
  readonly warnings: readonly LiteratureWarning[]
  readonly providerTrace: LiteratureProviderTrace
  readonly searchChainTrace: LiteratureSearchChainTrace
  readonly trace: {
    readonly pagesAdvanced: number
  }
}

export interface LiteratureContinuationOwner {
  readonly projectBindingId: string
  readonly rootSessionId: string
  readonly operatorScopeId: string
  readonly profileId: 'georesearch'
  readonly requiredRole: 'literature'
}

export interface LiteratureContinuationProviderBinding {
  readonly providerId: string
  readonly providerVersion: string
  readonly continuationFormatDigest: Sha256Digest
  readonly credentialRef: string | null
  readonly credentialBindingEpoch: number
}

export interface LiteratureContinuationReservation {
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly reservationEpoch: number
  readonly fence: Sha256Digest
  readonly reservedAt: string
  readonly leaseExpiresAt: string
}

export type LiteratureContinuationState =
  | 'active'
  | 'reserved'
  | 'dispatched-unknown'
  | 'consumed'
  | 'expired'
  | 'revoked'

export interface LiteratureContinuationRecord {
  readonly schemaVersion: 1
  readonly continuationIdDigest: Sha256Digest
  readonly chainId: string
  readonly generation: number
  readonly state: LiteratureContinuationState
  readonly owner: LiteratureContinuationOwner
  readonly providerBinding: LiteratureContinuationProviderBinding
  readonly encryptedUpstreamState: string
  readonly upstreamStateDigest: Sha256Digest
  readonly expiresAt: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly reservationEpoch: number
  readonly reservation?: LiteratureContinuationReservation
  readonly exactResult?: LiteratureSearchResult
  readonly exactResultDigest?: Sha256Digest
  readonly consumedOutcome?: Sha256Digest
  readonly revocationCode?: string
}

export interface ContinuationAdvanceOutcome {
  readonly schemaVersion: 1
  readonly advanceId: Sha256Digest
  readonly continuationIdDigest: Sha256Digest
  readonly chainId: string
  readonly generation: number
  readonly reservationEpoch: number
  readonly fence: Sha256Digest
  readonly operationKey: Sha256Digest
  readonly requestDigest: Sha256Digest
  readonly providerId: string
  readonly providerVersion: string
  readonly credentialBindingEpoch: number
  readonly upstreamPagesAdvanced: number
  readonly exactResult: LiteratureSearchResult
  readonly exactResultDigest: Sha256Digest
  readonly successor?: {
    readonly continuationId: string
    readonly continuationIdDigest: Sha256Digest
    readonly generation: number
    readonly encryptedUpstreamState: string
    readonly upstreamStateDigest: Sha256Digest
    readonly expiresAt: string
  }
  readonly createdAt: string
}

export interface LiteratureProviderCapability {
  readonly providerId: string
  readonly providerVersion: string
  readonly continuationFormatDigest: Sha256Digest
  readonly replaySemantics: 'replay-safe-read'
  readonly maxPageSize: number
  readonly supportsCredentialRef: boolean
}

export interface LiteratureProviderPage {
  readonly items: readonly LiteratureItem[]
  readonly nextUpstreamState: JsonValue | null
  readonly done: boolean
  readonly warnings: readonly LiteratureWarning[]
  readonly requestId: string | null
}

export interface LiteratureSearchChainRecord {
  readonly schemaVersion: 1
  readonly chainId: string
  readonly owner: LiteratureContinuationOwner
  readonly request: LiteratureSearchRequest
  readonly requestDigest: Sha256Digest
  readonly providerBinding: LiteratureContinuationProviderBinding
  readonly pagesAdvanced: number
  readonly uniqueItemCount: number
  readonly seenProviderItemIds: readonly string[]
  readonly itemsByProviderId: Readonly<Record<string, LiteratureItem>>
  readonly createdAt: string
  readonly updatedAt: string
}

export interface PaperReadRequest {
  readonly artifactId: string
  readonly pageStart?: number
  readonly pageEnd?: number
}

export interface PaperPageText {
  readonly page: number
  readonly text: string
  readonly textBytes: number
}

export interface PaperMetadata {
  readonly title: string | null
  readonly author: string | null
  readonly subject: string | null
  readonly creator: string | null
  readonly producer: string | null
}

export interface PaperReadLineage {
  readonly providerId: string
  readonly providerVersion: string
  readonly parserId: string
  readonly parserVersion: string
  readonly configDigest: Sha256Digest
}

export interface PaperReadResult {
  readonly artifactId: string
  readonly pdfDigest: Sha256Digest
  readonly pageCount: number
  readonly requestedRange: {
    readonly start: number
    readonly end: number | null
  }
  readonly completedRange: {
    readonly start: number
    readonly end: number
  }
  readonly completeness: 'complete' | 'partial'
  readonly partialReason?: 'page-limit' | 'result-text-limit'
  readonly nextPageStart?: number
  readonly textStatus: 'extractable' | 'no-extractable-text'
  readonly metadata: PaperMetadata
  readonly pages: readonly PaperPageText[]
  readonly warnings: readonly LiteratureWarning[]
  readonly lineage: PaperReadLineage
  readonly readReceiptId: string
  readonly readReceiptDigest: Sha256Digest
}

export interface SourceExternalRef {
  readonly url: string
  readonly label: string | null
}

export interface SourceRecord {
  readonly schemaVersion: 1
  readonly sourceId: string
  readonly title: string
  readonly authors: readonly LiteratureAuthor[]
  readonly year: number | null
  readonly venue: string | null
  readonly stableIdentifier: {
    readonly kind: 'doi' | 'provider' | 'url' | 'other'
    readonly value: string
  }
  readonly sourceType: string
  readonly versionRelation: {
    readonly kind: 'none' | 'is-version-of' | 'has-version' | 'is-preprint-of' | 'is-version-of-record'
    readonly relatedIdentifier: string | null
  }
  readonly retrievedAt: string
  readonly providerTrace: LiteratureProviderTrace
  readonly codeRefs: readonly SourceExternalRef[]
  readonly dataRefs: readonly SourceExternalRef[]
  readonly status: 'resolved' | 'partial' | 'unresolved'
  readonly searchChain: {
    readonly chainId: string
    readonly generation: number
    readonly providerItemId: string
  }
  readonly digest: Sha256Digest
}

export interface EvidenceLocator {
  readonly pageStart: number
  readonly pageEnd: number
}

export interface EvidenceCandidate {
  readonly schemaVersion: 1
  readonly sourceId: string
  readonly artifactId: string
  readonly paperReadReceiptId: string
  readonly locator: EvidenceLocator
  readonly proposition: string
  readonly relation: EvidenceRelation
  readonly paraphrase: string
  readonly quotedText?: string
  readonly limitations: readonly string[]
}

export interface EvidenceRecord extends EvidenceCandidate {
  readonly evidenceId: string
  readonly artifactDigest: Sha256Digest
  readonly extractionLineage: PaperReadLineage
  readonly reviewStatus: 'pending' | 'accepted' | 'rejected' | 'needs-review'
  readonly committedAt: string
  readonly digest: Sha256Digest
}

export interface CitationCheckResult {
  readonly evidenceId: string
  readonly sourceId: string
  readonly status: 'valid' | 'stale' | 'invalid'
  readonly checks: {
    readonly sourceRegistered: boolean
    readonly artifactCurrent: boolean
    readonly artifactDigestMatches: boolean
    readonly pageRangeCovered: boolean
    readonly parserLineagePresent: boolean
  }
  readonly warnings: readonly LiteratureWarning[]
}

const SHA256_SCHEMA = Object.freeze({ type: 'string', pattern: '^sha256:[0-9a-f]{64}$' })
const UTC_SCHEMA = Object.freeze({
  type: 'string',
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
})
const NULLABLE_STRING_SCHEMA = Object.freeze({ oneOf: [{ type: 'string' }, { type: 'null' }] })
const NULLABLE_YEAR_SCHEMA = Object.freeze({ oneOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] })
const AUTHOR_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    orcid: NULLABLE_STRING_SCHEMA,
  },
  required: ['name', 'orcid'],
})
const WARNING_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', minLength: 1 },
    message: { type: 'string', minLength: 1 },
  },
  required: ['code', 'message'],
})
const PROVIDER_TRACE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    providerId: { type: 'string', minLength: 1 },
    providerVersion: { type: 'string', minLength: 1 },
    retrievedAt: UTC_SCHEMA,
    credentialRef: NULLABLE_STRING_SCHEMA,
    credentialBindingEpoch: { type: 'integer', minimum: 0 },
    requestId: NULLABLE_STRING_SCHEMA,
  },
  required: [
    'providerId', 'providerVersion', 'retrievedAt', 'credentialRef',
    'credentialBindingEpoch', 'requestId',
  ],
})
const LITERATURE_ITEM_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    providerItemId: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    authors: { type: 'array', items: AUTHOR_SCHEMA },
    year: NULLABLE_YEAR_SCHEMA,
    venue: NULLABLE_STRING_SCHEMA,
    doi: NULLABLE_STRING_SCHEMA,
    stableIdentifier: { type: 'string', minLength: 1 },
    sourceType: { type: 'string', minLength: 1 },
    url: NULLABLE_STRING_SCHEMA,
  },
  required: [
    'providerItemId', 'title', 'authors', 'year', 'venue', 'doi',
    'stableIdentifier', 'sourceType', 'url',
  ],
})
const CONTINUATION_REF_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    continuationId: { type: 'string', minLength: 32 },
    generation: { type: 'integer', minimum: 1 },
    expiresAt: UTC_SCHEMA,
  },
  required: ['continuationId', 'generation', 'expiresAt'],
})
const SEARCH_CHAIN_TRACE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    chainId: { type: 'string', minLength: 1 },
    generation: { type: 'integer', minimum: 1 },
    requestDigest: SHA256_SCHEMA,
    pagesAdvancedTotal: { type: 'integer', minimum: 0 },
    uniqueItemsTotal: { type: 'integer', minimum: 0 },
  },
  required: ['chainId', 'generation', 'requestDigest', 'pagesAdvancedTotal', 'uniqueItemsTotal'],
})

export const LITERATURE_SEARCH_REQUEST_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', minLength: 1 },
    filters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        yearStart: NULLABLE_YEAR_SCHEMA,
        yearEnd: NULLABLE_YEAR_SCHEMA,
        publicationTypes: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1 } },
      },
      required: ['yearStart', 'yearEnd', 'publicationTypes'],
    },
    maxResults: { type: 'integer', minimum: 1, maximum: 100 },
  },
  required: ['query', 'filters', 'maxResults'],
})

export const LITERATURE_CONTINUE_REQUEST_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: { continuationId: { type: 'string', minLength: 32 } },
  required: ['continuationId'],
})

export const LITERATURE_SEARCH_RESULT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    items: { type: 'array', items: LITERATURE_ITEM_SCHEMA },
    completeness: { type: 'string', enum: ['complete', 'partial'] },
    stopReason: { type: 'string', enum: [...LITERATURE_STOP_REASONS] },
    continuationRef: CONTINUATION_REF_SCHEMA,
    warnings: { type: 'array', items: WARNING_SCHEMA },
    providerTrace: PROVIDER_TRACE_SCHEMA,
    searchChainTrace: SEARCH_CHAIN_TRACE_SCHEMA,
    trace: {
      type: 'object',
      additionalProperties: false,
      properties: { pagesAdvanced: { type: 'integer', minimum: 0 } },
      required: ['pagesAdvanced'],
    },
  },
  required: ['items', 'completeness', 'warnings', 'providerTrace', 'searchChainTrace', 'trace'],
})

const CONTINUATION_OWNER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    projectBindingId: { type: 'string', minLength: 1 },
    rootSessionId: { type: 'string', minLength: 1 },
    operatorScopeId: { type: 'string', minLength: 32 },
    profileId: { const: 'georesearch' },
    requiredRole: { const: 'literature' },
  },
  required: ['projectBindingId', 'rootSessionId', 'operatorScopeId', 'profileId', 'requiredRole'],
})
const PROVIDER_BINDING_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    providerId: { type: 'string', minLength: 1 },
    providerVersion: { type: 'string', minLength: 1 },
    continuationFormatDigest: SHA256_SCHEMA,
    credentialRef: NULLABLE_STRING_SCHEMA,
    credentialBindingEpoch: { type: 'integer', minimum: 0 },
  },
  required: [
    'providerId', 'providerVersion', 'continuationFormatDigest',
    'credentialRef', 'credentialBindingEpoch',
  ],
})
const RESERVATION_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    operationKey: SHA256_SCHEMA,
    requestDigest: SHA256_SCHEMA,
    reservationEpoch: { type: 'integer', minimum: 1 },
    fence: SHA256_SCHEMA,
    reservedAt: UTC_SCHEMA,
    leaseExpiresAt: UTC_SCHEMA,
  },
  required: ['operationKey', 'requestDigest', 'reservationEpoch', 'fence', 'reservedAt', 'leaseExpiresAt'],
})

export const LITERATURE_CONTINUATION_RECORD_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    continuationIdDigest: SHA256_SCHEMA,
    chainId: { type: 'string', minLength: 1 },
    generation: { type: 'integer', minimum: 1 },
    state: {
      type: 'string',
      enum: ['active', 'reserved', 'dispatched-unknown', 'consumed', 'expired', 'revoked'],
    },
    owner: CONTINUATION_OWNER_SCHEMA,
    providerBinding: PROVIDER_BINDING_SCHEMA,
    encryptedUpstreamState: { type: 'string', minLength: 1 },
    upstreamStateDigest: SHA256_SCHEMA,
    expiresAt: UTC_SCHEMA,
    createdAt: UTC_SCHEMA,
    updatedAt: UTC_SCHEMA,
    reservationEpoch: { type: 'integer', minimum: 0 },
    reservation: RESERVATION_SCHEMA,
    exactResult: LITERATURE_SEARCH_RESULT_SCHEMA,
    exactResultDigest: SHA256_SCHEMA,
    consumedOutcome: SHA256_SCHEMA,
    revocationCode: { type: 'string', minLength: 1 },
  },
  required: [
    'schemaVersion', 'continuationIdDigest', 'chainId', 'generation', 'state',
    'owner', 'providerBinding', 'encryptedUpstreamState', 'upstreamStateDigest',
    'expiresAt', 'createdAt', 'updatedAt', 'reservationEpoch',
  ],
})

export const CONTINUATION_ADVANCE_OUTCOME_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    advanceId: SHA256_SCHEMA,
    continuationIdDigest: SHA256_SCHEMA,
    chainId: { type: 'string', minLength: 1 },
    generation: { type: 'integer', minimum: 1 },
    reservationEpoch: { type: 'integer', minimum: 1 },
    fence: SHA256_SCHEMA,
    operationKey: SHA256_SCHEMA,
    requestDigest: SHA256_SCHEMA,
    providerId: { type: 'string', minLength: 1 },
    providerVersion: { type: 'string', minLength: 1 },
    credentialBindingEpoch: { type: 'integer', minimum: 0 },
    upstreamPagesAdvanced: { type: 'integer', minimum: 1 },
    exactResult: LITERATURE_SEARCH_RESULT_SCHEMA,
    exactResultDigest: SHA256_SCHEMA,
    successor: {
      type: 'object',
      additionalProperties: false,
      properties: {
        continuationId: { type: 'string', minLength: 32 },
        continuationIdDigest: SHA256_SCHEMA,
        generation: { type: 'integer', minimum: 2 },
        encryptedUpstreamState: { type: 'string', minLength: 1 },
        upstreamStateDigest: SHA256_SCHEMA,
        expiresAt: UTC_SCHEMA,
      },
      required: [
        'continuationId', 'continuationIdDigest', 'generation',
        'encryptedUpstreamState', 'upstreamStateDigest', 'expiresAt',
      ],
    },
    createdAt: UTC_SCHEMA,
  },
  required: [
    'schemaVersion', 'advanceId', 'continuationIdDigest', 'chainId', 'generation',
    'reservationEpoch', 'fence', 'operationKey', 'requestDigest', 'providerId',
    'providerVersion', 'credentialBindingEpoch', 'upstreamPagesAdvanced',
    'exactResult', 'exactResultDigest', 'createdAt',
  ],
})

const PAPER_LINEAGE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    providerId: { type: 'string', minLength: 1 },
    providerVersion: { type: 'string', minLength: 1 },
    parserId: { type: 'string', minLength: 1 },
    parserVersion: { type: 'string', minLength: 1 },
    configDigest: SHA256_SCHEMA,
  },
  required: ['providerId', 'providerVersion', 'parserId', 'parserVersion', 'configDigest'],
})

export const PAPER_READ_RESULT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    artifactId: { type: 'string', minLength: 1 },
    pdfDigest: SHA256_SCHEMA,
    pageCount: { type: 'integer', minimum: 1 },
    requestedRange: {
      type: 'object',
      additionalProperties: false,
      properties: {
        start: { type: 'integer', minimum: 1 },
        end: { oneOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }] },
      },
      required: ['start', 'end'],
    },
    completedRange: {
      type: 'object',
      additionalProperties: false,
      properties: {
        start: { type: 'integer', minimum: 1 },
        end: { type: 'integer', minimum: 1 },
      },
      required: ['start', 'end'],
    },
    completeness: { type: 'string', enum: ['complete', 'partial'] },
    partialReason: { type: 'string', enum: ['page-limit', 'result-text-limit'] },
    nextPageStart: { type: 'integer', minimum: 1 },
    textStatus: { type: 'string', enum: ['extractable', 'no-extractable-text'] },
    metadata: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: NULLABLE_STRING_SCHEMA,
        author: NULLABLE_STRING_SCHEMA,
        subject: NULLABLE_STRING_SCHEMA,
        creator: NULLABLE_STRING_SCHEMA,
        producer: NULLABLE_STRING_SCHEMA,
      },
      required: ['title', 'author', 'subject', 'creator', 'producer'],
    },
    pages: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page: { type: 'integer', minimum: 1 },
          text: { type: 'string' },
          textBytes: { type: 'integer', minimum: 0 },
        },
        required: ['page', 'text', 'textBytes'],
      },
    },
    warnings: { type: 'array', items: WARNING_SCHEMA },
    lineage: PAPER_LINEAGE_SCHEMA,
    readReceiptId: { type: 'string', minLength: 1 },
    readReceiptDigest: SHA256_SCHEMA,
  },
  required: [
    'artifactId', 'pdfDigest', 'pageCount', 'requestedRange', 'completedRange',
    'completeness', 'textStatus', 'metadata', 'pages', 'warnings', 'lineage',
    'readReceiptId', 'readReceiptDigest',
  ],
})

export const SOURCE_RECORD_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    sourceId: { type: 'string', minLength: 1 },
    title: { type: 'string', minLength: 1 },
    authors: { type: 'array', items: AUTHOR_SCHEMA },
    year: NULLABLE_YEAR_SCHEMA,
    venue: NULLABLE_STRING_SCHEMA,
    stableIdentifier: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['doi', 'provider', 'url', 'other'] },
        value: { type: 'string', minLength: 1 },
      },
      required: ['kind', 'value'],
    },
    sourceType: { type: 'string', minLength: 1 },
    versionRelation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: {
          type: 'string',
          enum: ['none', 'is-version-of', 'has-version', 'is-preprint-of', 'is-version-of-record'],
        },
        relatedIdentifier: NULLABLE_STRING_SCHEMA,
      },
      required: ['kind', 'relatedIdentifier'],
    },
    retrievedAt: UTC_SCHEMA,
    providerTrace: PROVIDER_TRACE_SCHEMA,
    codeRefs: { type: 'array', items: externalRefSchema() },
    dataRefs: { type: 'array', items: externalRefSchema() },
    status: { type: 'string', enum: ['resolved', 'partial', 'unresolved'] },
    searchChain: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chainId: { type: 'string', minLength: 1 },
        generation: { type: 'integer', minimum: 1 },
        providerItemId: { type: 'string', minLength: 1 },
      },
      required: ['chainId', 'generation', 'providerItemId'],
    },
    digest: SHA256_SCHEMA,
  },
  required: [
    'schemaVersion', 'sourceId', 'title', 'authors', 'year', 'venue',
    'stableIdentifier', 'sourceType', 'versionRelation', 'retrievedAt',
    'providerTrace', 'codeRefs', 'dataRefs', 'status', 'searchChain', 'digest',
  ],
})

export const EVIDENCE_CANDIDATE_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 },
    sourceId: { type: 'string', minLength: 1 },
    artifactId: { type: 'string', minLength: 1 },
    paperReadReceiptId: { type: 'string', minLength: 1 },
    locator: locatorSchema(),
    proposition: { type: 'string', minLength: 1 },
    relation: {
      type: 'string',
      enum: ['supports', 'partially-supports', 'contradicts', 'background-only', 'insufficient'],
    },
    paraphrase: { type: 'string', minLength: 1 },
    quotedText: { type: 'string', minLength: 1 },
    limitations: { type: 'array', items: { type: 'string', minLength: 1 } },
  },
  required: [
    'schemaVersion', 'sourceId', 'artifactId', 'paperReadReceiptId', 'locator',
    'proposition', 'relation', 'paraphrase', 'limitations',
  ],
})

export const EVIDENCE_RECORD_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  ...EVIDENCE_CANDIDATE_SCHEMA,
  properties: {
    ...(EVIDENCE_CANDIDATE_SCHEMA.properties as Record<string, unknown>),
    evidenceId: { type: 'string', minLength: 1 },
    artifactDigest: SHA256_SCHEMA,
    extractionLineage: PAPER_LINEAGE_SCHEMA,
    reviewStatus: { type: 'string', enum: ['pending', 'accepted', 'rejected', 'needs-review'] },
    committedAt: UTC_SCHEMA,
    digest: SHA256_SCHEMA,
  },
  required: [
    ...(EVIDENCE_CANDIDATE_SCHEMA.required as string[]),
    'evidenceId', 'artifactDigest', 'extractionLineage', 'reviewStatus', 'committedAt', 'digest',
  ],
})

export function normalizeLiteratureSearchRequest(value: unknown): LiteratureSearchRequest {
  const record = exactRecord(value, 'literature_search arguments', ['query', 'filters', 'maxResults'])
  const query = nonEmptyText(record.query, 'query').normalize('NFC').trim()
  if (Buffer.byteLength(query, 'utf8') > 2_000) throw new TypeError('query exceeds 2000 UTF-8 bytes')
  const rawFilters = exactRecord(record.filters, 'filters', ['yearStart', 'yearEnd', 'publicationTypes'])
  const yearStart = nullableYear(rawFilters.yearStart, 'filters.yearStart')
  const yearEnd = nullableYear(rawFilters.yearEnd, 'filters.yearEnd')
  if (yearStart !== null && yearEnd !== null && yearStart > yearEnd) {
    throw new TypeError('filters.yearStart must not exceed filters.yearEnd')
  }
  if (!Array.isArray(rawFilters.publicationTypes)) {
    throw new TypeError('filters.publicationTypes must be an array')
  }
  const publicationTypes = [...new Set(rawFilters.publicationTypes.map((entry, index) => (
    nonEmptyText(entry, `filters.publicationTypes[${index}]`).normalize('NFC').trim()
  )))].sort()
  const maxResults = positiveInteger(record.maxResults, 'maxResults')
  if (maxResults > 100) throw new TypeError('maxResults must not exceed 100')
  return {
    query,
    filters: { yearStart, yearEnd, publicationTypes },
    maxResults,
  }
}

export function parseLiteratureContinuationRequest(value: unknown): LiteratureContinuationRequest {
  const record = exactRecord(value, 'literature_continue arguments', ['continuationId'])
  return { continuationId: boundedToken(record.continuationId, 'continuationId') }
}

export function parseLiteratureSearchResult(value: unknown): LiteratureSearchResult {
  const record = exactRecord(value, 'LiteratureSearchResult', [
    'items', 'completeness', 'stopReason', 'continuationRef', 'warnings',
    'providerTrace', 'searchChainTrace', 'trace',
  ])
  if (!Array.isArray(record.items)) throw new TypeError('LiteratureSearchResult.items must be an array')
  if (!Array.isArray(record.warnings)) throw new TypeError('LiteratureSearchResult.warnings must be an array')
  if (record.completeness !== 'complete' && record.completeness !== 'partial') {
    throw new TypeError('LiteratureSearchResult.completeness is invalid')
  }
  const items = record.items.map((entry, index) => parseLiteratureItem(entry, `items[${index}]`))
  const warnings = record.warnings.map((entry, index) => parseWarning(entry, `warnings[${index}]`))
  const providerTrace = parseProviderTrace(record.providerTrace)
  const searchChainTrace = parseSearchChainTrace(record.searchChainTrace)
  const traceRecord = exactRecord(record.trace, 'trace', ['pagesAdvanced'])
  const pagesAdvanced = nonNegativeInteger(traceRecord.pagesAdvanced, 'trace.pagesAdvanced')
  const continuationRef = record.continuationRef === undefined
    ? undefined
    : parseContinuationRef(record.continuationRef)
  if (record.completeness === 'complete') {
    if (record.stopReason !== undefined || continuationRef !== undefined) {
      throw new TypeError('complete literature result cannot contain stopReason or continuationRef')
    }
    return { items, completeness: 'complete', warnings, providerTrace, searchChainTrace, trace: { pagesAdvanced } }
  }
  if (!(LITERATURE_STOP_REASONS as readonly unknown[]).includes(record.stopReason)) {
    throw new TypeError('partial literature result requires a valid stopReason')
  }
  if (items.length === 0 && (record.stopReason !== 'no-new-items'
    || continuationRef === undefined || pagesAdvanced < 1)) {
    throw new TypeError('empty partial result requires no-new-items, continuationRef, and pagesAdvanced > 0')
  }
  return {
    items,
    completeness: 'partial',
    stopReason: record.stopReason as LiteratureStopReason,
    ...(continuationRef === undefined ? {} : { continuationRef }),
    warnings,
    providerTrace,
    searchChainTrace,
    trace: { pagesAdvanced },
  }
}

export function parseSourceRecord(value: unknown): SourceRecord {
  const record = exactRecord(value, 'SourceRecord', [
    'schemaVersion', 'sourceId', 'title', 'authors', 'year', 'venue', 'stableIdentifier',
    'sourceType', 'versionRelation', 'retrievedAt', 'providerTrace', 'codeRefs',
    'dataRefs', 'status', 'searchChain', 'digest',
  ])
  if (record.schemaVersion !== 1) throw new TypeError('SourceRecord.schemaVersion must be 1')
  if (!Array.isArray(record.authors) || !Array.isArray(record.codeRefs) || !Array.isArray(record.dataRefs)) {
    throw new TypeError('SourceRecord array fields are invalid')
  }
  const stable = exactRecord(record.stableIdentifier, 'stableIdentifier', ['kind', 'value'])
  if (!['doi', 'provider', 'url', 'other'].includes(String(stable.kind))) {
    throw new TypeError('stableIdentifier.kind is invalid')
  }
  const version = exactRecord(record.versionRelation, 'versionRelation', ['kind', 'relatedIdentifier'])
  if (!['none', 'is-version-of', 'has-version', 'is-preprint-of', 'is-version-of-record'].includes(String(version.kind))) {
    throw new TypeError('versionRelation.kind is invalid')
  }
  const chain = exactRecord(record.searchChain, 'searchChain', ['chainId', 'generation', 'providerItemId'])
  if (!['resolved', 'partial', 'unresolved'].includes(String(record.status))) {
    throw new TypeError('SourceRecord.status is invalid')
  }
  const parsed: SourceRecord = {
    schemaVersion: 1,
    sourceId: nonEmptyText(record.sourceId, 'sourceId'),
    title: nonEmptyText(record.title, 'title'),
    authors: record.authors.map((entry, index) => parseAuthor(entry, `authors[${index}]`)),
    year: nullableYear(record.year, 'year'),
    venue: nullableText(record.venue, 'venue'),
    stableIdentifier: {
      kind: stable.kind as SourceRecord['stableIdentifier']['kind'],
      value: nonEmptyText(stable.value, 'stableIdentifier.value'),
    },
    sourceType: nonEmptyText(record.sourceType, 'sourceType'),
    versionRelation: {
      kind: version.kind as SourceRecord['versionRelation']['kind'],
      relatedIdentifier: nullableText(version.relatedIdentifier, 'versionRelation.relatedIdentifier'),
    },
    retrievedAt: utc(record.retrievedAt, 'retrievedAt'),
    providerTrace: parseProviderTrace(record.providerTrace),
    codeRefs: record.codeRefs.map((entry, index) => parseExternalRef(entry, `codeRefs[${index}]`)),
    dataRefs: record.dataRefs.map((entry, index) => parseExternalRef(entry, `dataRefs[${index}]`)),
    status: record.status as SourceRecord['status'],
    searchChain: {
      chainId: nonEmptyText(chain.chainId, 'searchChain.chainId'),
      generation: positiveInteger(chain.generation, 'searchChain.generation'),
      providerItemId: nonEmptyText(chain.providerItemId, 'searchChain.providerItemId'),
    },
    digest: digest(record.digest, 'digest'),
  }
  const { digest: ignored, ...body } = parsed
  void ignored
  if (digestCanonical(body) !== parsed.digest) throw new TypeError('SourceRecord.digest does not match its body')
  return parsed
}

export function parseEvidenceCandidate(value: unknown): EvidenceCandidate {
  const record = exactRecord(value, 'EvidenceCandidate', [
    'schemaVersion', 'sourceId', 'artifactId', 'paperReadReceiptId', 'locator',
    'proposition', 'relation', 'paraphrase', 'quotedText', 'limitations',
  ])
  if (record.schemaVersion !== 1) throw new TypeError('EvidenceCandidate.schemaVersion must be 1')
  if (!['supports', 'partially-supports', 'contradicts', 'background-only', 'insufficient']
    .includes(String(record.relation))) {
    throw new TypeError('EvidenceCandidate.relation is invalid')
  }
  if (!Array.isArray(record.limitations)) throw new TypeError('EvidenceCandidate.limitations must be an array')
  const locator = exactRecord(record.locator, 'locator', ['pageStart', 'pageEnd'])
  const pageStart = positiveInteger(locator.pageStart, 'locator.pageStart')
  const pageEnd = positiveInteger(locator.pageEnd, 'locator.pageEnd')
  if (pageStart > pageEnd) throw new TypeError('locator.pageStart must not exceed locator.pageEnd')
  return {
    schemaVersion: 1,
    sourceId: nonEmptyText(record.sourceId, 'sourceId'),
    artifactId: nonEmptyText(record.artifactId, 'artifactId'),
    paperReadReceiptId: nonEmptyText(record.paperReadReceiptId, 'paperReadReceiptId'),
    locator: { pageStart, pageEnd },
    proposition: boundedText(record.proposition, 'proposition', 16_384),
    relation: record.relation as EvidenceRelation,
    paraphrase: boundedText(record.paraphrase, 'paraphrase', 32_768),
    ...(record.quotedText === undefined
      ? {}
      : { quotedText: boundedText(record.quotedText, 'quotedText', 32_768) }),
    limitations: [...new Set(record.limitations.map((entry, index) => (
      boundedText(entry, `limitations[${index}]`, 4_096)
    )))],
  }
}

export function parseEvidenceRecord(value: unknown): EvidenceRecord {
  const record = exactRecord(value, 'EvidenceRecord', [
    'schemaVersion', 'sourceId', 'artifactId', 'paperReadReceiptId', 'locator',
    'proposition', 'relation', 'paraphrase', 'quotedText', 'limitations',
    'evidenceId', 'artifactDigest', 'extractionLineage', 'reviewStatus',
    'committedAt', 'digest',
  ])
  const candidate = parseEvidenceCandidate({
    schemaVersion: record.schemaVersion,
    sourceId: record.sourceId,
    artifactId: record.artifactId,
    paperReadReceiptId: record.paperReadReceiptId,
    locator: record.locator,
    proposition: record.proposition,
    relation: record.relation,
    paraphrase: record.paraphrase,
    ...(record.quotedText === undefined ? {} : { quotedText: record.quotedText }),
    limitations: record.limitations,
  })
  if (!['pending', 'accepted', 'rejected', 'needs-review'].includes(String(record.reviewStatus))) {
    throw new TypeError('EvidenceRecord.reviewStatus is invalid')
  }
  const lineage = parsePaperLineage(record.extractionLineage)
  const parsed: EvidenceRecord = {
    ...candidate,
    evidenceId: nonEmptyText(record.evidenceId, 'evidenceId'),
    artifactDigest: digest(record.artifactDigest, 'artifactDigest'),
    extractionLineage: lineage,
    reviewStatus: record.reviewStatus as EvidenceRecord['reviewStatus'],
    committedAt: utc(record.committedAt, 'committedAt'),
    digest: digest(record.digest, 'digest'),
  }
  const { digest: ignoredDigest, reviewStatus: ignoredReviewStatus, ...stableBody } = parsed
  void ignoredDigest
  void ignoredReviewStatus
  const legacyPendingBody = { ...stableBody, reviewStatus: 'pending' as const }
  if (digestCanonical(stableBody) !== parsed.digest
    && digestCanonical(legacyPendingBody) !== parsed.digest) {
    throw new TypeError('EvidenceRecord.digest does not match its stable body')
  }
  return parsed
}

export function digestPhase3Body(value: unknown): Sha256Digest {
  return digestCanonical(value)
}

function parseLiteratureItem(value: unknown, field: string): LiteratureItem {
  const record = exactRecord(value, field, [
    'providerItemId', 'title', 'authors', 'year', 'venue', 'doi',
    'stableIdentifier', 'sourceType', 'url',
  ])
  if (!Array.isArray(record.authors)) throw new TypeError(`${field}.authors must be an array`)
  return {
    providerItemId: nonEmptyText(record.providerItemId, `${field}.providerItemId`),
    title: nonEmptyText(record.title, `${field}.title`),
    authors: record.authors.map((entry, index) => parseAuthor(entry, `${field}.authors[${index}]`)),
    year: nullableYear(record.year, `${field}.year`),
    venue: nullableText(record.venue, `${field}.venue`),
    doi: nullableText(record.doi, `${field}.doi`),
    stableIdentifier: nonEmptyText(record.stableIdentifier, `${field}.stableIdentifier`),
    sourceType: nonEmptyText(record.sourceType, `${field}.sourceType`),
    url: nullableText(record.url, `${field}.url`),
  }
}

function parseAuthor(value: unknown, field: string): LiteratureAuthor {
  const record = exactRecord(value, field, ['name', 'orcid'])
  return {
    name: nonEmptyText(record.name, `${field}.name`),
    orcid: nullableText(record.orcid, `${field}.orcid`),
  }
}

function parseWarning(value: unknown, field: string): LiteratureWarning {
  const record = exactRecord(value, field, ['code', 'message'])
  return {
    code: nonEmptyText(record.code, `${field}.code`),
    message: nonEmptyText(record.message, `${field}.message`),
  }
}

function parseProviderTrace(value: unknown): LiteratureProviderTrace {
  const record = exactRecord(value, 'providerTrace', [
    'providerId', 'providerVersion', 'retrievedAt', 'credentialRef',
    'credentialBindingEpoch', 'requestId',
  ])
  return {
    providerId: nonEmptyText(record.providerId, 'providerTrace.providerId'),
    providerVersion: nonEmptyText(record.providerVersion, 'providerTrace.providerVersion'),
    retrievedAt: utc(record.retrievedAt, 'providerTrace.retrievedAt'),
    credentialRef: nullableText(record.credentialRef, 'providerTrace.credentialRef'),
    credentialBindingEpoch: nonNegativeInteger(
      record.credentialBindingEpoch,
      'providerTrace.credentialBindingEpoch',
    ),
    requestId: nullableText(record.requestId, 'providerTrace.requestId'),
  }
}

function parseSearchChainTrace(value: unknown): LiteratureSearchChainTrace {
  const record = exactRecord(value, 'searchChainTrace', [
    'chainId', 'generation', 'requestDigest', 'pagesAdvancedTotal', 'uniqueItemsTotal',
  ])
  return {
    chainId: nonEmptyText(record.chainId, 'searchChainTrace.chainId'),
    generation: positiveInteger(record.generation, 'searchChainTrace.generation'),
    requestDigest: digest(record.requestDigest, 'searchChainTrace.requestDigest'),
    pagesAdvancedTotal: nonNegativeInteger(record.pagesAdvancedTotal, 'searchChainTrace.pagesAdvancedTotal'),
    uniqueItemsTotal: nonNegativeInteger(record.uniqueItemsTotal, 'searchChainTrace.uniqueItemsTotal'),
  }
}

function parseContinuationRef(value: unknown): LiteratureContinuationRef {
  const record = exactRecord(value, 'continuationRef', ['continuationId', 'generation', 'expiresAt'])
  return {
    continuationId: boundedToken(record.continuationId, 'continuationRef.continuationId'),
    generation: positiveInteger(record.generation, 'continuationRef.generation'),
    expiresAt: utc(record.expiresAt, 'continuationRef.expiresAt'),
  }
}

function parseExternalRef(value: unknown, field: string): SourceExternalRef {
  const record = exactRecord(value, field, ['url', 'label'])
  return {
    url: nonEmptyText(record.url, `${field}.url`),
    label: nullableText(record.label, `${field}.label`),
  }
}

function parsePaperLineage(value: unknown): PaperReadLineage {
  const record = exactRecord(value, 'extractionLineage', [
    'providerId', 'providerVersion', 'parserId', 'parserVersion', 'configDigest',
  ])
  return {
    providerId: nonEmptyText(record.providerId, 'extractionLineage.providerId'),
    providerVersion: nonEmptyText(record.providerVersion, 'extractionLineage.providerVersion'),
    parserId: nonEmptyText(record.parserId, 'extractionLineage.parserId'),
    parserVersion: nonEmptyText(record.parserVersion, 'extractionLineage.parserVersion'),
    configDigest: digest(record.configDigest, 'extractionLineage.configDigest'),
  }
}

function externalRefSchema(): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      url: { type: 'string', minLength: 1 },
      label: NULLABLE_STRING_SCHEMA,
    },
    required: ['url', 'label'],
  }
}

function locatorSchema(): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      pageStart: { type: 'integer', minimum: 1 },
      pageEnd: { type: 'integer', minimum: 1 },
    },
    required: ['pageStart', 'pageEnd'],
  }
}

function exactRecord(value: unknown, field: string, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`)
  }
  const record = value as Record<string, unknown>
  const unsupported = Object.keys(record).filter(key => !fields.includes(key))
  if (unsupported.length > 0) throw new TypeError(`${field} has unsupported fields: ${unsupported.join(', ')}`)
  return record
}

function nonEmptyText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${field} must be non-empty`)
  return value
}

function boundedText(value: unknown, field: string, maxBytes: number): string {
  const text = nonEmptyText(value, field).normalize('NFC')
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new TypeError(`${field} exceeds ${maxBytes} UTF-8 bytes`)
  return text
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null) return null
  return nonEmptyText(value, field)
}

function nullableYear(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 9999) {
    throw new TypeError(`${field} must be null or a four-digit-compatible year`)
  }
  return value as number
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive integer`)
  return value as number
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${field} must be a non-negative integer`)
  return value as number
}

function boundedToken(value: unknown, field: string): string {
  const token = nonEmptyText(value, field)
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) throw new TypeError(`${field} is not a bounded opaque token`)
  return token
}

function digest(value: unknown, field: string): Sha256Digest {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError(`${field} must be a SHA-256 digest`)
  }
  return value as Sha256Digest
}

function utc(value: unknown, field: string): string {
  const text = nonEmptyText(value, field)
  const date = new Date(text)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) {
    throw new TypeError(`${field} must be canonical UTC`)
  }
  return text
}

function digestCanonical(value: unknown): Sha256Digest {
  return `sha256:${createHash('sha256').update(Buffer.from(canonical(value), 'utf8')).digest('hex')}`
}

function canonical(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean': return value ? 'true' : 'false'
    case 'string': return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonical JSON rejects non-finite numbers')
      return JSON.stringify(Object.is(value, -0) ? 0 : value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('canonical JSON accepts only plain objects')
      }
      const record = value as Record<string, unknown>
      return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
    }
    default: throw new TypeError(`canonical JSON rejects ${typeof value}`)
  }
}
