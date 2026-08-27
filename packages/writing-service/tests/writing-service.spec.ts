import { describe, expect, it } from 'vitest'
import { digestJson, type ClaimRecord, type ProjectReducerState, type WritingPacket } from '@georesearch/dsh-contracts'
import { auditManuscript, writingPacketCurrent } from '../src/index.js'

describe('manuscript audit', () => {
  it('accepts a packet-isolated, Claim-traced manuscript without unsupported numbers', () => {
    const { state, packet, claim } = fixture()
    expect(writingPacketCurrent(state, packet)).toBe(true)
    const candidate = {
      schemaVersion: 1 as const, kind: 'manuscript' as const, manuscriptId: 'manuscript-1',
      packetId: packet.packetId, packetDigest: packet.digest, title: 'Leakage-safe evaluation',
      sections: [{
        sectionId: 'methods' as const, title: 'Methods',
        blocks: [{
          blockId: 'methods-1', text: 'We use spatial blocking to prevent leakage.',
          claimIds: [claim.claimId], evidenceIds: [], resultIds: [], numericRefs: [],
        }],
      }],
    }
    const audit = auditManuscript(state, packet, candidate, '2026-08-18T11:00:00.000Z')
    expect(audit.overall).toBe('passed')
    expect(Object.values(audit.checks).every(Boolean)).toBe(true)
  })

  it('fails any manuscript number that lacks a ResultRecord trace', () => {
    const { state, packet, claim } = fixture()
    const candidate = {
      schemaVersion: 1 as const, kind: 'manuscript' as const, manuscriptId: 'manuscript-number',
      packetId: packet.packetId, packetDigest: packet.digest, title: 'Unsupported number',
      sections: [{
        sectionId: 'methods' as const, title: 'Methods',
        blocks: [{
          blockId: 'methods-number', text: 'The unregistered score was 0.8.',
          claimIds: [claim.claimId], evidenceIds: [], resultIds: [], numericRefs: [],
        }],
      }],
    }
    const audit = auditManuscript(state, packet, candidate, '2026-08-18T11:00:00.000Z')
    expect(audit.overall).toBe('failed')
    expect(audit.checks.numbersTraceable).toBe(false)
    expect(audit.findings.some(finding => finding.code === 'MANUSCRIPT_NUMBER_UNTRACED')).toBe(true)
  })
})

function fixture(): { state: ProjectReducerState; packet: WritingPacket; claim: ClaimRecord } {
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
  const claimBody = {
    schemaVersion: 1 as const, kind: 'claim' as const, claimId: 'claim-method',
    statement: 'Spatial blocking prevents leakage.', claimType: 'hypothesis' as const,
    supportRefs: [{ kind: 'hypothesis' as const, recordId: 'hypothesis-1', digest: brief.digest }],
    calculation: null, limitations: [], intendedSections: ['methods' as const], validationReportIds: [], reviewRecordIds: [],
    projectId: 'project-1', workspaceId: 'workspace-1', workspaceBindingVersion: 1,
    supportState: 'proposed' as const, approvalState: 'approved' as const,
    integrity: 'verified' as const, validity: 'current' as const,
    approval: { requested: 'approved' as const, outcome: 'approved' as const, source: 'user' as const, callId: 'call-1', decidedAt: '2026-08-18T10:00:00.000Z' },
    committedAt: '2026-08-18T10:00:00.000Z',
  }
  const claim = { ...claimBody, digest: digestJson(claimBody) }
  const state: ProjectReducerState = {
    schemaVersion: 1, projectId: 'project-1',
    projectBinding: { schemaVersion: 1, projectId: 'project-1', workspaceIds: ['workspace-1'], createdAt: brief.committedAt, updatedAt: brief.committedAt },
    workspaceBindings: { 'workspace-1': { schemaVersion: 1, workspaceId: 'workspace-1', bindingVersion: 1 } } as any,
    researchBrief: brief, artifacts: {}, runs: {}, sources: {}, evidence: {}, repositoryAudits: {},
    reproductionPlans: {}, reproductionTestSpecs: {}, reproductionReports: {}, geodataReports: {},
    datasetManifests: {}, experimentSpecs: {}, experimentAmendments: {}, results: {},
    validationPlans: {}, validationReports: {}, reviewRecords: {}, claims: { [claim.claimId]: claim },
    writingPackets: {}, manuscripts: {}, manuscriptAudits: {}, activeTaskIds: [], blockers: [], staleIndicators: [],
  }
  const packetBody = {
    schemaVersion: 1 as const, packetId: 'packet-1', projectId: 'project-1', workspaceId: 'workspace-1',
    workspaceBindingVersion: 1, researchBrief: brief, claims: [claim], sources: [], evidence: [],
    experimentSpecs: [], runs: [], results: [], validationReports: [], artifactRefs: [], limitations: [],
    forbiddenClaimIds: [], builtAt: '2026-08-18T10:30:00.000Z',
  }
  const packet = { ...packetBody, digest: digestJson(packetBody) }
  state.writingPackets = { [packet.packetId]: packet }
  return { state, packet, claim }
}
