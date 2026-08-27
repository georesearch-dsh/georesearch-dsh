import { describe, expect, it } from 'vitest'
import {
  digestJson,
  type ProjectEvent,
  type ProjectReducerState,
  type ReviewRecord,
  type ValidationPlan,
  type ValidationReport,
} from '@georesearch/dsh-contracts'
import { reduceProjectEvent } from '../src/reducer.js'

describe('scientific lifecycle reduction', () => {
  it.each([
    ['passed', 'passed'],
    ['failed', 'failed'],
    ['blocked', 'blocked'],
  ] as const)('projects %s validation onto ResultRecord without changing subject identity', (overall, expected) => {
    const resultDigest = digestJson({ result: 'stable' })
    const state = projectState({
      results: {
        'result-1': { resultId: 'result-1', digest: resultDigest, validationStatus: 'pending' },
      } as never,
    })
    const subject = { kind: 'result' as const, subjectId: 'result-1', digest: resultDigest }
    const next = reduceProjectEvent(state, event('validation.completed', {
      validationPlan: { planId: 'plan-1', subjects: [subject] } as ValidationPlan,
      validationReport: { reportId: 'validation-1', subjects: [subject], overall } as ValidationReport,
    }))

    expect(next.results?.['result-1']).toMatchObject({ validationStatus: expected, digest: resultDigest })
  })

  it.each([
    ['accept', 'accepted'],
    ['revise', 'needs-review'],
    ['reject', 'rejected'],
  ] as const)('projects %s review onto Evidence and ReproductionReport without changing digests', (
    recommendation,
    expected,
  ) => {
    const evidenceDigest = digestJson({ evidence: 'stable' })
    const reproductionDigest = digestJson({ reproduction: 'stable' })
    const state = projectState({
      evidence: {
        'evidence-1': { evidenceId: 'evidence-1', digest: evidenceDigest, reviewStatus: 'pending' },
      } as never,
      reproductionReports: {
        'report-1': { reportId: 'report-1', digest: reproductionDigest, reviewStatus: 'pending' },
      } as never,
    })
    const reviewRecord = {
      reviewId: 'review-1',
      recommendation,
      subjectRefs: [
        { kind: 'evidence', subjectId: 'evidence-1', digest: evidenceDigest },
        { kind: 'reproduction-report', subjectId: 'report-1', digest: reproductionDigest },
      ],
    } as ReviewRecord
    const next = reduceProjectEvent(state, event('review.recorded', { reviewRecord }))

    expect(next.evidence?.['evidence-1']).toMatchObject({ reviewStatus: expected, digest: evidenceDigest })
    expect(next.reproductionReports?.['report-1']).toMatchObject({ reviewStatus: expected, digest: reproductionDigest })
  })
})

function projectState(overrides: Partial<ProjectReducerState>): ProjectReducerState {
  return {
    schemaVersion: 1,
    projectId: 'project-1',
    projectBinding: {} as never,
    workspaceBindings: {},
    artifacts: {},
    runs: {},
    sources: {},
    evidence: {},
    repositoryAudits: {},
    reproductionPlans: {},
    reproductionTestSpecs: {},
    reproductionReports: {},
    geodataReports: {},
    datasetManifests: {},
    experimentSpecs: {},
    experimentAmendments: {},
    results: {},
    validationPlans: {},
    validationReports: {},
    reviewRecords: {},
    claims: {},
    writingPackets: {},
    manuscripts: {},
    manuscriptAudits: {},
    activeTaskIds: [],
    blockers: [],
    staleIndicators: [],
    ...overrides,
  }
}

function event(type: string, data: unknown): ProjectEvent {
  return {
    eventSchemaVersion: 1,
    reducerVersion: 1,
    seq: 1,
    time: '2026-08-18T00:00:00.000Z',
    operationKey: digestJson({ operation: type }),
    requestDigest: digestJson({ request: type }),
    type,
    data: data as never,
    previousHash: null,
    hash: digestJson({ event: type }),
  }
}
