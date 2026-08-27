import { describe, expect, it } from 'vitest'
import { digestJson, type GeodataInspectionReport, type ReviewRecord } from '@georesearch/dsh-contracts'
import type { Agent, ToolExecution } from '@georesearch/dsh-compat-rc5'
import { ValidationCoordinator, validationTools } from '../src/index.js'

describe('ValidationCoordinator', () => {
  it('tells proposal reviewers to use the bootstrapped authority generation', () => {
    const tool = validationTools({} as never).find(candidate => candidate.name === 'review_candidate')
    expect(tool?.description).toMatch(/delegation_bootstrap authority\.generation/iu)
    expect(tool?.description).toMatch(/never.*hard-coded/iu)
  })

  it('generates the mandatory plan and fails a preset spatial leak', async () => {
    const report = geodataReport()
    let committed: any
    const coordinator = new ValidationCoordinator({
      projects: {
        async resolveAgent() { return resolved() as never },
        async loadProject() { return project(report) as never },
        async commitValidation(_projectId, request) { committed = request; return project(report) as never },
        async commitReviewRecord() { throw new Error('not used') },
      },
      host: { requireReviewer: requireReviewer },
    }, fixedClock())

    const outcome = await coordinator.validateGeodata(execution(), 4, report.reportId)
    expect(outcome.plan.validators).toHaveLength(6)
    expect(outcome.report.overall).toBe('failed')
    expect(outcome.report.validatorResults.some(result => (
      result.findings.some(finding => finding.code === 'SPATIAL_LEAKAGE_DETECTED')
    ))).toBe(true)
    expect(committed.validationPlan.digest).toBe(outcome.plan.digest)
    expect(committed.validationReport.digest).toBe(outcome.report.digest)
  })

  it('stores Reviewer output as a separate record without changing the subject', async () => {
    const report = geodataReport()
    let recorded: ReviewRecord | undefined
    const coordinator = new ValidationCoordinator({
      projects: {
        async resolveAgent() { return resolved() as never },
        async loadProject() { return project(report) as never },
        async commitValidation() { throw new Error('not used') },
        async commitReviewRecord(_projectId, request) { recorded = request.reviewRecord; return project(report) as never },
      },
      host: { requireReviewer: requireReviewer },
    }, fixedClock())
    const candidate = {
      schemaVersion: 1,
      kind: 'review',
      reviewId: 'review-leakage',
      subjectRefs: [{ kind: 'geodata-report', subjectId: report.reportId, digest: report.digest }],
      validationReportIds: [],
      findings: [{
        findingId: 'finding-leakage',
        validatorId: 'reviewer.scientific-consistency',
        severity: 'hard',
        code: 'SPATIAL_LEAKAGE_REQUIRES_REVISION',
        message: 'The leaked split invalidates the comparison.',
        subjectIds: [report.reportId],
      }],
      recommendation: 'revise',
      supersedesReviewIds: [],
    }
    const result = await coordinator.reviewCandidate(execution(), 4, candidate)
    expect(result).toEqual(recorded)
    expect(result.subjectRefs[0]?.digest).toBe(report.digest)
    expect(project(report).state.geodataReports[report.reportId]?.digest).toBe(report.digest)
  })

  it('does not report pending Evidence as already reviewed during citation validation', async () => {
    const evidenceDigest = digestJson({ evidence: 'pending-review' })
    const state = {
      sources: { 'source-1': { sourceId: 'source-1' } },
      artifacts: {
        'artifact-1': {
          artifactId: 'artifact-1', digest: digestJson({ artifact: 1 }),
          materialization: 'committed', integrity: 'verified', validity: 'current',
        },
      },
      evidence: {
        'evidence-1': {
          evidenceId: 'evidence-1', sourceId: 'source-1', artifactId: 'artifact-1',
          artifactDigest: digestJson({ artifact: 1 }), digest: evidenceDigest,
          locator: { pageStart: 1, pageEnd: 1 },
          extractionLineage: { parserId: 'pdfjs-dist', parserVersion: '5.4.54' },
          reviewStatus: 'pending',
        },
      },
    }
    const coordinator = new ValidationCoordinator({
      projects: {
        async resolveAgent() { return resolved() as never },
        async loadProject() { return { projectId: 'project-1', generation: 4, state } as never },
        async commitValidation() { return { projectId: 'project-1', generation: 5, state } as never },
        async commitReviewRecord() { throw new Error('not used') },
      },
      host: { requireReviewer },
    }, fixedClock())

    const outcome = await coordinator.validateCitation(execution(), 4, ['evidence-1'])
    const reviewState = outcome.report.validatorResults.find(result => result.validatorId === 'citation.review-state')
    expect(reviewState).toMatchObject({
      status: 'not-applicable',
      findings: [{ code: 'CITATION_REVIEW_PENDING' }],
    })
    expect(reviewState?.status).not.toBe('passed')
  })

  it('fails an amendment after authoritative testing results even when resultsSeenRunIds omits them', async () => {
    const state = experimentStateWithTestSetTuning()
    let committed: any
    const coordinator = new ValidationCoordinator({
      projects: {
        async resolveAgent() { return resolved() as never },
        async loadProject() { return { projectId: 'project-1', generation: 7, state } as never },
        async commitValidation(_projectId, request) { committed = request; return { projectId: 'project-1', generation: 8, state } as never },
        async commitReviewRecord() { throw new Error('not used') },
      },
      host: { requireReviewer },
    }, fixedClock())

    const outcome = await coordinator.validateExperiment(execution(), 7, ['result-current'])
    expect(outcome.report.overall).toBe('failed')
    expect(outcome.plan.validators.map(validator => validator.validatorId)).toContain('experiment.test-set-independence')
    expect(outcome.report.validatorResults.some(result => (
      result.findings.some(finding => finding.code === 'TEST_SET_TUNING_DETECTED')
    ))).toBe(true)
    expect(committed.validationReport.digest).toBe(outcome.report.digest)
  })
})

function geodataReport(): GeodataInspectionReport {
  const body = {
    schemaVersion: 1 as const,
    reportId: 'geodata-leakage', projectId: 'project-1', workspaceId: 'workspace-1', workspaceBindingVersion: 1,
    datasetId: 'dataset-1', datasetName: 'Public fixture', datasetVersion: '1',
    source: { uri: 'https://example.test/public.geojson', provider: 'public', accessedAt: '2026-08-18T10:00:00.000Z' },
    actions: ['crs', 'split-summary'] as const,
    provider: {
      providerId: 'python-geospatial' as const, providerVersion: '0.1.0', protocol: 'georesearch-worker/1' as const,
      shell: false as const, persistentWorker: true as const, cancel: true as const, deadlines: true as const,
      methods: ['inspect-dataset'] as const, libraries: { rasterio: '1.4.3', pyproj: '3.7.2' },
    },
    assets: [{
      artifactRef: { artifactId: 'artifact-1', digest: digestJson({ artifact: 1 }), kind: 'geojson' },
      format: 'GeoJSON', width: null, height: null, featureCount: 177,
      spatialExtent: [-180, -90, 180, 90] as const,
      crs: { authority: 'OGC:CRS84', wktDigest: null, axisOrder: ['longitude', 'latitude'], units: ['degree'] },
      resolution: null, transform: null, bands: [], fields: [],
    }],
    splits: [], qualityMasks: [], preprocessingLevel: 'raw', labelSchema: [], knownLimitations: [],
    checks: [{
      checkId: 'crs-present', domain: 'common-gis' as const, mandatory: true, status: 'passed' as const,
      code: 'CRS_PRESENT', message: 'CRS is present.', relatedArtifactIds: ['artifact-1'],
    }, {
      checkId: 'spatial-leakage', domain: 'geospatial-ml' as const, mandatory: true, status: 'failed' as const,
      code: 'SPATIAL_LEAKAGE_DETECTED', message: 'Split units overlap.', relatedArtifactIds: ['artifact-1'],
    }],
    overall: 'failed' as const, inspectedAt: '2026-08-18T10:00:00.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

function project(report: GeodataInspectionReport) {
  return {
    projectId: 'project-1', generation: 4,
    state: { geodataReports: { [report.reportId]: report } },
  }
}

function experimentStateWithTestSetTuning() {
  const datasetDigest = digestJson({ dataset: 'testing' })
  const specDigest = digestJson({ spec: 'amended-after-test' })
  const currentRun = {
    runId: 'run-current', kind: 'formal', state: 'succeeded', experimentSpecDigest: specDigest,
    datasetDigests: [datasetDigest],
  }
  const resultBody = {
    resultId: 'result-current', metricId: 'macro-f1', value: 0.71, unit: 'score', aggregation: 'macro',
    scope: { datasetId: 'dataset-test', region: 'fixture', sensor: 'satellite', split: 'test' },
    experimentSpecId: 'spec-2', experimentSpecDigest: specDigest,
    runId: currentRun.runId, runDigest: digestJson(currentRun), datasetDigests: [datasetDigest],
  }
  return {
    runs: {
      [currentRun.runId]: currentRun,
      'run-seen': {
        runId: 'run-seen', kind: 'formal', state: 'succeeded', experimentSpecDigest: digestJson({ spec: 'parent' }),
        datasetDigests: [datasetDigest],
      },
    },
    datasetManifests: {
      'dataset-test': { datasetId: 'dataset-test', digest: datasetDigest, status: 'verified' },
    },
    experimentSpecs: {
      'spec-2': {
        specId: 'spec-2', digest: specDigest,
        datasets: [{ datasetId: 'dataset-test', datasetDigest, role: 'testing' }],
        metrics: [{ metricId: 'macro-f1', unit: 'score', aggregation: 'macro' }],
        amendmentIds: ['amendment-after-test'],
      },
    },
    experimentAmendments: {
      'amendment-after-test': {
        amendmentId: 'amendment-after-test', fromSpecId: 'spec-parent',
        resultsSeenRunIds: [], createdAt: '2026-08-18T10:10:00.000Z',
      },
    },
    results: {
      'result-current': { ...resultBody, digest: digestJson(resultBody) },
      'result-seen': {
        resultId: 'result-seen', experimentSpecId: 'spec-parent', runId: 'run-seen',
        scope: { datasetId: 'dataset-test', split: 'test' },
        committedAt: '2026-08-18T10:05:00.000Z',
        digest: digestJson({ result: 'seen-before-amendment' }),
      },
    },
  }
}

function resolved() {
  return {
    stateFile: { projectId: 'project-1' },
    binding: { workspaceId: 'workspace-1', bindingVersion: 1 },
  }
}

function requireReviewer(agent: Agent): void {
  if (String(agent.id) !== 'reviewer') throw new Error('reviewer required')
}

function execution(): ToolExecution {
  return {
    agent: { id: 'reviewer', session: { id: 'session-reviewer' } } as unknown as Agent,
    rootCallId: 'root', callId: 'call', signal: new AbortController().signal,
  } as unknown as ToolExecution
}

function fixedClock(): () => string {
  let tick = 0
  return () => new Date(Date.UTC(2026, 7, 18, 10, 0, tick++)).toISOString()
}
