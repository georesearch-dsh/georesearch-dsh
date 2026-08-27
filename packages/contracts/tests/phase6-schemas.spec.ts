import { describe, expect, it } from 'vitest'
import {
  CLAIM_PROPOSAL_SCHEMA,
  CLAIM_RECORD_SCHEMA,
  MANUSCRIPT_AUDIT_SCHEMA,
  MANUSCRIPT_CANDIDATE_SCHEMA,
  MANUSCRIPT_RECORD_SCHEMA,
  REVIEW_PROPOSAL_SCHEMA,
  REVIEW_RECORD_SCHEMA,
  VALIDATION_PLAN_SCHEMA,
  VALIDATION_REPORT_SCHEMA,
  WRITING_PACKET_SCHEMA,
  deriveValidationOverall,
  digestJson,
  parseClaimProposal,
  parseValidationPlan,
  parseValidationReport,
  type ValidationPlan,
  type ValidationReport,
} from '../src/index.js'

describe('Phase 6 contracts', () => {
  it('keeps every public Phase 6 schema strict', () => {
    for (const schema of [
      VALIDATION_PLAN_SCHEMA,
      VALIDATION_REPORT_SCHEMA,
      REVIEW_PROPOSAL_SCHEMA,
      REVIEW_RECORD_SCHEMA,
      CLAIM_PROPOSAL_SCHEMA,
      CLAIM_RECORD_SCHEMA,
      WRITING_PACKET_SCHEMA,
      MANUSCRIPT_CANDIDATE_SCHEMA,
      MANUSCRIPT_RECORD_SCHEMA,
      MANUSCRIPT_AUDIT_SCHEMA,
    ]) expect(schema.additionalProperties).toBe(false)
  })

  it('blocks missing, mismatched, and zero validator execution', () => {
    const plan = validationPlan()
    expect(deriveValidationOverall(plan, [])).toBe('blocked')
    expect(deriveValidationOverall(plan, [{
      ...plan.validators[0]!,
      validatorId: 'wrong-validator',
      status: 'passed',
      findings: [],
    }])).toBe('blocked')
    expect(deriveValidationOverall(plan, [{
      ...plan.validators[0]!,
      status: 'error',
      findings: [],
    }])).toBe('blocked')
    expect(deriveValidationOverall(plan, [{
      ...plan.validators[0]!,
      status: 'failed',
      findings: [],
    }])).toBe('failed')
    expect(deriveValidationOverall(plan, [{
      ...plan.validators[0]!,
      status: 'passed',
      findings: [],
    }])).toBe('passed')
  })

  it('strictly parses authority records and rejects extra model-owned state', () => {
    const plan = validationPlan()
    const report = validationReport(plan)
    expect(parseValidationPlan(plan)).toEqual(plan)
    expect(parseValidationReport(report)).toEqual(report)
    expect(() => parseValidationReport({ ...report, ignored: true })).toThrow(/unsupported fields/)

    const proposal = {
      schemaVersion: 1,
      kind: 'claim',
      claimId: 'claim-hypothesis',
      statement: 'Spatial blocking reduces leakage.',
      claimType: 'hypothesis',
      supportRefs: [{
        kind: 'hypothesis',
        recordId: 'hypothesis-1',
        digest: digestJson({ brief: 1 }),
      }],
      calculation: null,
      limitations: [],
      intendedSections: ['methods'],
      validationReportIds: [],
      reviewRecordIds: [],
    }
    expect(parseClaimProposal(proposal)).toEqual(proposal)
    expect(() => parseClaimProposal({ ...proposal, approvalState: 'approved' })).toThrow(/unsupported fields/)
  })
})

function validationPlan(): ValidationPlan {
  const body = {
    schemaVersion: 1 as const,
    planId: 'plan-1',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    workspaceBindingVersion: 1,
    domain: 'experiment' as const,
    subjects: [{ kind: 'result' as const, subjectId: 'result-1', digest: digestJson({ result: 1 }) }],
    validators: [{
      validatorId: 'experiment.lineage',
      version: '1.0.0',
      mandatory: true,
      configDigest: digestJson({ config: 1 }),
    }],
    policyDigest: digestJson({ policy: 1 }),
    createdAt: '2026-08-18T10:00:00.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

function validationReport(plan: ValidationPlan): ValidationReport {
  const body = {
    schemaVersion: 1 as const,
    reportId: 'report-1',
    projectId: plan.projectId,
    workspaceId: plan.workspaceId,
    workspaceBindingVersion: plan.workspaceBindingVersion,
    planId: plan.planId,
    planDigest: plan.digest,
    subjects: plan.subjects,
    validatorResults: [{ ...plan.validators[0]!, status: 'passed' as const, findings: [] }],
    overall: 'passed' as const,
    completedAt: '2026-08-18T10:00:01.000Z',
  }
  return { ...body, digest: digestJson(body) }
}
