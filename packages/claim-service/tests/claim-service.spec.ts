import { describe, expect, it } from 'vitest'
import { digestJson, type ClaimRecord, type ProjectReducerState } from '@georesearch/dsh-contracts'
import type { Agent, ToolExecution } from '@georesearch/dsh-compat-rc5'
import { ClaimCoordinator } from '../src/index.js'

describe('ClaimCoordinator', () => {
  it('requires explicit user approval before a Claim becomes approved', async () => {
    const state = projectState()
    let committed: ClaimRecord | undefined
    let approvalCalls = 0
    const coordinator = new ClaimCoordinator({
      projects: projectPorts(state, claim => { committed = claim }),
      host: {
        requireCoordinator,
        isWorkflowAutonomous() { return false },
        async requestApproval() { approvalCalls += 1; return 'allowed-once' },
      },
    }, fixedClock())
    const claim = await coordinator.commitClaim(execution(), 3, hypothesisProposal(state), 'approved')
    expect(claim).toEqual(committed)
    expect(claim).toMatchObject({
      supportState: 'proposed',
      approvalState: 'approved',
      approval: { outcome: 'approved', source: 'user' },
      integrity: 'verified',
      validity: 'current',
    })
    expect(approvalCalls).toBe(1)
  })

  it('uses session autonomy as user authorization without calling the approval port', async () => {
    const state = projectState()
    let approvalCalls = 0
    const coordinator = new ClaimCoordinator({
      projects: projectPorts(state),
      host: {
        requireCoordinator,
        isWorkflowAutonomous() { return true },
        async requestApproval() { approvalCalls += 1; return 'rejected' },
      },
    }, fixedClock())

    const claim = await coordinator.commitClaim(execution(), 3, hypothesisProposal(state), 'approved')

    expect(claim).toMatchObject({
      approvalState: 'approved',
      approval: { outcome: 'approved', source: 'user' },
      integrity: 'verified',
      validity: 'current',
    })
    expect(approvalCalls).toBe(0)
  })

  it('builds the complete eligible set and forbids pending or hard-reviewed Claims', async () => {
    const state = projectState()
    const approved = approvedHypothesis(state, 'claim-approved')
    const pending = { ...approvedHypothesis(state, 'claim-pending'), approvalState: 'pending' as const,
      approval: { ...approved.approval, requested: 'pending' as const, outcome: 'pending' as const, source: 'coordinator' as const } }
    const reviewBody = {
      schemaVersion: 1 as const, kind: 'review' as const, reviewId: 'review-hard',
      subjectRefs: [{ kind: 'experiment-spec' as const, subjectId: 'spec-1', digest: digestJson({ spec: 1 }) }],
      validationReportIds: [],
      findings: [{
        findingId: 'finding-hard', validatorId: 'reviewer', severity: 'hard' as const,
        code: 'HARD_BLOCK', message: 'Hard review remains open.', subjectIds: ['spec-1'],
      }],
      recommendation: 'revise' as const, supersedesReviewIds: [],
      projectId: 'project-1', workspaceId: 'workspace-1', workspaceBindingVersion: 1,
      createdAt: '2026-08-18T10:00:00.000Z',
    }
    const review = { ...reviewBody, digest: digestJson(reviewBody) }
    const hardReviewedBody = { ...approvedHypothesis(state, 'claim-hard'), reviewRecordIds: [review.reviewId] }
    const { digest: _old, ...hardWithoutDigest } = hardReviewedBody
    const hardReviewed = { ...hardWithoutDigest, digest: digestJson(hardWithoutDigest) }
    state.claims = {
      [approved.claimId]: approved,
      [pending.claimId]: pending,
      [hardReviewed.claimId]: hardReviewed,
    }
    state.reviewRecords = { [review.reviewId]: review }
    let packet: any
    const coordinator = new ClaimCoordinator({
      projects: projectPorts(state, undefined, value => { packet = value }),
      host: {
        requireCoordinator,
        isWorkflowAutonomous() { return false },
        async requestApproval() { return 'allowed-once' },
      },
    }, fixedClock())
    const result = await coordinator.buildWritingPacket(execution(), 3, 'packet-1')
    expect(result).toEqual(packet)
    expect(result.claims.map(claim => claim.claimId)).toEqual(['claim-approved'])
    expect(result.forbiddenClaimIds).toEqual(['claim-hard', 'claim-pending'])
    expect(result.evidence).toEqual([])
    expect(result.results).toEqual([])
  })
})

function projectPorts(
  state: ProjectReducerState,
  onClaim?: (claim: ClaimRecord) => void,
  onPacket?: (packet: unknown) => void,
): any {
  return {
    async resolveAgent() {
      return { stateFile: { projectId: 'project-1' }, binding: { workspaceId: 'workspace-1', bindingVersion: 1 } }
    },
    async loadProject() { return { projectId: 'project-1', generation: 3, state } },
    async commitClaimRecord(_projectId: string, request: any) { onClaim?.(request.claim); return { projectId: 'project-1', generation: 4, state } },
    async commitWritingPacket(_projectId: string, request: any) { onPacket?.(request.writingPacket); return { projectId: 'project-1', generation: 4, state } },
  }
}

function projectState(): ProjectReducerState {
  const briefBody = {
    schemaVersion: 1 as const, briefId: 'brief-1', title: 'Leakage-safe experiment',
    researchQuestion: 'Does spatial blocking prevent leakage?', background: 'Public GIS benchmark.',
    motivation: 'Traceable evaluation.', region: { description: 'Global' },
    timeRange: { start: null, end: null }, researchSubjects: ['land cover'], dataModalities: ['vector'],
    hypotheses: [{ hypothesisId: 'hypothesis-1', statement: 'Spatial blocking prevents leakage.' }],
    expectedContributions: [], constraints: [], knownAssumptions: [], successCriteria: ['No leakage'],
    userConfirmation: { confirmed: true as const, confirmedAt: '2026-08-18T09:00:00.000Z', confirmedBy: 'user' as const, auditNote: 'Approved.' },
    committedAt: '2026-08-18T09:00:00.000Z',
  }
  const brief = { ...briefBody, digest: digestJson(briefBody) }
  return {
    schemaVersion: 1, projectId: 'project-1',
    projectBinding: { schemaVersion: 1, projectId: 'project-1', workspaceIds: ['workspace-1'], createdAt: brief.committedAt, updatedAt: brief.committedAt },
    workspaceBindings: { 'workspace-1': { schemaVersion: 1, workspaceId: 'workspace-1', bindingVersion: 1 } } as any,
    researchBrief: brief,
    artifacts: {}, runs: {}, sources: {}, evidence: {}, repositoryAudits: {}, reproductionPlans: {},
    reproductionTestSpecs: {}, reproductionReports: {}, geodataReports: {}, datasetManifests: {},
    experimentSpecs: {}, experimentAmendments: {}, results: {}, validationPlans: {}, validationReports: {},
    reviewRecords: {}, claims: {}, writingPackets: {}, manuscripts: {}, manuscriptAudits: {},
    activeTaskIds: [], blockers: [], staleIndicators: [],
  }
}

function hypothesisProposal(state: ProjectReducerState) {
  return {
    schemaVersion: 1, kind: 'claim', claimId: 'claim-hypothesis',
    statement: 'Spatial blocking prevents leakage.', claimType: 'hypothesis',
    supportRefs: [{ kind: 'hypothesis', recordId: 'hypothesis-1', digest: state.researchBrief!.digest }],
    calculation: null, limitations: [], intendedSections: ['methods'],
    validationReportIds: [], reviewRecordIds: [],
  }
}

function approvedHypothesis(state: ProjectReducerState, claimId: string): ClaimRecord {
  const body = {
    ...hypothesisProposal(state), claimId,
    projectId: 'project-1', workspaceId: 'workspace-1', workspaceBindingVersion: 1,
    calculation: null, supportState: 'proposed' as const, approvalState: 'approved' as const,
    integrity: 'verified' as const, validity: 'current' as const,
    approval: { requested: 'approved' as const, outcome: 'approved' as const, source: 'user' as const, callId: `call-${claimId}`, decidedAt: '2026-08-18T10:00:00.000Z' },
    committedAt: '2026-08-18T10:00:00.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

function requireCoordinator(agent: Agent): void {
  if (String(agent.id) !== 'coordinator') throw new Error('coordinator required')
}

function execution(): ToolExecution {
  return {
    agent: { id: 'coordinator', session: { id: 'session-coordinator' } } as unknown as Agent,
    rootCallId: 'root', callId: 'call-claim', signal: new AbortController().signal,
  } as unknown as ToolExecution
}

function fixedClock(): () => string {
  let tick = 0
  return () => new Date(Date.UTC(2026, 7, 18, 10, 0, tick++)).toISOString()
}
