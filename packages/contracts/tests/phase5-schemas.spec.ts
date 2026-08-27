import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DATASET_MANIFEST_SCHEMA,
  EXPERIMENT_AMENDMENT_SCHEMA,
  EXPERIMENT_SPEC_CANDIDATE_SCHEMA,
  EXPERIMENT_SPEC_SCHEMA,
  GEODATA_INSPECTION_REPORT_SCHEMA,
  RESULT_ENVELOPE_SCHEMA,
  RESULT_RECORD_SCHEMA,
  digestJson,
  parseDatasetManifest,
  parseExperimentAmendment,
  parseExperimentSpec,
  parseExperimentSpecCandidate,
  parseGeodataInspectionReport,
  parseResultEnvelope,
  parseResultRecord,
  type DatasetManifest,
  type ExperimentAmendment,
  type ExperimentSpec,
  type ExperimentSpecCandidate,
  type GeodataInspectionReport,
  type ResultEnvelope,
  type ResultRecord,
} from '../src/index.js'

describe('Phase 5 schema parity', () => {
  it.each([
    ['geodata-inspection-report.schema.json', 'GeoResearch Geodata Inspection Report', GEODATA_INSPECTION_REPORT_SCHEMA],
    ['dataset-manifest.schema.json', 'GeoResearch Dataset Manifest', DATASET_MANIFEST_SCHEMA],
    ['experiment-spec-candidate.schema.json', 'GeoResearch Experiment Spec Candidate', EXPERIMENT_SPEC_CANDIDATE_SCHEMA],
    ['experiment-spec.schema.json', 'GeoResearch Experiment Spec', EXPERIMENT_SPEC_SCHEMA],
    ['experiment-amendment.schema.json', 'GeoResearch Experiment Amendment', EXPERIMENT_AMENDMENT_SCHEMA],
    ['result-envelope.schema.json', 'GeoResearch Result Envelope', RESULT_ENVELOPE_SCHEMA],
    ['result-record.schema.json', 'GeoResearch Result Record', RESULT_RECORD_SCHEMA],
  ] as const)('keeps %s byte-independent runtime parity', async (file, title, runtime) => {
    const bundled = JSON.parse(await readFile(resolve(
      import.meta.dirname,
      '..',
      '..',
      'bundle',
      'schemas',
      file,
    ), 'utf8')) as Record<string, unknown>
    const { $schema, $id, title: bundledTitle, ...schema } = bundled
    expect($schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect($id).toBe(`https://georesearch.local/schemas/${file}`)
    expect(bundledTitle).toBe(title)
    expect(schema).toEqual(runtime)
  })

  it('strictly parses the complete Phase 5 authority chain', () => {
    const report = geodataReport()
    const manifest = datasetManifest(report)
    const candidate = experimentCandidate(report)
    const spec = experimentSpec(manifest)
    const amendment = experimentAmendment(spec)
    const envelope = resultEnvelope()
    const result = resultRecord(spec, envelope)

    expect(parseGeodataInspectionReport(report)).toEqual(report)
    expect(parseDatasetManifest(manifest)).toEqual(manifest)
    expect(parseExperimentSpecCandidate(candidate)).toEqual(candidate)
    expect(parseExperimentSpec(spec)).toEqual(spec)
    expect(parseExperimentAmendment(amendment)).toEqual(amendment)
    expect(parseResultEnvelope(envelope)).toEqual(envelope)
    expect(parseResultRecord(result)).toEqual(result)
  })

  it('rejects schema drift, inconsistent checks, and incomplete protocol locks', () => {
    const report = geodataReport()
    const manifest = datasetManifest(report)
    const candidate = experimentCandidate(report)
    const spec = experimentSpec(manifest)
    const amendment = experimentAmendment(spec)

    expect(() => parseGeodataInspectionReport({ ...report, overall: 'failed' }))
      .toThrow(/overall does not match/)
    expect(() => parseDatasetManifest({ ...manifest, assetDigests: [digestJson({ wrong: true })] }))
      .toThrow(/must match assetRefs order/)
    expect(() => parseExperimentSpecCandidate({ ...candidate, datasetRoles: [] }))
      .toThrow(/must cover every dataset report/)
    expect(() => parseExperimentSpecCandidate({ ...candidate, seeds: [-1] }))
      .toThrow(/non-negative integer/)
    expect(() => parseExperimentSpec({ ...spec, datasets: [] }))
      .toThrow(/requires datasets/)
    expect(() => parseExperimentSpec({ ...spec, unexpected: true }))
      .toThrow(/unsupported fields/)
    expect(() => parseExperimentAmendment({ ...amendment, changes: [] }))
      .toThrow(/must not be empty/)
  })

  it('rejects ambiguous result envelopes and mismatched artifact lineage', () => {
    const report = geodataReport()
    const spec = experimentSpec(datasetManifest(report))
    const envelope = resultEnvelope()
    expect(() => parseResultEnvelope({
      ...envelope,
      results: [envelope.results[0], envelope.results[0]],
    })).toThrow(/resultId must be unique/)
    const result = resultRecord(spec, envelope)
    expect(() => parseResultRecord({ ...result, artifactIds: ['other-artifact'] }))
      .toThrow(/artifactIds must match artifactRefs order/)
    expect(() => parseResultRecord({
      ...result,
      uncertainty: { kind: 'confidence-interval', level: 0.95, lower: 0.9, upper: 0.8 },
    })).toThrow(/confidence interval is invalid/)
  })
})

function geodataReport(): GeodataInspectionReport {
  const artifactRef = {
    artifactId: 'dataset-raster',
    digest: digestJson({ artifact: 'dataset-raster' }),
    kind: 'geotiff',
  }
  const body = {
    schemaVersion: 1 as const,
    reportId: 'geodata-report-1',
    projectId: 'project-phase5',
    workspaceId: 'workspace-phase5',
    workspaceBindingVersion: 1,
    datasetId: 'dataset-phase5',
    datasetName: 'Public land-cover fixture',
    datasetVersion: '1.0.0',
    source: { uri: 'https://example.test/dataset.tif', provider: 'public-fixture', accessedAt: '2026-08-18T00:00:00.000Z' },
    actions: ['raster-metadata', 'crs', 'extent', 'alignment', 'nodata', 'band-schema', 'label-schema', 'split-summary'] as const,
    provider: {
      providerId: 'python-geospatial' as const,
      providerVersion: '0.1.0',
      protocol: 'georesearch-worker/1' as const,
      shell: false as const,
      persistentWorker: true as const,
      cancel: true as const,
      deadlines: true as const,
      methods: ['inspect-dataset'] as const,
      libraries: { rasterio: '1.4.3', pyproj: '3.7.2' },
    },
    assets: [{
      artifactRef,
      format: 'GTiff',
      width: 16,
      height: 16,
      featureCount: null,
      spatialExtent: [0, 0, 16, 16] as const,
      crs: { authority: 'EPSG:32650', wktDigest: digestJson({ wkt: 'EPSG:32650' }), axisOrder: ['E', 'N'], units: ['metre'] },
      resolution: [1, 1] as const,
      transform: [1, 0, 0, 0, -1, 16] as const,
      bands: [{ index: 1, name: 'class', dataType: 'uint8', unit: null, scale: 1, offset: 0, noData: 255, colorInterpretation: 'gray' }],
      fields: [],
    }],
    splits: [{
      splitId: 'train-split',
      role: 'train' as const,
      sampleIds: ['sample-1'],
      spatialUnitIds: ['tile-1'],
      sourceAssetDigests: [artifactRef.digest],
      temporalKeys: ['2025-01-01'],
    }],
    qualityMasks: ['cloud-mask'],
    preprocessingLevel: 'surface-reflectance',
    labelSchema: [{ value: '1', label: 'forest' }],
    knownLimitations: ['Synthetic contract fixture'],
    checks: [{
      checkId: 'crs-present',
      domain: 'common-gis' as const,
      mandatory: true,
      status: 'passed' as const,
      code: 'CRS_PRESENT',
      message: 'CRS is explicit.',
      relatedArtifactIds: [artifactRef.artifactId],
    }],
    overall: 'passed' as const,
    inspectedAt: '2026-08-18T00:00:00.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

function datasetManifest(report: GeodataInspectionReport): DatasetManifest {
  const asset = report.assets[0]!
  const body = {
    schemaVersion: 1 as const,
    datasetId: report.datasetId,
    name: report.datasetName,
    version: report.datasetVersion,
    projectId: report.projectId,
    workspaceId: report.workspaceId,
    workspaceBindingVersion: report.workspaceBindingVersion,
    source: report.source,
    assetRefs: [asset.artifactRef],
    assetDigests: [asset.artifactRef.digest],
    spatialExtent: asset.spatialExtent,
    timeRange: { start: null, end: null },
    crs: asset.crs,
    resolution: asset.resolution,
    bands: asset.bands,
    fields: asset.fields,
    qualityMasks: report.qualityMasks,
    preprocessingLevel: report.preprocessingLevel,
    labelSchema: report.labelSchema,
    splits: report.splits,
    knownLimitations: report.knownLimitations,
    inspectionReportDigest: report.digest,
    status: 'verified' as const,
    createdAt: '2026-08-18T00:00:01.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

function experimentCandidate(report: GeodataInspectionReport): ExperimentSpecCandidate {
  return {
    schemaVersion: 1,
    kind: 'experiment-spec',
    specId: 'spec-phase5-v1',
    experimentId: 'experiment-phase5',
    revision: 1,
    researchBriefDigest: digestJson({ brief: 1 }),
    hypothesisIds: ['hypothesis-1'],
    repositoryAuditId: 'audit-phase5',
    datasetReports: [report],
    datasetRoles: [{ datasetId: report.datasetId, role: 'training' }],
    baselines: [{
      baselineId: 'baseline-1', description: 'Published baseline', implementationRef: 'src/baseline.py',
      preprocessingPolicy: 'shared', trainingBudget: '10 epochs', postprocessingPolicy: 'none',
    }],
    independentVariables: [{ name: 'model', values: ['baseline', 'candidate'] }],
    controlVariables: [{ name: 'split', value: 'fixed' }],
    splitStrategy: 'spatial blocks',
    preprocessing: [{ stepId: 'normalize', description: 'Normalize imagery.', appliesTo: [report.datasetId], parameters: { method: 'z-score' } }],
    metrics: [{ metricId: 'macro-f1', name: 'Macro F1', unit: 'score', direction: 'maximize', aggregation: 'macro', implementationRef: 'src/metrics.py' }],
    seeds: [7],
    ablations: [{ ablationId: 'no-context', description: 'Remove spatial context.', changedVariables: ['context'] }],
    statisticalPlan: {
      method: 'paired spatial bootstrap', confidenceLevel: 0.95, effectSize: 'mean difference',
      multipleComparison: 'Holm', spatialAutocorrelation: 'Moran I', blockingStrategy: 'spatial blocks',
    },
    stoppingRule: 'complete every registered seed',
    resourceRequirements: ['CPU'],
    acceptanceCriteria: ['No leakage and metric envelope emitted'],
    amendment: null,
  }
}

function experimentSpec(manifest: DatasetManifest): ExperimentSpec {
  const candidate = experimentCandidate(geodataReport())
  const body = {
    schemaVersion: 1 as const,
    specId: candidate.specId,
    experimentId: candidate.experimentId,
    revision: 1,
    projectId: manifest.projectId,
    workspaceId: manifest.workspaceId,
    workspaceBindingVersion: manifest.workspaceBindingVersion,
    researchBriefDigest: candidate.researchBriefDigest,
    hypothesisIds: candidate.hypothesisIds,
    repositoryAuditId: candidate.repositoryAuditId,
    repositoryAuditDigest: digestJson({ audit: 1 }),
    sourceTreeDigest: digestJson({ sourceTree: 1 }),
    datasets: [{ datasetId: manifest.datasetId, datasetDigest: manifest.digest, role: 'training' as const }],
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
    parentSpecDigest: null,
    amendmentIds: [],
    protocolDigest: digestJson({ protocol: candidate.specId }),
    status: 'frozen' as const,
    frozenAt: '2026-08-18T00:00:02.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

function experimentAmendment(spec: ExperimentSpec): ExperimentAmendment {
  const body = {
    schemaVersion: 1 as const,
    amendmentId: 'amendment-phase5-v2',
    projectId: spec.projectId,
    experimentId: spec.experimentId,
    fromSpecId: spec.specId,
    fromSpecDigest: spec.digest,
    toSpecId: 'spec-phase5-v2',
    toSpecDigest: digestJson({ spec: 2 }),
    changes: ['Add a second seed.'],
    reason: 'Robustness check.',
    resultsSeenRunIds: ['run-phase5-v1'],
    createdAt: '2026-08-18T00:00:03.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

function resultEnvelope(): ResultEnvelope {
  return {
    schemaVersion: 1,
    results: [{
      resultId: 'result-phase5',
      metricId: 'macro-f1',
      value: 0.82,
      unit: 'score',
      aggregation: 'macro',
      uncertainty: { kind: 'confidence-interval', level: 0.95, lower: 0.8, upper: 0.84 },
      comparisonTarget: 'baseline-1',
      scope: { datasetId: 'dataset-phase5', region: 'fixture-region', sensor: 'synthetic', split: 'test' },
      artifactIds: ['result-table'],
    }],
  }
}

function resultRecord(spec: ExperimentSpec, envelope: ResultEnvelope): ResultRecord {
  const entry = envelope.results[0]!
  const artifactRef = { artifactId: entry.artifactIds[0]!, digest: digestJson({ artifact: 'result-table' }), kind: 'result-table' }
  const body = {
    schemaVersion: 1 as const,
    ...entry,
    projectId: spec.projectId,
    workspaceId: spec.workspaceId,
    workspaceBindingVersion: spec.workspaceBindingVersion,
    experimentSpecId: spec.specId,
    experimentSpecDigest: spec.digest,
    runId: 'run-phase5-v1',
    runDigest: digestJson({ run: 1 }),
    datasetDigests: spec.datasets.map(dataset => dataset.datasetDigest),
    validationStatus: 'pending' as const,
    artifactRefs: [artifactRef],
    committedAt: '2026-08-18T00:00:04.000Z',
  }
  return { ...body, digest: digestJson(body) }
}
