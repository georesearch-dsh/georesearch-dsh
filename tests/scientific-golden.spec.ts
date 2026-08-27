import { describe, expect, it } from 'vitest'
import {
  digestJson,
  type ClaimProposal,
  type ProjectReducerState,
} from '@georesearch/dsh-contracts'
import type { Agent, ToolExecution } from '@georesearch/dsh-compat-rc5'
import { CrossrefLiteratureProvider } from '@georesearch/dsh-evidence-providers'
import { reduceProjectEvent } from '@georesearch/dsh-project-provider-files'
import { assessClaimSupport, assertReviewRecordAuthority } from '@georesearch/dsh-project-service'
import { ValidationCoordinator } from '@georesearch/dsh-validation-service'
import { auditManuscript } from '@georesearch/dsh-writing-service'

describe('Phase 7 scientific golden cases', () => {
  it('does not trust a malformed DOI returned by a literature provider', async () => {
    const provider = new CrossrefLiteratureProvider({
      fetch: async () => Response.json({
        message: {
          items: [{
            DOI: 'doi:wrong', title: ['Invalid DOI'], author: [],
            'published-online': { 'date-parts': [[2025]] },
            'container-title': ['Golden Journal'], type: 'journal-article',
            URL: 'https://example.test/golden-invalid-doi',
          }],
          'total-results': 1,
        },
      }),
    })
    const page = await provider.searchPage({
      request: { query: 'invalid DOI', filters: { yearStart: null, yearEnd: null, publicationTypes: [] }, maxResults: 1 },
      upstreamState: provider.initialUpstreamState(),
      credential: { ref: null, value: null, bindingEpoch: 0 },
      pageSize: 1,
    })
    expect(page.items[0]?.doi).toBeNull()
    expect(page.items[0]?.stableIdentifier).toBe('provider:https://example.test/golden-invalid-doi')
    expect(page.warnings).toContainEqual(expect.objectContaining({ code: 'LITERATURE_DOI_INVALID' }))
    await provider.dispose()
  })

  it('marks a literature Claim insufficient when its citation does not support the proposition', () => {
    const state = emptyState()
    const source = { sourceId: 'source-1', digest: digestJson({ source: 1 }) }
    const artifact = {
      artifactId: 'artifact-1', digest: digestJson({ artifact: 1 }), materialization: 'committed',
      integrity: 'verified', validity: 'current',
    }
    const evidenceBody = {
      evidenceId: 'evidence-1', sourceId: source.sourceId, artifactId: artifact.artifactId,
      artifactDigest: artifact.digest, relation: 'insufficient', reviewStatus: 'accepted',
    }
    const evidence = { ...evidenceBody, digest: digestJson(evidenceBody) }
    state.sources = { [source.sourceId]: source } as never
    state.artifacts = { [artifact.artifactId]: artifact } as never
    state.evidence = { [evidence.evidenceId]: evidence } as never
    const proposal = {
      schemaVersion: 1,
      kind: 'claim',
      claimId: 'claim-unsupported',
      statement: 'The cited paper proves the proposed result.',
      claimType: 'literature-fact',
      supportRefs: [{ kind: 'evidence', recordId: evidence.evidenceId, digest: evidence.digest }],
      calculation: null,
      limitations: [],
      intendedSections: ['introduction'],
      validationReportIds: [],
      reviewRecordIds: [],
    } satisfies ClaimProposal
    expect(assessClaimSupport(state, proposal)).toMatchObject({
      supportState: 'insufficient-evidence', integrity: 'verified', validity: 'current',
    })
  })

  it('does not allow a Claim to omit an active negative Review of its support', () => {
    const state = reviewedResultState('reject')
    const result = state.results?.['result-reviewed']!
    const proposal = {
      schemaVersion: 1,
      kind: 'claim',
      claimId: 'claim-omits-negative-review',
      statement: 'The reviewed result supports the conclusion.',
      claimType: 'experimental-observation',
      supportRefs: [{ kind: 'result', recordId: result.resultId, digest: result.digest }],
      calculation: null,
      limitations: [],
      intendedSections: ['results'],
      validationReportIds: ['validation-reviewed'],
      reviewRecordIds: [],
    } satisfies ClaimProposal

    expect(assessClaimSupport(state, proposal)).toMatchObject({
      supportState: 'insufficient-evidence', integrity: 'failed', validity: 'current',
    })
  })

  it('requires an accepted Review covering every operand before elevating a derived calculation', () => {
    const state = reviewedResultState('accept')
    const result = state.results?.['result-reviewed']!
    const proposal = {
      schemaVersion: 1,
      kind: 'claim',
      claimId: 'claim-derived-without-review',
      statement: 'The mean reviewed score is 0.75.',
      claimType: 'derived-calculation',
      supportRefs: [{ kind: 'result', recordId: result.resultId, digest: result.digest }],
      calculation: { operation: 'mean', operandResultIds: [result.resultId] },
      limitations: ['One result is available.'],
      intendedSections: ['results'],
      validationReportIds: ['validation-reviewed'],
      reviewRecordIds: [],
    } satisfies ClaimProposal

    expect(assessClaimSupport(state, proposal).supportState).toBe('insufficient-evidence')
    expect(assessClaimSupport(state, {
      ...proposal,
      reviewRecordIds: ['review-reviewed'],
    }).supportState).toBe('independently-checked')
  })

  it('rejects an accepted Review backed by validation of another object', () => {
    const state = reviewedResultState('accept')
    const reviewed = state.results?.['result-reviewed']!
    const otherBody = { ...reviewed, resultId: 'result-other', value: 0.61 }
    const other = { ...otherBody, digest: digestJson(otherBody) }
    const otherSubject = { kind: 'result' as const, subjectId: other.resultId, digest: other.digest }
    const validationBody = {
      ...state.validationReports?.['validation-reviewed']!,
      reportId: 'validation-other',
      subjects: [otherSubject],
    }
    const validation = { ...validationBody, digest: digestJson(validationBody) }
    state.results = { ...state.results, [other.resultId]: other } as never
    state.validationReports = { [validation.reportId]: validation } as never
    const review = {
      ...state.reviewRecords?.['review-reviewed']!,
      validationReportIds: [validation.reportId],
    }

    expect(() => assertReviewRecordAuthority(state, review as never)).toThrowError(
      expect.objectContaining({ code: 'REVIEW_INVALID' }),
    )
  })

  it('rejects superseding a Review that covers a different object', () => {
    const state = reviewedResultState('accept')
    const reviewed = state.results?.['result-reviewed']!
    const otherBody = { ...reviewed, resultId: 'result-other', value: 0.61 }
    const other = { ...otherBody, digest: digestJson(otherBody) }
    state.results = { ...state.results, [other.resultId]: other } as never
    const replacement = {
      ...state.reviewRecords?.['review-reviewed']!,
      reviewId: 'review-replacement',
      subjectRefs: [{ kind: 'result', subjectId: other.resultId, digest: other.digest }],
      validationReportIds: [],
      recommendation: 'revise',
      supersedesReviewIds: ['review-reviewed'],
    }

    expect(() => assertReviewRecordAuthority(state, replacement as never)).toThrowError(
      expect.objectContaining({ code: 'REVIEW_INVALID' }),
    )
  })

  it('detects protocol amendments made after testing data were observed', async () => {
    const outcome = await validateExperiment({ tuning: true })
    expect(outcome.report.overall).toBe('failed')
    expect(outcome.report.validatorResults.flatMap(result => result.findings))
      .toContainEqual(expect.objectContaining({ code: 'TEST_SET_TUNING_DETECTED' }))
  })

  it('detects a Result metric that differs from the frozen ExperimentSpec', async () => {
    const outcome = await validateExperiment({ metricUnit: 'percent' })
    expect(outcome.report.overall).toBe('failed')
    expect(outcome.report.validatorResults.flatMap(result => result.findings))
      .toContainEqual(expect.objectContaining({ code: 'METRIC_CONTRACT_MISMATCH' }))
  })

  it('rejects a manuscript number that differs from its ResultRecord', () => {
    const { state, packet, claim, result } = writingFixture()
    const audit = auditManuscript(state, packet as never, {
      schemaVersion: 1,
      kind: 'manuscript',
      manuscriptId: 'manuscript-number-mismatch',
      packetId: packet.packetId,
      packetDigest: packet.digest,
      title: 'Golden manuscript',
      sections: [{
        sectionId: 'results',
        title: 'Results',
        blocks: [{
          blockId: 'result-block',
          text: 'Macro F1 was 0.80.',
          claimIds: [claim.claimId],
          evidenceIds: [],
          resultIds: [result.resultId],
          numericRefs: [{ literal: '0.80', claimId: claim.claimId, resultId: result.resultId }],
        }],
      }],
    }, '2026-08-18T12:00:00.000Z')
    expect(audit.overall).toBe('failed')
    expect(audit.findings).toContainEqual(expect.objectContaining({ code: 'MANUSCRIPT_NUMBER_UNTRACED' }))
  })

  it('preserves an unreproducible diagnosis as an immutable negative result', () => {
    const state = emptyState()
    const report = {
      reportId: 'reproduction-unavailable',
      status: 'blocked-by-missing-data',
      digest: digestJson({ status: 'blocked-by-missing-data' }),
    }
    const reduced = reduceProjectEvent(state, {
      type: 'reproduction.report.recorded',
      data: { reproductionReport: report },
      time: '2026-08-18T12:00:00.000Z',
    } as never)
    expect(reduced.reproductionReports?.[report.reportId]).toEqual(report)
  })

  it('passes a below-baseline Result when execution and contracts are correct', async () => {
    const outcome = await validateExperiment({ value: 0.71, comparisonTarget: 'published-baseline:0.80' })
    expect(outcome.report.overall).toBe('passed')
    expect(outcome.report.validatorResults.every(result => result.status === 'passed')).toBe(true)
  })
})

async function validateExperiment(options: {
  readonly tuning?: boolean
  readonly metricUnit?: string
  readonly value?: number
  readonly comparisonTarget?: string | null
}) {
  const datasetDigest = digestJson({ dataset: 'golden-testing' })
  const specDigest = digestJson({ spec: 'golden' })
  const run = {
    runId: 'run-current', kind: 'formal', state: 'succeeded',
    experimentSpecDigest: specDigest, datasetDigests: [datasetDigest],
  }
  const resultBody = {
    resultId: 'result-current', metricId: 'macro-f1', value: options.value ?? 0.75,
    unit: options.metricUnit ?? 'score', aggregation: 'macro',
    comparisonTarget: options.comparisonTarget ?? null,
    scope: { datasetId: 'dataset-test', region: 'golden', sensor: 'satellite', split: 'test' },
    experimentSpecId: 'spec-current', experimentSpecDigest: specDigest,
    runId: run.runId, runDigest: digestJson(run), datasetDigests: [datasetDigest],
  }
  const result = { ...resultBody, digest: digestJson(resultBody) }
  const state: any = {
    runs: { [run.runId]: run },
    datasetManifests: { 'dataset-test': { datasetId: 'dataset-test', digest: datasetDigest, status: 'verified' } },
    experimentSpecs: {
      'spec-current': {
        specId: 'spec-current', digest: specDigest,
        datasets: [{ datasetId: 'dataset-test', datasetDigest, role: 'testing' }],
        metrics: [{ metricId: 'macro-f1', unit: 'score', aggregation: 'macro' }],
        amendmentIds: options.tuning === true ? ['amendment-after-test'] : [],
      },
    },
    experimentAmendments: {},
    results: { [result.resultId]: result },
  }
  if (options.tuning === true) {
    state.runs['run-seen'] = {
      runId: 'run-seen', kind: 'formal', state: 'succeeded',
      experimentSpecDigest: digestJson({ spec: 'parent' }), datasetDigests: [datasetDigest],
    }
    state.experimentAmendments['amendment-after-test'] = {
      amendmentId: 'amendment-after-test', resultsSeenRunIds: ['run-seen'],
    }
  }
  const coordinator = new ValidationCoordinator({
    projects: {
      async resolveAgent() {
        return { stateFile: { projectId: 'project-golden' }, binding: { workspaceId: 'workspace-golden', bindingVersion: 1 } } as never
      },
      async loadProject() { return { projectId: 'project-golden', generation: 3, state } as never },
      async commitValidation() { return { projectId: 'project-golden', generation: 4, state } as never },
      async commitReviewRecord() { throw new Error('not used') },
    },
    host: { requireReviewer() {} },
  }, fixedClock())
  return coordinator.validateExperiment(reviewerExecution(), 3, [result.resultId])
}

function writingFixture() {
  const state = emptyState()
  const briefBody = {
    briefId: 'brief-1',
    hypotheses: [],
  }
  const brief = { ...briefBody, digest: digestJson(briefBody) }
  const spec = { specId: 'spec-1', digest: digestJson({ spec: 1 }) }
  const run = { runId: 'run-1', experimentSpecDigest: spec.digest, datasetDigests: [] }
  const resultBody = {
    resultId: 'result-1', metricId: 'macro-f1', value: 0.71, unit: 'score', aggregation: 'macro',
    comparisonTarget: 'published-baseline:0.80',
    scope: { datasetId: 'dataset-1', region: 'golden', sensor: 'satellite', split: 'test' },
    experimentSpecId: spec.specId, experimentSpecDigest: spec.digest,
    runId: run.runId, runDigest: digestJson(run), datasetDigests: [], artifactRefs: [],
  }
  const result = { ...resultBody, digest: digestJson(resultBody) }
  const validationBody = {
    reportId: 'validation-1', projectId: state.projectId, overall: 'passed',
    subjects: [{ kind: 'result', subjectId: result.resultId, digest: result.digest }],
  }
  const validation = { ...validationBody, digest: digestJson(validationBody) }
  const claimBody = {
    schemaVersion: 1, kind: 'claim', claimId: 'claim-result',
    statement: 'The candidate achieved macro F1 0.71.', claimType: 'experimental-observation',
    supportRefs: [{ kind: 'result', recordId: result.resultId, digest: result.digest }],
    calculation: null, limitations: ['Below the published baseline.'], intendedSections: ['results'],
    validationReportIds: [validation.reportId], reviewRecordIds: [],
    projectId: state.projectId, workspaceId: 'workspace-golden', workspaceBindingVersion: 1,
    supportState: 'experiment-supported', approvalState: 'approved', integrity: 'verified', validity: 'current',
    approval: { requested: 'approved', outcome: 'approved', source: 'user', callId: 'call-1', decidedAt: '2026-08-18T11:00:00.000Z' },
    committedAt: '2026-08-18T11:00:00.000Z',
  }
  const claim = { ...claimBody, digest: digestJson(claimBody) }
  state.workspaceBindings = { 'workspace-golden': { workspaceId: 'workspace-golden', bindingVersion: 1 } } as never
  state.researchBrief = brief as never
  state.experimentSpecs = { [spec.specId]: spec } as never
  state.runs = { [run.runId]: run } as never
  state.results = { [result.resultId]: result } as never
  state.validationReports = { [validation.reportId]: validation } as never
  state.claims = { [claim.claimId]: claim } as never
  const packetBody = {
    schemaVersion: 1, packetId: 'packet-1', projectId: state.projectId,
    workspaceId: 'workspace-golden', workspaceBindingVersion: 1,
    researchBrief: brief, claims: [claim], sources: [], evidence: [], experimentSpecs: [spec],
    runs: [run], results: [result], validationReports: [validation], artifactRefs: [],
    limitations: ['Below the published baseline.'], forbiddenClaimIds: [], builtAt: '2026-08-18T11:30:00.000Z',
  }
  const packet = { ...packetBody, digest: digestJson(packetBody) }
  return { state, packet, claim, result }
}

function emptyState(): ProjectReducerState {
  return {
    schemaVersion: 1,
    projectId: 'project-golden',
    projectBinding: {
      schemaVersion: 1, projectId: 'project-golden', workspaceIds: [],
      createdAt: '2026-08-18T10:00:00.000Z', updatedAt: '2026-08-18T10:00:00.000Z',
    },
    workspaceBindings: {},
    artifacts: {}, runs: {}, sources: {}, evidence: {}, repositoryAudits: {}, reproductionPlans: {},
    reproductionTestSpecs: {}, reproductionReports: {}, geodataReports: {}, datasetManifests: {},
    experimentSpecs: {}, experimentAmendments: {}, results: {}, validationPlans: {}, validationReports: {},
    reviewRecords: {}, claims: {}, writingPackets: {}, manuscripts: {}, manuscriptAudits: {},
    activeTaskIds: [], blockers: [], staleIndicators: [],
  }
}

function reviewedResultState(recommendation: 'accept' | 'reject'): ProjectReducerState {
  const state = emptyState()
  const resultBody = {
    resultId: 'result-reviewed', metricId: 'macro-f1', value: 0.75, unit: 'score', aggregation: 'macro',
    comparisonTarget: null,
    scope: { datasetId: 'dataset-reviewed', region: 'golden', sensor: 'satellite', split: 'test' },
    experimentSpecId: 'spec-reviewed', experimentSpecDigest: digestJson({ spec: 'reviewed' }),
    runId: 'run-reviewed', runDigest: digestJson({ run: 'reviewed' }), datasetDigests: [], artifactRefs: [],
  }
  const result = { ...resultBody, digest: digestJson(resultBody) }
  const subject = { kind: 'result' as const, subjectId: result.resultId, digest: result.digest }
  const validationBody = {
    reportId: 'validation-reviewed', projectId: state.projectId, subjects: [subject], overall: 'passed',
  }
  const validation = { ...validationBody, digest: digestJson(validationBody) }
  const reviewBody = {
    reviewId: 'review-reviewed', projectId: state.projectId, subjectRefs: [subject],
    validationReportIds: [validation.reportId], recommendation,
    findings: recommendation === 'accept' ? [] : [{ severity: 'hard' }], supersedesReviewIds: [],
  }
  const review = { ...reviewBody, digest: digestJson(reviewBody) }
  state.results = { [result.resultId]: result } as never
  state.validationReports = { [validation.reportId]: validation } as never
  state.reviewRecords = { [review.reviewId]: review } as never
  return state
}

function reviewerExecution(): ToolExecution {
  return {
    agent: { id: 'reviewer', session: { id: 'reviewer-session' } } as unknown as Agent,
    rootCallId: 'golden-root', callId: 'golden-call', signal: new AbortController().signal,
  } as unknown as ToolExecution
}

function fixedClock(): () => string {
  let tick = 0
  return () => new Date(Date.UTC(2026, 7, 18, 10, 0, tick++)).toISOString()
}
