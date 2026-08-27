import type { ArtifactRef } from './phase2.js'
import type { Sha256Digest } from './index.js'

export const PHASE5_SCHEMA_VERSION = 1 as const

export const GEODATA_ACTIONS = [
  'raster-metadata',
  'vector-metadata',
  'crs',
  'extent',
  'alignment',
  'nodata',
  'band-schema',
  'label-schema',
  'split-summary',
] as const
export type GeodataAction = typeof GEODATA_ACTIONS[number]

export const GEODATA_CHECK_STATUSES = ['passed', 'failed', 'blocked', 'not-applicable'] as const
export type GeodataCheckStatus = typeof GEODATA_CHECK_STATUSES[number]

export interface GeospatialProviderCapability {
  readonly providerId: 'python-geospatial'
  readonly providerVersion: string
  readonly protocol: 'georesearch-worker/1'
  readonly shell: false
  readonly persistentWorker: true
  readonly cancel: true
  readonly deadlines: true
  readonly methods: readonly ['inspect-dataset']
  readonly libraries: Readonly<Record<string, string | null>>
}

export interface DatasetSource {
  readonly uri: string | null
  readonly provider: string
  readonly accessedAt: string
}

export interface DatasetCrs {
  readonly authority: string | null
  readonly wktDigest: Sha256Digest | null
  readonly axisOrder: readonly string[]
  readonly units: readonly string[]
}

export interface DatasetBand {
  readonly index: number
  readonly name: string
  readonly dataType: string
  readonly unit: string | null
  readonly scale: number
  readonly offset: number
  readonly noData: number | null
  readonly colorInterpretation: string | null
}

export interface DatasetField {
  readonly name: string
  readonly dataType: string
  readonly unit: string | null
  readonly nullable: boolean
}

export interface DatasetLabelClass {
  readonly value: string
  readonly label: string
}

export interface DatasetSplitMembership {
  readonly splitId: string
  readonly role: 'train' | 'validation' | 'test' | 'holdout'
  readonly sampleIds: readonly string[]
  readonly spatialUnitIds: readonly string[]
  readonly sourceAssetDigests: readonly Sha256Digest[]
  readonly temporalKeys: readonly string[]
}

export interface DatasetManifest {
  readonly schemaVersion: 1
  readonly datasetId: string
  readonly name: string
  readonly version: string
  readonly projectId: string
  readonly workspaceId: string
  readonly workspaceBindingVersion: number
  readonly source: DatasetSource
  readonly assetRefs: readonly ArtifactRef[]
  readonly assetDigests: readonly Sha256Digest[]
  readonly spatialExtent: readonly [number, number, number, number] | null
  readonly timeRange: { readonly start: string | null; readonly end: string | null }
  readonly crs: DatasetCrs
  readonly resolution: readonly [number, number] | null
  readonly bands: readonly DatasetBand[]
  readonly fields: readonly DatasetField[]
  readonly qualityMasks: readonly string[]
  readonly preprocessingLevel: string
  readonly labelSchema: readonly DatasetLabelClass[]
  readonly splits: readonly DatasetSplitMembership[]
  readonly knownLimitations: readonly string[]
  readonly inspectionReportDigest: Sha256Digest
  readonly status: 'verified' | 'blocked'
  readonly createdAt: string
  readonly digest: Sha256Digest
}

export interface GeodataAssetInspection {
  readonly artifactRef: ArtifactRef
  readonly format: string
  readonly width: number | null
  readonly height: number | null
  readonly featureCount: number | null
  readonly spatialExtent: readonly [number, number, number, number] | null
  readonly crs: DatasetCrs
  readonly resolution: readonly [number, number] | null
  readonly transform: readonly [number, number, number, number, number, number] | null
  readonly bands: readonly DatasetBand[]
  readonly fields: readonly DatasetField[]
}

export interface GeodataCheck {
  readonly checkId: string
  readonly domain: 'common-gis' | 'optical' | 'geospatial-ml' | 'spatial-statistics'
  readonly mandatory: boolean
  readonly status: GeodataCheckStatus
  readonly code: string
  readonly message: string
  readonly relatedArtifactIds: readonly string[]
}

export interface GeodataInspectionReport {
  readonly schemaVersion: 1
  readonly reportId: string
  readonly projectId: string
  readonly workspaceId: string
  readonly workspaceBindingVersion: number
  readonly datasetId: string
  readonly datasetName: string
  readonly datasetVersion: string
  readonly source: DatasetSource
  readonly actions: readonly GeodataAction[]
  readonly provider: GeospatialProviderCapability
  readonly assets: readonly GeodataAssetInspection[]
  readonly splits: readonly DatasetSplitMembership[]
  readonly qualityMasks: readonly string[]
  readonly preprocessingLevel: string
  readonly labelSchema: readonly DatasetLabelClass[]
  readonly knownLimitations: readonly string[]
  readonly checks: readonly GeodataCheck[]
  readonly overall: 'passed' | 'failed' | 'blocked'
  readonly inspectedAt: string
  readonly digest: Sha256Digest
}

export interface ExperimentBaseline {
  readonly baselineId: string
  readonly description: string
  readonly implementationRef: string
  readonly preprocessingPolicy: string
  readonly trainingBudget: string
  readonly postprocessingPolicy: string
}

export interface ExperimentVariable {
  readonly name: string
  readonly values: readonly string[]
}

export interface ExperimentControl {
  readonly name: string
  readonly value: string
}

export interface ExperimentPreprocessingStep {
  readonly stepId: string
  readonly description: string
  readonly appliesTo: readonly string[]
  readonly parameters: Readonly<Record<string, string>>
}

export interface ExperimentMetric {
  readonly metricId: string
  readonly name: string
  readonly unit: string
  readonly direction: 'maximize' | 'minimize' | 'descriptive'
  readonly aggregation: string
  readonly implementationRef: string
}

export interface ExperimentAblation {
  readonly ablationId: string
  readonly description: string
  readonly changedVariables: readonly string[]
}

export interface ExperimentStatisticalPlan {
  readonly method: string
  readonly confidenceLevel: number
  readonly effectSize: string
  readonly multipleComparison: string
  readonly spatialAutocorrelation: string
  readonly blockingStrategy: string
}

export interface ExperimentAmendmentProposal {
  readonly parentSpecId: string
  readonly parentSpecDigest: Sha256Digest
  readonly changes: readonly string[]
  readonly reason: string
  readonly resultsSeenRunIds: readonly string[]
}

export interface ExperimentSpecCandidate {
  readonly schemaVersion: 1
  readonly kind: 'experiment-spec'
  readonly specId: string
  readonly experimentId: string
  readonly revision: number
  readonly researchBriefDigest: Sha256Digest
  readonly hypothesisIds: readonly string[]
  readonly repositoryAuditId: string
  readonly datasetReports: readonly GeodataInspectionReport[]
  readonly datasetRoles: readonly {
    readonly datasetId: string
    readonly role: ExperimentDatasetRef['role']
  }[]
  readonly baselines: readonly ExperimentBaseline[]
  readonly independentVariables: readonly ExperimentVariable[]
  readonly controlVariables: readonly ExperimentControl[]
  readonly splitStrategy: string
  readonly preprocessing: readonly ExperimentPreprocessingStep[]
  readonly metrics: readonly ExperimentMetric[]
  readonly seeds: readonly number[]
  readonly ablations: readonly ExperimentAblation[]
  readonly statisticalPlan: ExperimentStatisticalPlan
  readonly stoppingRule: string
  readonly resourceRequirements: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly amendment: ExperimentAmendmentProposal | null
}

export interface ExperimentDatasetRef {
  readonly datasetId: string
  readonly datasetDigest: Sha256Digest
  readonly role: 'training' | 'validation' | 'testing' | 'covariate' | 'labels'
}

export interface ExperimentSpec {
  readonly schemaVersion: 1
  readonly specId: string
  readonly experimentId: string
  readonly revision: number
  readonly projectId: string
  readonly workspaceId: string
  readonly workspaceBindingVersion: number
  readonly researchBriefDigest: Sha256Digest
  readonly hypothesisIds: readonly string[]
  readonly repositoryAuditId: string
  readonly repositoryAuditDigest: Sha256Digest
  readonly sourceTreeDigest: Sha256Digest
  readonly datasets: readonly ExperimentDatasetRef[]
  readonly baselines: readonly ExperimentBaseline[]
  readonly independentVariables: readonly ExperimentVariable[]
  readonly controlVariables: readonly ExperimentControl[]
  readonly splitStrategy: string
  readonly preprocessing: readonly ExperimentPreprocessingStep[]
  readonly metrics: readonly ExperimentMetric[]
  readonly seeds: readonly number[]
  readonly ablations: readonly ExperimentAblation[]
  readonly statisticalPlan: ExperimentStatisticalPlan
  readonly stoppingRule: string
  readonly resourceRequirements: readonly string[]
  readonly acceptanceCriteria: readonly string[]
  readonly parentSpecDigest: Sha256Digest | null
  readonly amendmentIds: readonly string[]
  readonly protocolDigest: Sha256Digest
  readonly status: 'frozen'
  readonly frozenAt: string
  readonly digest: Sha256Digest
}

export interface ExperimentAmendment {
  readonly schemaVersion: 1
  readonly amendmentId: string
  readonly projectId: string
  readonly experimentId: string
  readonly fromSpecId: string
  readonly fromSpecDigest: Sha256Digest
  readonly toSpecId: string
  readonly toSpecDigest: Sha256Digest
  readonly changes: readonly string[]
  readonly reason: string
  readonly resultsSeenRunIds: readonly string[]
  readonly createdAt: string
  readonly digest: Sha256Digest
}

export interface ResultUncertainty {
  readonly kind: 'none' | 'standard-deviation' | 'standard-error' | 'confidence-interval'
  readonly level: number | null
  readonly lower: number | null
  readonly upper: number | null
}

export interface ResultScope {
  readonly datasetId: string
  readonly region: string
  readonly sensor: string
  readonly split: string
}

export interface ResultEnvelopeEntry {
  readonly resultId: string
  readonly metricId: string
  readonly value: number
  readonly unit: string
  readonly aggregation: string
  readonly uncertainty: ResultUncertainty
  readonly comparisonTarget: string | null
  readonly scope: ResultScope
  readonly artifactIds: readonly string[]
}

export interface ResultEnvelope {
  readonly schemaVersion: 1
  readonly results: readonly ResultEnvelopeEntry[]
}

export interface ResultRecord extends ResultEnvelopeEntry {
  readonly schemaVersion: 1
  readonly projectId: string
  readonly workspaceId: string
  readonly workspaceBindingVersion: number
  readonly experimentSpecId: string
  readonly experimentSpecDigest: Sha256Digest
  readonly runId: string
  readonly runDigest: Sha256Digest
  readonly datasetDigests: readonly Sha256Digest[]
  readonly validationStatus: 'pending' | 'passed' | 'failed' | 'blocked'
  readonly artifactRefs: readonly ArtifactRef[]
  readonly committedAt: string
  readonly digest: Sha256Digest
}

const DIGEST_SCHEMA = { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' } as const
const ID_SCHEMA = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' } as const
const TEXT_SCHEMA = { type: 'string', minLength: 1 } as const
const NULLABLE_TEXT_SCHEMA = { type: ['string', 'null'], minLength: 1 } as const
const STRING_ARRAY_SCHEMA = { type: 'array', items: TEXT_SCHEMA } as const
const DIGEST_ARRAY_SCHEMA = { type: 'array', uniqueItems: true, items: DIGEST_SCHEMA } as const
const ARTIFACT_REF_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { artifactId: TEXT_SCHEMA, digest: DIGEST_SCHEMA, kind: TEXT_SCHEMA },
  required: ['artifactId', 'digest', 'kind'],
} as const
const BBOX_SCHEMA = {
  type: ['array', 'null'], minItems: 4, maxItems: 4, items: { type: 'number' },
} as const
const RESOLUTION_SCHEMA = {
  type: ['array', 'null'], minItems: 2, maxItems: 2, items: { type: 'number' },
} as const
const TRANSFORM_SCHEMA = {
  type: ['array', 'null'], minItems: 6, maxItems: 6, items: { type: 'number' },
} as const
const CRS_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    authority: NULLABLE_TEXT_SCHEMA,
    wktDigest: { type: ['string', 'null'], pattern: '^sha256:[0-9a-f]{64}$' },
    axisOrder: STRING_ARRAY_SCHEMA,
    units: STRING_ARRAY_SCHEMA,
  },
  required: ['authority', 'wktDigest', 'axisOrder', 'units'],
} as const
const SOURCE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { uri: NULLABLE_TEXT_SCHEMA, provider: TEXT_SCHEMA, accessedAt: TEXT_SCHEMA },
  required: ['uri', 'provider', 'accessedAt'],
} as const
const BAND_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    index: { type: 'integer', minimum: 1 }, name: TEXT_SCHEMA, dataType: TEXT_SCHEMA,
    unit: NULLABLE_TEXT_SCHEMA, scale: { type: 'number' }, offset: { type: 'number' },
    noData: { type: ['number', 'null'] }, colorInterpretation: NULLABLE_TEXT_SCHEMA,
  },
  required: ['index', 'name', 'dataType', 'unit', 'scale', 'offset', 'noData', 'colorInterpretation'],
} as const
const FIELD_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { name: TEXT_SCHEMA, dataType: TEXT_SCHEMA, unit: NULLABLE_TEXT_SCHEMA, nullable: { type: 'boolean' } },
  required: ['name', 'dataType', 'unit', 'nullable'],
} as const
const LABEL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { value: TEXT_SCHEMA, label: TEXT_SCHEMA }, required: ['value', 'label'],
} as const
const SPLIT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    splitId: ID_SCHEMA,
    role: { type: 'string', enum: ['train', 'validation', 'test', 'holdout'] },
    sampleIds: STRING_ARRAY_SCHEMA,
    spatialUnitIds: STRING_ARRAY_SCHEMA,
    sourceAssetDigests: DIGEST_ARRAY_SCHEMA,
    temporalKeys: STRING_ARRAY_SCHEMA,
  },
  required: ['splitId', 'role', 'sampleIds', 'spatialUnitIds', 'sourceAssetDigests', 'temporalKeys'],
} as const
const CAPABILITY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    providerId: { const: 'python-geospatial' }, providerVersion: TEXT_SCHEMA,
    protocol: { const: 'georesearch-worker/1' }, shell: { const: false },
    persistentWorker: { const: true }, cancel: { const: true }, deadlines: { const: true },
    methods: { type: 'array', items: { const: 'inspect-dataset' } },
    libraries: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
  },
  required: ['providerId', 'providerVersion', 'protocol', 'shell', 'persistentWorker', 'cancel', 'deadlines', 'methods', 'libraries'],
} as const
const ASSET_INSPECTION_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    artifactRef: ARTIFACT_REF_SCHEMA, format: TEXT_SCHEMA,
    width: { type: ['integer', 'null'], minimum: 1 }, height: { type: ['integer', 'null'], minimum: 1 },
    featureCount: { type: ['integer', 'null'], minimum: 0 }, spatialExtent: BBOX_SCHEMA,
    crs: CRS_SCHEMA, resolution: RESOLUTION_SCHEMA, transform: TRANSFORM_SCHEMA,
    bands: { type: 'array', items: BAND_SCHEMA }, fields: { type: 'array', items: FIELD_SCHEMA },
  },
  required: ['artifactRef', 'format', 'width', 'height', 'featureCount', 'spatialExtent', 'crs', 'resolution', 'transform', 'bands', 'fields'],
} as const
const CHECK_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    checkId: ID_SCHEMA,
    domain: { type: 'string', enum: ['common-gis', 'optical', 'geospatial-ml', 'spatial-statistics'] },
    mandatory: { type: 'boolean' }, status: { type: 'string', enum: GEODATA_CHECK_STATUSES },
    code: TEXT_SCHEMA, message: TEXT_SCHEMA, relatedArtifactIds: STRING_ARRAY_SCHEMA,
  },
  required: ['checkId', 'domain', 'mandatory', 'status', 'code', 'message', 'relatedArtifactIds'],
} as const

export const GEODATA_INSPECTION_REPORT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 }, reportId: ID_SCHEMA, projectId: TEXT_SCHEMA, workspaceId: TEXT_SCHEMA,
    workspaceBindingVersion: { type: 'integer', minimum: 1 }, datasetId: ID_SCHEMA,
    datasetName: TEXT_SCHEMA, datasetVersion: TEXT_SCHEMA, source: SOURCE_SCHEMA,
    actions: { type: 'array', uniqueItems: true, items: { type: 'string', enum: GEODATA_ACTIONS } },
    provider: CAPABILITY_SCHEMA, assets: { type: 'array', minItems: 1, items: ASSET_INSPECTION_SCHEMA },
    splits: { type: 'array', items: SPLIT_SCHEMA }, qualityMasks: STRING_ARRAY_SCHEMA,
    preprocessingLevel: TEXT_SCHEMA, labelSchema: { type: 'array', items: LABEL_SCHEMA },
    knownLimitations: STRING_ARRAY_SCHEMA, checks: { type: 'array', minItems: 1, items: CHECK_SCHEMA },
    overall: { type: 'string', enum: ['passed', 'failed', 'blocked'] }, inspectedAt: TEXT_SCHEMA,
    digest: DIGEST_SCHEMA,
  },
  required: [
    'schemaVersion', 'reportId', 'projectId', 'workspaceId', 'workspaceBindingVersion', 'datasetId',
    'datasetName', 'datasetVersion', 'source', 'actions', 'provider', 'assets', 'splits', 'qualityMasks',
    'preprocessingLevel', 'labelSchema', 'knownLimitations', 'checks', 'overall', 'inspectedAt', 'digest',
  ],
})

export const DATASET_MANIFEST_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 }, datasetId: ID_SCHEMA, name: TEXT_SCHEMA, version: TEXT_SCHEMA,
    projectId: TEXT_SCHEMA, workspaceId: TEXT_SCHEMA, workspaceBindingVersion: { type: 'integer', minimum: 1 },
    source: SOURCE_SCHEMA, assetRefs: { type: 'array', minItems: 1, items: ARTIFACT_REF_SCHEMA },
    assetDigests: DIGEST_ARRAY_SCHEMA, spatialExtent: BBOX_SCHEMA,
    timeRange: {
      type: 'object', additionalProperties: false,
      properties: { start: NULLABLE_TEXT_SCHEMA, end: NULLABLE_TEXT_SCHEMA }, required: ['start', 'end'],
    },
    crs: CRS_SCHEMA, resolution: RESOLUTION_SCHEMA, bands: { type: 'array', items: BAND_SCHEMA },
    fields: { type: 'array', items: FIELD_SCHEMA }, qualityMasks: STRING_ARRAY_SCHEMA,
    preprocessingLevel: TEXT_SCHEMA, labelSchema: { type: 'array', items: LABEL_SCHEMA },
    splits: { type: 'array', items: SPLIT_SCHEMA }, knownLimitations: STRING_ARRAY_SCHEMA,
    inspectionReportDigest: DIGEST_SCHEMA, status: { type: 'string', enum: ['verified', 'blocked'] },
    createdAt: TEXT_SCHEMA, digest: DIGEST_SCHEMA,
  },
  required: [
    'schemaVersion', 'datasetId', 'name', 'version', 'projectId', 'workspaceId', 'workspaceBindingVersion',
    'source', 'assetRefs', 'assetDigests', 'spatialExtent', 'timeRange', 'crs', 'resolution', 'bands',
    'fields', 'qualityMasks', 'preprocessingLevel', 'labelSchema', 'splits', 'knownLimitations',
    'inspectionReportDigest', 'status', 'createdAt', 'digest',
  ],
})

const BASELINE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    baselineId: ID_SCHEMA, description: TEXT_SCHEMA, implementationRef: TEXT_SCHEMA,
    preprocessingPolicy: TEXT_SCHEMA, trainingBudget: TEXT_SCHEMA, postprocessingPolicy: TEXT_SCHEMA,
  },
  required: ['baselineId', 'description', 'implementationRef', 'preprocessingPolicy', 'trainingBudget', 'postprocessingPolicy'],
} as const
const VARIABLE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { name: TEXT_SCHEMA, values: { type: 'array', minItems: 1, items: TEXT_SCHEMA } },
  required: ['name', 'values'],
} as const
const CONTROL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { name: TEXT_SCHEMA, value: TEXT_SCHEMA }, required: ['name', 'value'],
} as const
const PREPROCESSING_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    stepId: ID_SCHEMA, description: TEXT_SCHEMA, appliesTo: STRING_ARRAY_SCHEMA,
    parameters: { type: 'object', additionalProperties: { type: 'string' } },
  },
  required: ['stepId', 'description', 'appliesTo', 'parameters'],
} as const
const METRIC_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    metricId: ID_SCHEMA, name: TEXT_SCHEMA, unit: TEXT_SCHEMA,
    direction: { type: 'string', enum: ['maximize', 'minimize', 'descriptive'] },
    aggregation: TEXT_SCHEMA, implementationRef: TEXT_SCHEMA,
  },
  required: ['metricId', 'name', 'unit', 'direction', 'aggregation', 'implementationRef'],
} as const
const ABLATION_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { ablationId: ID_SCHEMA, description: TEXT_SCHEMA, changedVariables: STRING_ARRAY_SCHEMA },
  required: ['ablationId', 'description', 'changedVariables'],
} as const
const STATISTICAL_PLAN_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    method: TEXT_SCHEMA, confidenceLevel: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 },
    effectSize: TEXT_SCHEMA, multipleComparison: TEXT_SCHEMA,
    spatialAutocorrelation: TEXT_SCHEMA, blockingStrategy: TEXT_SCHEMA,
  },
  required: ['method', 'confidenceLevel', 'effectSize', 'multipleComparison', 'spatialAutocorrelation', 'blockingStrategy'],
} as const
const AMENDMENT_PROPOSAL_SCHEMA = {
  type: ['object', 'null'], additionalProperties: false,
  properties: {
    parentSpecId: ID_SCHEMA, parentSpecDigest: DIGEST_SCHEMA, changes: { type: 'array', minItems: 1, items: TEXT_SCHEMA },
    reason: TEXT_SCHEMA, resultsSeenRunIds: STRING_ARRAY_SCHEMA,
  },
  required: ['parentSpecId', 'parentSpecDigest', 'changes', 'reason', 'resultsSeenRunIds'],
} as const

export const EXPERIMENT_SPEC_CANDIDATE_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 }, kind: { const: 'experiment-spec' }, specId: ID_SCHEMA, experimentId: ID_SCHEMA,
    revision: { type: 'integer', minimum: 1 }, researchBriefDigest: DIGEST_SCHEMA,
    hypothesisIds: STRING_ARRAY_SCHEMA, repositoryAuditId: ID_SCHEMA,
    datasetReports: { type: 'array', minItems: 1, items: GEODATA_INSPECTION_REPORT_SCHEMA },
    datasetRoles: {
      type: 'array', minItems: 1,
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          datasetId: ID_SCHEMA,
          role: { type: 'string', enum: ['training', 'validation', 'testing', 'covariate', 'labels'] },
        },
        required: ['datasetId', 'role'],
      },
    },
    baselines: { type: 'array', minItems: 1, items: BASELINE_SCHEMA },
    independentVariables: { type: 'array', items: VARIABLE_SCHEMA },
    controlVariables: { type: 'array', items: CONTROL_SCHEMA }, splitStrategy: TEXT_SCHEMA,
    preprocessing: { type: 'array', items: PREPROCESSING_SCHEMA },
    metrics: { type: 'array', minItems: 1, items: METRIC_SCHEMA },
    seeds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'integer', minimum: 0 } },
    ablations: { type: 'array', items: ABLATION_SCHEMA }, statisticalPlan: STATISTICAL_PLAN_SCHEMA,
    stoppingRule: TEXT_SCHEMA, resourceRequirements: STRING_ARRAY_SCHEMA,
    acceptanceCriteria: { type: 'array', minItems: 1, items: TEXT_SCHEMA }, amendment: AMENDMENT_PROPOSAL_SCHEMA,
  },
  required: [
    'schemaVersion', 'kind', 'specId', 'experimentId', 'revision', 'researchBriefDigest', 'hypothesisIds',
    'repositoryAuditId', 'datasetReports', 'datasetRoles', 'baselines', 'independentVariables', 'controlVariables',
    'splitStrategy', 'preprocessing', 'metrics', 'seeds', 'ablations', 'statisticalPlan', 'stoppingRule',
    'resourceRequirements', 'acceptanceCriteria', 'amendment',
  ],
})

const DATASET_REF_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    datasetId: ID_SCHEMA, datasetDigest: DIGEST_SCHEMA,
    role: { type: 'string', enum: ['training', 'validation', 'testing', 'covariate', 'labels'] },
  },
  required: ['datasetId', 'datasetDigest', 'role'],
} as const

export const EXPERIMENT_SPEC_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 }, specId: ID_SCHEMA, experimentId: ID_SCHEMA, revision: { type: 'integer', minimum: 1 },
    projectId: TEXT_SCHEMA, workspaceId: TEXT_SCHEMA, workspaceBindingVersion: { type: 'integer', minimum: 1 },
    researchBriefDigest: DIGEST_SCHEMA, hypothesisIds: STRING_ARRAY_SCHEMA, repositoryAuditId: ID_SCHEMA,
    repositoryAuditDigest: DIGEST_SCHEMA, sourceTreeDigest: DIGEST_SCHEMA,
    datasets: { type: 'array', minItems: 1, items: DATASET_REF_SCHEMA },
    baselines: { type: 'array', minItems: 1, items: BASELINE_SCHEMA },
    independentVariables: { type: 'array', items: VARIABLE_SCHEMA }, controlVariables: { type: 'array', items: CONTROL_SCHEMA },
    splitStrategy: TEXT_SCHEMA, preprocessing: { type: 'array', items: PREPROCESSING_SCHEMA },
    metrics: { type: 'array', minItems: 1, items: METRIC_SCHEMA },
    seeds: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'integer', minimum: 0 } },
    ablations: { type: 'array', items: ABLATION_SCHEMA }, statisticalPlan: STATISTICAL_PLAN_SCHEMA,
    stoppingRule: TEXT_SCHEMA, resourceRequirements: STRING_ARRAY_SCHEMA,
    acceptanceCriteria: { type: 'array', minItems: 1, items: TEXT_SCHEMA },
    parentSpecDigest: { type: ['string', 'null'], pattern: '^sha256:[0-9a-f]{64}$' },
    amendmentIds: STRING_ARRAY_SCHEMA, protocolDigest: DIGEST_SCHEMA, status: { const: 'frozen' },
    frozenAt: TEXT_SCHEMA, digest: DIGEST_SCHEMA,
  },
  required: [
    'schemaVersion', 'specId', 'experimentId', 'revision', 'projectId', 'workspaceId', 'workspaceBindingVersion',
    'researchBriefDigest', 'hypothesisIds', 'repositoryAuditId', 'repositoryAuditDigest', 'sourceTreeDigest',
    'datasets', 'baselines', 'independentVariables', 'controlVariables', 'splitStrategy', 'preprocessing',
    'metrics', 'seeds', 'ablations', 'statisticalPlan', 'stoppingRule', 'resourceRequirements',
    'acceptanceCriteria', 'parentSpecDigest', 'amendmentIds', 'protocolDigest', 'status', 'frozenAt', 'digest',
  ],
})

export const EXPERIMENT_AMENDMENT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    schemaVersion: { const: 1 }, amendmentId: ID_SCHEMA, projectId: TEXT_SCHEMA, experimentId: ID_SCHEMA,
    fromSpecId: ID_SCHEMA, fromSpecDigest: DIGEST_SCHEMA, toSpecId: ID_SCHEMA, toSpecDigest: DIGEST_SCHEMA,
    changes: { type: 'array', minItems: 1, items: TEXT_SCHEMA }, reason: TEXT_SCHEMA,
    resultsSeenRunIds: STRING_ARRAY_SCHEMA, createdAt: TEXT_SCHEMA, digest: DIGEST_SCHEMA,
  },
  required: [
    'schemaVersion', 'amendmentId', 'projectId', 'experimentId', 'fromSpecId', 'fromSpecDigest',
    'toSpecId', 'toSpecDigest', 'changes', 'reason', 'resultsSeenRunIds', 'createdAt', 'digest',
  ],
})

const UNCERTAINTY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['none', 'standard-deviation', 'standard-error', 'confidence-interval'] },
    level: { type: ['number', 'null'] }, lower: { type: ['number', 'null'] }, upper: { type: ['number', 'null'] },
  },
  required: ['kind', 'level', 'lower', 'upper'],
} as const
const RESULT_SCOPE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { datasetId: ID_SCHEMA, region: TEXT_SCHEMA, sensor: TEXT_SCHEMA, split: TEXT_SCHEMA },
  required: ['datasetId', 'region', 'sensor', 'split'],
} as const
const RESULT_ENTRY_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    resultId: ID_SCHEMA, metricId: ID_SCHEMA, value: { type: 'number' }, unit: TEXT_SCHEMA,
    aggregation: TEXT_SCHEMA, uncertainty: UNCERTAINTY_SCHEMA, comparisonTarget: NULLABLE_TEXT_SCHEMA,
    scope: RESULT_SCOPE_SCHEMA, artifactIds: STRING_ARRAY_SCHEMA,
  },
  required: ['resultId', 'metricId', 'value', 'unit', 'aggregation', 'uncertainty', 'comparisonTarget', 'scope', 'artifactIds'],
} as const

export const RESULT_ENVELOPE_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: { schemaVersion: { const: 1 }, results: { type: 'array', minItems: 1, items: RESULT_ENTRY_SCHEMA } },
  required: ['schemaVersion', 'results'],
})

export const RESULT_RECORD_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  ...RESULT_ENTRY_SCHEMA,
  properties: {
    ...(RESULT_ENTRY_SCHEMA.properties as Record<string, unknown>), schemaVersion: { const: 1 },
    projectId: TEXT_SCHEMA, workspaceId: TEXT_SCHEMA, workspaceBindingVersion: { type: 'integer', minimum: 1 },
    experimentSpecId: ID_SCHEMA, experimentSpecDigest: DIGEST_SCHEMA, runId: ID_SCHEMA, runDigest: DIGEST_SCHEMA,
    datasetDigests: DIGEST_ARRAY_SCHEMA,
    validationStatus: { type: 'string', enum: ['pending', 'passed', 'failed', 'blocked'] },
    artifactRefs: { type: 'array', items: ARTIFACT_REF_SCHEMA }, committedAt: TEXT_SCHEMA, digest: DIGEST_SCHEMA,
  },
  required: [
    ...(RESULT_ENTRY_SCHEMA.required as readonly string[]), 'schemaVersion', 'projectId', 'workspaceId',
    'workspaceBindingVersion', 'experimentSpecId', 'experimentSpecDigest', 'runId', 'runDigest',
    'datasetDigests', 'validationStatus', 'artifactRefs', 'committedAt', 'digest',
  ],
})

export function parseGeodataInspectionReport(value: unknown): GeodataInspectionReport {
  const record = exactRecord(value, 'GeodataInspectionReport', [
    'schemaVersion', 'reportId', 'projectId', 'workspaceId', 'workspaceBindingVersion', 'datasetId',
    'datasetName', 'datasetVersion', 'source', 'actions', 'provider', 'assets', 'splits', 'qualityMasks',
    'preprocessingLevel', 'labelSchema', 'knownLimitations', 'checks', 'overall', 'inspectedAt', 'digest',
  ])
  if (record.schemaVersion !== 1) throw new TypeError('GeodataInspectionReport.schemaVersion must be 1')
  const actions = enumArray(record.actions, GEODATA_ACTIONS, 'GeodataInspectionReport.actions')
  const assets = objectArray(record.assets, 'GeodataInspectionReport.assets').map((item, index) => parseAsset(item, `GeodataInspectionReport.assets[${index}]`))
  const checks = objectArray(record.checks, 'GeodataInspectionReport.checks').map((item, index) => parseCheck(item, `GeodataInspectionReport.checks[${index}]`))
  if (assets.length === 0 || checks.length === 0) throw new TypeError('GeodataInspectionReport requires assets and checks')
  const overall = enumValue(record.overall, ['passed', 'failed', 'blocked'] as const, 'GeodataInspectionReport.overall')
  const expectedOverall = checks.some(check => check.mandatory && check.status === 'blocked')
    ? 'blocked'
    : checks.some(check => check.mandatory && check.status === 'failed') ? 'failed' : 'passed'
  if (overall !== expectedOverall) throw new TypeError('GeodataInspectionReport.overall does not match mandatory checks')
  return {
    schemaVersion: 1,
    reportId: id(record.reportId, 'GeodataInspectionReport.reportId'),
    projectId: text(record.projectId, 'GeodataInspectionReport.projectId'),
    workspaceId: text(record.workspaceId, 'GeodataInspectionReport.workspaceId'),
    workspaceBindingVersion: positiveInteger(record.workspaceBindingVersion, 'GeodataInspectionReport.workspaceBindingVersion'),
    datasetId: id(record.datasetId, 'GeodataInspectionReport.datasetId'),
    datasetName: text(record.datasetName, 'GeodataInspectionReport.datasetName'),
    datasetVersion: text(record.datasetVersion, 'GeodataInspectionReport.datasetVersion'),
    source: parseSource(record.source, 'GeodataInspectionReport.source'),
    actions,
    provider: parseCapability(record.provider),
    assets,
    splits: parseSplits(record.splits, 'GeodataInspectionReport.splits'),
    qualityMasks: stringArray(record.qualityMasks, 'GeodataInspectionReport.qualityMasks'),
    preprocessingLevel: text(record.preprocessingLevel, 'GeodataInspectionReport.preprocessingLevel'),
    labelSchema: parseLabels(record.labelSchema, 'GeodataInspectionReport.labelSchema'),
    knownLimitations: stringArray(record.knownLimitations, 'GeodataInspectionReport.knownLimitations'),
    checks,
    overall,
    inspectedAt: utc(record.inspectedAt, 'GeodataInspectionReport.inspectedAt'),
    digest: digest(record.digest, 'GeodataInspectionReport.digest'),
  }
}

export function parseDatasetManifest(value: unknown): DatasetManifest {
  const record = exactRecord(value, 'DatasetManifest', [
    'schemaVersion', 'datasetId', 'name', 'version', 'projectId', 'workspaceId', 'workspaceBindingVersion',
    'source', 'assetRefs', 'assetDigests', 'spatialExtent', 'timeRange', 'crs', 'resolution', 'bands',
    'fields', 'qualityMasks', 'preprocessingLevel', 'labelSchema', 'splits', 'knownLimitations',
    'inspectionReportDigest', 'status', 'createdAt', 'digest',
  ])
  if (record.schemaVersion !== 1) throw new TypeError('DatasetManifest.schemaVersion must be 1')
  const assetRefs = parseArtifactRefs(record.assetRefs, 'DatasetManifest.assetRefs')
  if (assetRefs.length === 0) throw new TypeError('DatasetManifest.assetRefs must not be empty')
  const assetDigests = digestArray(record.assetDigests, 'DatasetManifest.assetDigests')
  if (assetDigests.length !== assetRefs.length || assetRefs.some((ref, index) => ref.digest !== assetDigests[index])) {
    throw new TypeError('DatasetManifest.assetDigests must match assetRefs order')
  }
  const timeRange = exactRecord(record.timeRange, 'DatasetManifest.timeRange', ['start', 'end'])
  return {
    schemaVersion: 1,
    datasetId: id(record.datasetId, 'DatasetManifest.datasetId'), name: text(record.name, 'DatasetManifest.name'),
    version: text(record.version, 'DatasetManifest.version'), projectId: text(record.projectId, 'DatasetManifest.projectId'),
    workspaceId: text(record.workspaceId, 'DatasetManifest.workspaceId'),
    workspaceBindingVersion: positiveInteger(record.workspaceBindingVersion, 'DatasetManifest.workspaceBindingVersion'),
    source: parseSource(record.source, 'DatasetManifest.source'), assetRefs, assetDigests,
    spatialExtent: nullableTuple(record.spatialExtent, 4, 'DatasetManifest.spatialExtent') as DatasetManifest['spatialExtent'],
    timeRange: { start: nullableUtc(timeRange.start, 'DatasetManifest.timeRange.start'), end: nullableUtc(timeRange.end, 'DatasetManifest.timeRange.end') },
    crs: parseCrs(record.crs, 'DatasetManifest.crs'),
    resolution: nullableTuple(record.resolution, 2, 'DatasetManifest.resolution') as DatasetManifest['resolution'],
    bands: parseBands(record.bands, 'DatasetManifest.bands'), fields: parseFields(record.fields, 'DatasetManifest.fields'),
    qualityMasks: stringArray(record.qualityMasks, 'DatasetManifest.qualityMasks'),
    preprocessingLevel: text(record.preprocessingLevel, 'DatasetManifest.preprocessingLevel'),
    labelSchema: parseLabels(record.labelSchema, 'DatasetManifest.labelSchema'),
    splits: parseSplits(record.splits, 'DatasetManifest.splits'),
    knownLimitations: stringArray(record.knownLimitations, 'DatasetManifest.knownLimitations'),
    inspectionReportDigest: digest(record.inspectionReportDigest, 'DatasetManifest.inspectionReportDigest'),
    status: enumValue(record.status, ['verified', 'blocked'] as const, 'DatasetManifest.status'),
    createdAt: utc(record.createdAt, 'DatasetManifest.createdAt'), digest: digest(record.digest, 'DatasetManifest.digest'),
  }
}

export function parseExperimentSpecCandidate(value: unknown): ExperimentSpecCandidate {
  const record = exactRecord(value, 'ExperimentSpecCandidate', [
    'schemaVersion', 'kind', 'specId', 'experimentId', 'revision', 'researchBriefDigest', 'hypothesisIds',
    'repositoryAuditId', 'datasetReports', 'datasetRoles', 'baselines', 'independentVariables', 'controlVariables',
    'splitStrategy', 'preprocessing', 'metrics', 'seeds', 'ablations', 'statisticalPlan', 'stoppingRule',
    'resourceRequirements', 'acceptanceCriteria', 'amendment',
  ])
  if (record.schemaVersion !== 1 || record.kind !== 'experiment-spec') throw new TypeError('ExperimentSpecCandidate header is invalid')
  const result: ExperimentSpecCandidate = {
    schemaVersion: 1, kind: 'experiment-spec', specId: id(record.specId, 'ExperimentSpecCandidate.specId'),
    experimentId: id(record.experimentId, 'ExperimentSpecCandidate.experimentId'),
    revision: positiveInteger(record.revision, 'ExperimentSpecCandidate.revision'),
    researchBriefDigest: digest(record.researchBriefDigest, 'ExperimentSpecCandidate.researchBriefDigest'),
    hypothesisIds: stringArray(record.hypothesisIds, 'ExperimentSpecCandidate.hypothesisIds'),
    repositoryAuditId: id(record.repositoryAuditId, 'ExperimentSpecCandidate.repositoryAuditId'),
    datasetReports: objectArray(record.datasetReports, 'ExperimentSpecCandidate.datasetReports').map(parseGeodataInspectionReport),
    datasetRoles: objectArray(record.datasetRoles, 'ExperimentSpecCandidate.datasetRoles').map((item, index) => {
      const role = exactRecord(item, `ExperimentSpecCandidate.datasetRoles[${index}]`, ['datasetId', 'role'])
      return {
        datasetId: id(role.datasetId, `ExperimentSpecCandidate.datasetRoles[${index}].datasetId`),
        role: enumValue(role.role, ['training', 'validation', 'testing', 'covariate', 'labels'] as const, `ExperimentSpecCandidate.datasetRoles[${index}].role`),
      }
    }),
    baselines: objectArray(record.baselines, 'ExperimentSpecCandidate.baselines').map((item, index) => parseBaseline(item, `ExperimentSpecCandidate.baselines[${index}]`)),
    independentVariables: objectArray(record.independentVariables, 'ExperimentSpecCandidate.independentVariables').map((item, index) => parseVariable(item, `ExperimentSpecCandidate.independentVariables[${index}]`)),
    controlVariables: objectArray(record.controlVariables, 'ExperimentSpecCandidate.controlVariables').map((item, index) => parseControl(item, `ExperimentSpecCandidate.controlVariables[${index}]`)),
    splitStrategy: text(record.splitStrategy, 'ExperimentSpecCandidate.splitStrategy'),
    preprocessing: objectArray(record.preprocessing, 'ExperimentSpecCandidate.preprocessing').map((item, index) => parsePreprocessing(item, `ExperimentSpecCandidate.preprocessing[${index}]`)),
    metrics: objectArray(record.metrics, 'ExperimentSpecCandidate.metrics').map((item, index) => parseMetric(item, `ExperimentSpecCandidate.metrics[${index}]`)),
    seeds: integerArray(record.seeds, 'ExperimentSpecCandidate.seeds'),
    ablations: objectArray(record.ablations, 'ExperimentSpecCandidate.ablations').map((item, index) => parseAblation(item, `ExperimentSpecCandidate.ablations[${index}]`)),
    statisticalPlan: parseStatisticalPlan(record.statisticalPlan),
    stoppingRule: text(record.stoppingRule, 'ExperimentSpecCandidate.stoppingRule'),
    resourceRequirements: stringArray(record.resourceRequirements, 'ExperimentSpecCandidate.resourceRequirements'),
    acceptanceCriteria: stringArray(record.acceptanceCriteria, 'ExperimentSpecCandidate.acceptanceCriteria'),
    amendment: record.amendment === null ? null : parseAmendmentProposal(record.amendment),
  }
  if (result.datasetReports.length === 0 || result.baselines.length === 0 || result.metrics.length === 0
    || result.seeds.length === 0 || result.acceptanceCriteria.length === 0) {
    throw new TypeError('ExperimentSpecCandidate requires datasets, baselines, metrics, seeds, and acceptance criteria')
  }
  assertUnique(result.datasetReports.map(report => report.datasetId), 'ExperimentSpecCandidate datasetId')
  assertUnique(result.datasetRoles.map(role => role.datasetId), 'ExperimentSpecCandidate dataset role')
  if (result.datasetRoles.length !== result.datasetReports.length
    || result.datasetRoles.some(role => !result.datasetReports.some(report => report.datasetId === role.datasetId))) {
    throw new TypeError('ExperimentSpecCandidate datasetRoles must cover every dataset report')
  }
  assertUnique(result.baselines.map(item => item.baselineId), 'ExperimentSpecCandidate baselineId')
  assertUnique(result.metrics.map(item => item.metricId), 'ExperimentSpecCandidate metricId')
  assertUnique(result.seeds.map(String), 'ExperimentSpecCandidate seeds')
  if ((result.revision === 1) !== (result.amendment === null)) throw new TypeError('ExperimentSpecCandidate amendment/revision mismatch')
  return result
}

export function parseExperimentSpec(value: unknown): ExperimentSpec {
  const record = exactRecord(value, 'ExperimentSpec', [
    'schemaVersion', 'specId', 'experimentId', 'revision', 'projectId', 'workspaceId', 'workspaceBindingVersion',
    'researchBriefDigest', 'hypothesisIds', 'repositoryAuditId', 'repositoryAuditDigest', 'sourceTreeDigest',
    'datasets', 'baselines', 'independentVariables', 'controlVariables', 'splitStrategy', 'preprocessing',
    'metrics', 'seeds', 'ablations', 'statisticalPlan', 'stoppingRule', 'resourceRequirements',
    'acceptanceCriteria', 'parentSpecDigest', 'amendmentIds', 'protocolDigest', 'status', 'frozenAt', 'digest',
  ])
  if (record.schemaVersion !== 1 || record.status !== 'frozen') throw new TypeError('ExperimentSpec header is invalid')
  const result: ExperimentSpec = {
    schemaVersion: 1, specId: id(record.specId, 'ExperimentSpec.specId'), experimentId: id(record.experimentId, 'ExperimentSpec.experimentId'),
    revision: positiveInteger(record.revision, 'ExperimentSpec.revision'), projectId: text(record.projectId, 'ExperimentSpec.projectId'),
    workspaceId: text(record.workspaceId, 'ExperimentSpec.workspaceId'), workspaceBindingVersion: positiveInteger(record.workspaceBindingVersion, 'ExperimentSpec.workspaceBindingVersion'),
    researchBriefDigest: digest(record.researchBriefDigest, 'ExperimentSpec.researchBriefDigest'),
    hypothesisIds: stringArray(record.hypothesisIds, 'ExperimentSpec.hypothesisIds'), repositoryAuditId: id(record.repositoryAuditId, 'ExperimentSpec.repositoryAuditId'),
    repositoryAuditDigest: digest(record.repositoryAuditDigest, 'ExperimentSpec.repositoryAuditDigest'), sourceTreeDigest: digest(record.sourceTreeDigest, 'ExperimentSpec.sourceTreeDigest'),
    datasets: objectArray(record.datasets, 'ExperimentSpec.datasets').map((item, index) => parseDatasetRef(item, `ExperimentSpec.datasets[${index}]`)),
    baselines: objectArray(record.baselines, 'ExperimentSpec.baselines').map((item, index) => parseBaseline(item, `ExperimentSpec.baselines[${index}]`)),
    independentVariables: objectArray(record.independentVariables, 'ExperimentSpec.independentVariables').map((item, index) => parseVariable(item, `ExperimentSpec.independentVariables[${index}]`)),
    controlVariables: objectArray(record.controlVariables, 'ExperimentSpec.controlVariables').map((item, index) => parseControl(item, `ExperimentSpec.controlVariables[${index}]`)),
    splitStrategy: text(record.splitStrategy, 'ExperimentSpec.splitStrategy'), preprocessing: objectArray(record.preprocessing, 'ExperimentSpec.preprocessing').map((item, index) => parsePreprocessing(item, `ExperimentSpec.preprocessing[${index}]`)),
    metrics: objectArray(record.metrics, 'ExperimentSpec.metrics').map((item, index) => parseMetric(item, `ExperimentSpec.metrics[${index}]`)), seeds: integerArray(record.seeds, 'ExperimentSpec.seeds'),
    ablations: objectArray(record.ablations, 'ExperimentSpec.ablations').map((item, index) => parseAblation(item, `ExperimentSpec.ablations[${index}]`)), statisticalPlan: parseStatisticalPlan(record.statisticalPlan),
    stoppingRule: text(record.stoppingRule, 'ExperimentSpec.stoppingRule'), resourceRequirements: stringArray(record.resourceRequirements, 'ExperimentSpec.resourceRequirements'),
    acceptanceCriteria: stringArray(record.acceptanceCriteria, 'ExperimentSpec.acceptanceCriteria'), parentSpecDigest: nullableDigest(record.parentSpecDigest, 'ExperimentSpec.parentSpecDigest'),
    amendmentIds: stringArray(record.amendmentIds, 'ExperimentSpec.amendmentIds'), protocolDigest: digest(record.protocolDigest, 'ExperimentSpec.protocolDigest'),
    status: 'frozen', frozenAt: utc(record.frozenAt, 'ExperimentSpec.frozenAt'), digest: digest(record.digest, 'ExperimentSpec.digest'),
  }
  if (result.datasets.length === 0 || result.baselines.length === 0 || result.metrics.length === 0
    || result.seeds.length === 0 || result.acceptanceCriteria.length === 0) {
    throw new TypeError('ExperimentSpec requires datasets, baselines, metrics, seeds, and acceptance criteria')
  }
  assertUnique(result.datasets.map(item => item.datasetId), 'ExperimentSpec datasetId')
  assertUnique(result.baselines.map(item => item.baselineId), 'ExperimentSpec baselineId')
  assertUnique(result.metrics.map(item => item.metricId), 'ExperimentSpec metricId')
  assertUnique(result.seeds.map(String), 'ExperimentSpec seeds')
  assertUnique(result.amendmentIds, 'ExperimentSpec amendmentIds')
  if (result.revision === 1 && (result.parentSpecDigest !== null || result.amendmentIds.length !== 0)) {
    throw new TypeError('initial ExperimentSpec cannot contain amendment state')
  }
  if (result.revision > 1 && (result.parentSpecDigest === null || result.amendmentIds.length === 0)) {
    throw new TypeError('amended ExperimentSpec requires parent and amendment references')
  }
  return result
}

export function parseExperimentAmendment(value: unknown): ExperimentAmendment {
  const record = exactRecord(value, 'ExperimentAmendment', [
    'schemaVersion', 'amendmentId', 'projectId', 'experimentId', 'fromSpecId', 'fromSpecDigest',
    'toSpecId', 'toSpecDigest', 'changes', 'reason', 'resultsSeenRunIds', 'createdAt', 'digest',
  ])
  if (record.schemaVersion !== 1) throw new TypeError('ExperimentAmendment.schemaVersion must be 1')
  const changes = stringArray(record.changes, 'ExperimentAmendment.changes')
  if (changes.length === 0) throw new TypeError('ExperimentAmendment.changes must not be empty')
  return {
    schemaVersion: 1, amendmentId: id(record.amendmentId, 'ExperimentAmendment.amendmentId'),
    projectId: text(record.projectId, 'ExperimentAmendment.projectId'), experimentId: id(record.experimentId, 'ExperimentAmendment.experimentId'),
    fromSpecId: id(record.fromSpecId, 'ExperimentAmendment.fromSpecId'), fromSpecDigest: digest(record.fromSpecDigest, 'ExperimentAmendment.fromSpecDigest'),
    toSpecId: id(record.toSpecId, 'ExperimentAmendment.toSpecId'), toSpecDigest: digest(record.toSpecDigest, 'ExperimentAmendment.toSpecDigest'),
    changes, reason: text(record.reason, 'ExperimentAmendment.reason'),
    resultsSeenRunIds: stringArray(record.resultsSeenRunIds, 'ExperimentAmendment.resultsSeenRunIds'),
    createdAt: utc(record.createdAt, 'ExperimentAmendment.createdAt'), digest: digest(record.digest, 'ExperimentAmendment.digest'),
  }
}

export function parseResultEnvelope(value: unknown): ResultEnvelope {
  const record = exactRecord(value, 'ResultEnvelope', ['schemaVersion', 'results'])
  if (record.schemaVersion !== 1) throw new TypeError('ResultEnvelope.schemaVersion must be 1')
  const results = objectArray(record.results, 'ResultEnvelope.results').map((item, index) => parseResultEntry(item, `ResultEnvelope.results[${index}]`))
  if (results.length === 0) throw new TypeError('ResultEnvelope.results must not be empty')
  assertUnique(results.map(result => result.resultId), 'ResultEnvelope resultId')
  return { schemaVersion: 1, results }
}

export function parseResultRecord(value: unknown): ResultRecord {
  const record = exactRecord(value, 'ResultRecord', [
    'schemaVersion', 'resultId', 'metricId', 'value', 'unit', 'aggregation', 'uncertainty', 'comparisonTarget',
    'scope', 'artifactIds', 'projectId', 'workspaceId', 'workspaceBindingVersion', 'experimentSpecId',
    'experimentSpecDigest', 'runId', 'runDigest', 'datasetDigests', 'validationStatus', 'artifactRefs',
    'committedAt', 'digest',
  ])
  if (record.schemaVersion !== 1) throw new TypeError('ResultRecord.schemaVersion must be 1')
  const entry = parseResultEntry(Object.fromEntries(Object.entries(record).filter(([key]) => ![
    'schemaVersion', 'projectId', 'workspaceId', 'workspaceBindingVersion', 'experimentSpecId',
    'experimentSpecDigest', 'runId', 'runDigest', 'datasetDigests', 'validationStatus', 'artifactRefs',
    'committedAt', 'digest',
  ].includes(key))), 'ResultRecord')
  const artifactRefs = parseArtifactRefs(record.artifactRefs, 'ResultRecord.artifactRefs')
  if (entry.artifactIds.length !== artifactRefs.length || entry.artifactIds.some((idValue, index) => artifactRefs[index]?.artifactId !== idValue)) {
    throw new TypeError('ResultRecord artifactIds must match artifactRefs order')
  }
  return {
    schemaVersion: 1, ...entry, projectId: text(record.projectId, 'ResultRecord.projectId'),
    workspaceId: text(record.workspaceId, 'ResultRecord.workspaceId'), workspaceBindingVersion: positiveInteger(record.workspaceBindingVersion, 'ResultRecord.workspaceBindingVersion'),
    experimentSpecId: id(record.experimentSpecId, 'ResultRecord.experimentSpecId'), experimentSpecDigest: digest(record.experimentSpecDigest, 'ResultRecord.experimentSpecDigest'),
    runId: id(record.runId, 'ResultRecord.runId'), runDigest: digest(record.runDigest, 'ResultRecord.runDigest'),
    datasetDigests: digestArray(record.datasetDigests, 'ResultRecord.datasetDigests'),
    validationStatus: enumValue(record.validationStatus, ['pending', 'passed', 'failed', 'blocked'] as const, 'ResultRecord.validationStatus'),
    artifactRefs, committedAt: utc(record.committedAt, 'ResultRecord.committedAt'), digest: digest(record.digest, 'ResultRecord.digest'),
  }
}

function parseCapability(value: unknown): GeospatialProviderCapability {
  const record = exactRecord(value, 'GeospatialProviderCapability', [
    'providerId', 'providerVersion', 'protocol', 'shell', 'persistentWorker', 'cancel', 'deadlines', 'methods', 'libraries',
  ])
  if (record.providerId !== 'python-geospatial' || record.protocol !== 'georesearch-worker/1' || record.shell !== false
    || record.persistentWorker !== true || record.cancel !== true || record.deadlines !== true
    || !Array.isArray(record.methods) || record.methods.length !== 1 || record.methods[0] !== 'inspect-dataset') {
    throw new TypeError('GeospatialProviderCapability is incompatible')
  }
  const libraries = objectRecord(record.libraries, 'GeospatialProviderCapability.libraries')
  return {
    providerId: 'python-geospatial', providerVersion: text(record.providerVersion, 'GeospatialProviderCapability.providerVersion'),
    protocol: 'georesearch-worker/1', shell: false, persistentWorker: true, cancel: true, deadlines: true,
    methods: ['inspect-dataset'], libraries: Object.fromEntries(Object.entries(libraries).map(([key, item]) => [key, item === null ? null : text(item, `libraries.${key}`)])),
  }
}

function parseSource(value: unknown, field: string): DatasetSource {
  const record = exactRecord(value, field, ['uri', 'provider', 'accessedAt'])
  return { uri: nullableText(record.uri, `${field}.uri`), provider: text(record.provider, `${field}.provider`), accessedAt: utc(record.accessedAt, `${field}.accessedAt`) }
}

function parseAsset(value: unknown, field: string): GeodataAssetInspection {
  const record = exactRecord(value, field, ['artifactRef', 'format', 'width', 'height', 'featureCount', 'spatialExtent', 'crs', 'resolution', 'transform', 'bands', 'fields'])
  return {
    artifactRef: parseArtifactRef(record.artifactRef, `${field}.artifactRef`), format: text(record.format, `${field}.format`),
    width: nullablePositiveInteger(record.width, `${field}.width`), height: nullablePositiveInteger(record.height, `${field}.height`),
    featureCount: nullableNonNegativeInteger(record.featureCount, `${field}.featureCount`),
    spatialExtent: nullableTuple(record.spatialExtent, 4, `${field}.spatialExtent`) as GeodataAssetInspection['spatialExtent'],
    crs: parseCrs(record.crs, `${field}.crs`), resolution: nullableTuple(record.resolution, 2, `${field}.resolution`) as GeodataAssetInspection['resolution'],
    transform: nullableTuple(record.transform, 6, `${field}.transform`) as GeodataAssetInspection['transform'],
    bands: parseBands(record.bands, `${field}.bands`), fields: parseFields(record.fields, `${field}.fields`),
  }
}

function parseCrs(value: unknown, field: string): DatasetCrs {
  const record = exactRecord(value, field, ['authority', 'wktDigest', 'axisOrder', 'units'])
  return { authority: nullableText(record.authority, `${field}.authority`), wktDigest: nullableDigest(record.wktDigest, `${field}.wktDigest`), axisOrder: stringArray(record.axisOrder, `${field}.axisOrder`), units: stringArray(record.units, `${field}.units`) }
}

function parseBands(value: unknown, field: string): DatasetBand[] {
  return objectArray(value, field).map((item, index) => {
    const prefix = `${field}[${index}]`
    const record = exactRecord(item, prefix, ['index', 'name', 'dataType', 'unit', 'scale', 'offset', 'noData', 'colorInterpretation'])
    return { index: positiveInteger(record.index, `${prefix}.index`), name: text(record.name, `${prefix}.name`), dataType: text(record.dataType, `${prefix}.dataType`), unit: nullableText(record.unit, `${prefix}.unit`), scale: finiteNumber(record.scale, `${prefix}.scale`), offset: finiteNumber(record.offset, `${prefix}.offset`), noData: nullableNumber(record.noData, `${prefix}.noData`), colorInterpretation: nullableText(record.colorInterpretation, `${prefix}.colorInterpretation`) }
  })
}

function parseFields(value: unknown, field: string): DatasetField[] {
  return objectArray(value, field).map((item, index) => {
    const prefix = `${field}[${index}]`
    const record = exactRecord(item, prefix, ['name', 'dataType', 'unit', 'nullable'])
    return { name: text(record.name, `${prefix}.name`), dataType: text(record.dataType, `${prefix}.dataType`), unit: nullableText(record.unit, `${prefix}.unit`), nullable: booleanValue(record.nullable, `${prefix}.nullable`) }
  })
}

function parseLabels(value: unknown, field: string): DatasetLabelClass[] {
  return objectArray(value, field).map((item, index) => {
    const prefix = `${field}[${index}]`
    const record = exactRecord(item, prefix, ['value', 'label'])
    return { value: text(record.value, `${prefix}.value`), label: text(record.label, `${prefix}.label`) }
  })
}

function parseSplits(value: unknown, field: string): DatasetSplitMembership[] {
  const result = objectArray(value, field).map((item, index) => {
    const prefix = `${field}[${index}]`
    const record = exactRecord(item, prefix, ['splitId', 'role', 'sampleIds', 'spatialUnitIds', 'sourceAssetDigests', 'temporalKeys'])
    return {
      splitId: id(record.splitId, `${prefix}.splitId`), role: enumValue(record.role, ['train', 'validation', 'test', 'holdout'] as const, `${prefix}.role`),
      sampleIds: stringArray(record.sampleIds, `${prefix}.sampleIds`), spatialUnitIds: stringArray(record.spatialUnitIds, `${prefix}.spatialUnitIds`),
      sourceAssetDigests: digestArray(record.sourceAssetDigests, `${prefix}.sourceAssetDigests`), temporalKeys: stringArray(record.temporalKeys, `${prefix}.temporalKeys`),
    }
  })
  assertUnique(result.map(item => item.splitId), `${field} splitId`)
  return result
}

function parseCheck(value: unknown, field: string): GeodataCheck {
  const record = exactRecord(value, field, ['checkId', 'domain', 'mandatory', 'status', 'code', 'message', 'relatedArtifactIds'])
  return {
    checkId: id(record.checkId, `${field}.checkId`), domain: enumValue(record.domain, ['common-gis', 'optical', 'geospatial-ml', 'spatial-statistics'] as const, `${field}.domain`),
    mandatory: booleanValue(record.mandatory, `${field}.mandatory`), status: enumValue(record.status, GEODATA_CHECK_STATUSES, `${field}.status`),
    code: text(record.code, `${field}.code`), message: text(record.message, `${field}.message`), relatedArtifactIds: stringArray(record.relatedArtifactIds, `${field}.relatedArtifactIds`),
  }
}

function parseBaseline(value: unknown, field: string): ExperimentBaseline {
  const record = exactRecord(value, field, ['baselineId', 'description', 'implementationRef', 'preprocessingPolicy', 'trainingBudget', 'postprocessingPolicy'])
  return { baselineId: id(record.baselineId, `${field}.baselineId`), description: text(record.description, `${field}.description`), implementationRef: text(record.implementationRef, `${field}.implementationRef`), preprocessingPolicy: text(record.preprocessingPolicy, `${field}.preprocessingPolicy`), trainingBudget: text(record.trainingBudget, `${field}.trainingBudget`), postprocessingPolicy: text(record.postprocessingPolicy, `${field}.postprocessingPolicy`) }
}

function parseVariable(value: unknown, field: string): ExperimentVariable {
  const record = exactRecord(value, field, ['name', 'values'])
  return { name: text(record.name, `${field}.name`), values: stringArray(record.values, `${field}.values`) }
}

function parseControl(value: unknown, field: string): ExperimentControl {
  const record = exactRecord(value, field, ['name', 'value'])
  return { name: text(record.name, `${field}.name`), value: text(record.value, `${field}.value`) }
}

function parsePreprocessing(value: unknown, field: string): ExperimentPreprocessingStep {
  const record = exactRecord(value, field, ['stepId', 'description', 'appliesTo', 'parameters'])
  const parameters = objectRecord(record.parameters, `${field}.parameters`)
  return { stepId: id(record.stepId, `${field}.stepId`), description: text(record.description, `${field}.description`), appliesTo: stringArray(record.appliesTo, `${field}.appliesTo`), parameters: Object.fromEntries(Object.entries(parameters).map(([key, item]) => [key, text(item, `${field}.parameters.${key}`)])) }
}

function parseMetric(value: unknown, field: string): ExperimentMetric {
  const record = exactRecord(value, field, ['metricId', 'name', 'unit', 'direction', 'aggregation', 'implementationRef'])
  return { metricId: id(record.metricId, `${field}.metricId`), name: text(record.name, `${field}.name`), unit: text(record.unit, `${field}.unit`), direction: enumValue(record.direction, ['maximize', 'minimize', 'descriptive'] as const, `${field}.direction`), aggregation: text(record.aggregation, `${field}.aggregation`), implementationRef: text(record.implementationRef, `${field}.implementationRef`) }
}

function parseAblation(value: unknown, field: string): ExperimentAblation {
  const record = exactRecord(value, field, ['ablationId', 'description', 'changedVariables'])
  return { ablationId: id(record.ablationId, `${field}.ablationId`), description: text(record.description, `${field}.description`), changedVariables: stringArray(record.changedVariables, `${field}.changedVariables`) }
}

function parseStatisticalPlan(value: unknown): ExperimentStatisticalPlan {
  const record = exactRecord(value, 'ExperimentStatisticalPlan', ['method', 'confidenceLevel', 'effectSize', 'multipleComparison', 'spatialAutocorrelation', 'blockingStrategy'])
  const confidenceLevel = finiteNumber(record.confidenceLevel, 'ExperimentStatisticalPlan.confidenceLevel')
  if (confidenceLevel <= 0 || confidenceLevel >= 1) throw new TypeError('ExperimentStatisticalPlan.confidenceLevel must be between 0 and 1')
  return { method: text(record.method, 'ExperimentStatisticalPlan.method'), confidenceLevel, effectSize: text(record.effectSize, 'ExperimentStatisticalPlan.effectSize'), multipleComparison: text(record.multipleComparison, 'ExperimentStatisticalPlan.multipleComparison'), spatialAutocorrelation: text(record.spatialAutocorrelation, 'ExperimentStatisticalPlan.spatialAutocorrelation'), blockingStrategy: text(record.blockingStrategy, 'ExperimentStatisticalPlan.blockingStrategy') }
}

function parseAmendmentProposal(value: unknown): ExperimentAmendmentProposal {
  const record = exactRecord(value, 'ExperimentAmendmentProposal', ['parentSpecId', 'parentSpecDigest', 'changes', 'reason', 'resultsSeenRunIds'])
  const changes = stringArray(record.changes, 'ExperimentAmendmentProposal.changes')
  if (changes.length === 0) throw new TypeError('ExperimentAmendmentProposal.changes must not be empty')
  return { parentSpecId: id(record.parentSpecId, 'ExperimentAmendmentProposal.parentSpecId'), parentSpecDigest: digest(record.parentSpecDigest, 'ExperimentAmendmentProposal.parentSpecDigest'), changes, reason: text(record.reason, 'ExperimentAmendmentProposal.reason'), resultsSeenRunIds: stringArray(record.resultsSeenRunIds, 'ExperimentAmendmentProposal.resultsSeenRunIds') }
}

function parseDatasetRef(value: unknown, field: string): ExperimentDatasetRef {
  const record = exactRecord(value, field, ['datasetId', 'datasetDigest', 'role'])
  return { datasetId: id(record.datasetId, `${field}.datasetId`), datasetDigest: digest(record.datasetDigest, `${field}.datasetDigest`), role: enumValue(record.role, ['training', 'validation', 'testing', 'covariate', 'labels'] as const, `${field}.role`) }
}

function parseResultEntry(value: unknown, field: string): ResultEnvelopeEntry {
  const record = exactRecord(value, field, ['resultId', 'metricId', 'value', 'unit', 'aggregation', 'uncertainty', 'comparisonTarget', 'scope', 'artifactIds'])
  const uncertainty = exactRecord(record.uncertainty, `${field}.uncertainty`, ['kind', 'level', 'lower', 'upper'])
  const kind = enumValue(uncertainty.kind, ['none', 'standard-deviation', 'standard-error', 'confidence-interval'] as const, `${field}.uncertainty.kind`)
  const level = nullableNumber(uncertainty.level, `${field}.uncertainty.level`)
  const lower = nullableNumber(uncertainty.lower, `${field}.uncertainty.lower`)
  const upper = nullableNumber(uncertainty.upper, `${field}.uncertainty.upper`)
  if (kind === 'none' && (level !== null || lower !== null || upper !== null)) throw new TypeError(`${field}.uncertainty none must contain null bounds`)
  if (kind === 'confidence-interval' && (level === null || lower === null || upper === null || lower > upper)) throw new TypeError(`${field}.uncertainty confidence interval is invalid`)
  const scope = exactRecord(record.scope, `${field}.scope`, ['datasetId', 'region', 'sensor', 'split'])
  return { resultId: id(record.resultId, `${field}.resultId`), metricId: id(record.metricId, `${field}.metricId`), value: finiteNumber(record.value, `${field}.value`), unit: text(record.unit, `${field}.unit`), aggregation: text(record.aggregation, `${field}.aggregation`), uncertainty: { kind, level, lower, upper }, comparisonTarget: nullableText(record.comparisonTarget, `${field}.comparisonTarget`), scope: { datasetId: id(scope.datasetId, `${field}.scope.datasetId`), region: text(scope.region, `${field}.scope.region`), sensor: text(scope.sensor, `${field}.scope.sensor`), split: text(scope.split, `${field}.scope.split`) }, artifactIds: stringArray(record.artifactIds, `${field}.artifactIds`) }
}

function parseArtifactRefs(value: unknown, field: string): ArtifactRef[] {
  return objectArray(value, field).map((item, index) => parseArtifactRef(item, `${field}[${index}]`))
}

function parseArtifactRef(value: unknown, field: string): ArtifactRef {
  const record = exactRecord(value, field, ['artifactId', 'digest', 'kind'])
  return { artifactId: text(record.artifactId, `${field}.artifactId`), digest: digest(record.digest, `${field}.digest`), kind: text(record.kind, `${field}.kind`) }
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
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) throw new TypeError(`${field} must be non-empty NUL-free text`)
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

function nullableDigest(value: unknown, field: string): Sha256Digest | null {
  return value === null ? null : digest(value, field)
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive safe integer`)
  return value as number
}

function nullablePositiveInteger(value: unknown, field: string): number | null {
  return value === null ? null : positiveInteger(value, field)
}

function nullableNonNegativeInteger(value: unknown, field: string): number | null {
  if (value === null) return null
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${field} must be a non-negative safe integer or null`)
  return value as number
}

function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${field} must be a finite number`)
  return value
}

function nullableNumber(value: unknown, field: string): number | null {
  return value === null ? null : finiteNumber(value, field)
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

function nullableUtc(value: unknown, field: string): string | null {
  return value === null ? null : utc(value, field)
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  return value.map((item, index) => text(item, `${field}[${index}]`))
}

function digestArray(value: unknown, field: string): Sha256Digest[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  const result = value.map((item, index) => digest(item, `${field}[${index}]`))
  assertUnique(result, field)
  return result
}

function integerArray(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  return value.map((item, index) => {
    if (!Number.isSafeInteger(item) || (item as number) < 0) throw new TypeError(`${field}[${index}] must be a non-negative integer`)
    return item as number
  })
}

function nullableTuple(value: unknown, length: number, field: string): readonly number[] | null {
  if (value === null) return null
  if (!Array.isArray(value) || value.length !== length) throw new TypeError(`${field} must be null or a ${length}-number tuple`)
  return value.map((item, index) => finiteNumber(item, `${field}[${index}]`))
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, field: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new TypeError(`${field} is invalid`)
  return value as T[number]
}

function enumArray<const T extends readonly string[]>(value: unknown, values: T, field: string): T[number][] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  const result = value.map((item, index) => enumValue(item, values, `${field}[${index}]`))
  assertUnique(result, field)
  return result
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new TypeError(`${field} must be unique`)
}
