import { describe, expect, it } from 'vitest'
import { DELEGATION_BOOTSTRAP_TOOL } from '@georesearch/dsh-contracts'
import {
  ManagedDelegationBootstrap,
  actorFromIdentity,
  guardAndConsumeSpecialistToolBudget,
  guardActorTool,
  guardCoordinatorSkillProtocol,
  guardSpecialistSkillProtocol,
  preStepDecisionFromIdentity,
} from '../src/index.js'

const outside = {
  durablePreset: undefined,
  livePreset: undefined,
  origin: undefined,
  role: undefined,
  managedChild: false,
} as const

describe('GeoResearch policy identity', () => {
  it('classifies only valid root and managed delegated identities', () => {
    expect(actorFromIdentity({ ...outside, livePreset: 'georesearch' })).toBe('coordinator')
    expect(actorFromIdentity({
      ...outside,
      livePreset: 'georesearch',
      origin: 'subagent',
      role: 'reviewer',
      managedChild: true,
    })).toBe('reviewer')
    expect(actorFromIdentity({
      ...outside,
      livePreset: 'georesearch',
      origin: 'subagent',
      role: 'reviewer',
    })).toBeUndefined()
  })

  it('rejects durable GeoResearch sessions that lost their live composition', () => {
    expect(preStepDecisionFromIdentity(outside)).toBeUndefined()
    expect(preStepDecisionFromIdentity({
      ...outside,
      durablePreset: 'georesearch',
    })).toEqual({ kind: 'reject' })
    expect(preStepDecisionFromIdentity({
      ...outside,
      durablePreset: 'georesearch',
      livePreset: 'georesearch',
    })).toBeUndefined()
  })

  it('keeps actor tool authority monotonic', () => {
    expect(guardActorTool('coordinator', 'delegate_review')).toBeUndefined()
    expect(guardActorTool('coordinator', 'deliverable_publish')).toBeUndefined()
    expect(guardActorTool('coordinator', 'write')).toContain('GEORESEARCH_TOOL_FORBIDDEN')
    expect(guardActorTool('coordinator', 'edit')).toContain('GEORESEARCH_TOOL_FORBIDDEN')
    expect(guardActorTool('coordinator', 'web_search')).toContain('GEORESEARCH_TOOL_FORBIDDEN')
    expect(guardActorTool('coordinator', 'web_fetch')).toContain('GEORESEARCH_TOOL_FORBIDDEN')
    expect(guardActorTool('coordinator', 'pwsh')).toContain('GEORESEARCH_TOOL_FORBIDDEN')
    expect(guardActorTool('literature', 'web_search')).toBeUndefined()
    expect(guardActorTool('literature', 'deliverable_publish')).toContain('GEORESEARCH_TOOL_FORBIDDEN')
    expect(guardActorTool('literature', 'formal_run_submit')).toContain('GEORESEARCH_TOOL_FORBIDDEN')
  })

  it('requires the Coordinator to load only the routing Skill before acting', () => {
    expect(guardCoordinatorSkillProtocol(false, 'delegate_review', {}))
      .toContain('GEORESEARCH_SPECIALIST_SKILL_REQUIRED')
    expect(guardCoordinatorSkillProtocol(false, 'skill', { name: 'georesearch' })).toBeUndefined()
    expect(guardCoordinatorSkillProtocol(false, 'skill', { name: 'literature-review' }))
      .toContain('GEORESEARCH_SPECIALIST_SKILL_FORBIDDEN')
    expect(guardCoordinatorSkillProtocol(true, 'delegate_review', {})).toBeUndefined()
  })

  it('requires Host-observed core Skill loads before specialist work', () => {
    const required = ['literature-review'] as const
    expect(guardSpecialistSkillProtocol(
      'literature',
      false,
      required,
      new Set(),
      'web_search',
      { query: 'SWOT tsunami' },
    )).toContain('GEORESEARCH_DELEGATION_BOOTSTRAP_REQUIRED')
    expect(guardSpecialistSkillProtocol(
      'literature',
      false,
      required,
      new Set(),
      DELEGATION_BOOTSTRAP_TOOL,
      {},
    )).toBeUndefined()
    expect(guardSpecialistSkillProtocol(
      'literature',
      false,
      required,
      new Set(),
      'skill',
      { name: 'literature-review' },
    )).toContain('GEORESEARCH_DELEGATION_BOOTSTRAP_REQUIRED')
    expect(guardSpecialistSkillProtocol(
      'literature',
      true,
      required,
      new Set(),
      DELEGATION_BOOTSTRAP_TOOL,
      {},
    )).toContain('GEORESEARCH_DELEGATION_BOOTSTRAP_ALREADY_DELIVERED')
    expect(guardSpecialistSkillProtocol(
      'literature',
      true,
      required,
      new Set(),
      'skill',
      { name: 'literature-review' },
    )).toBeUndefined()
    expect(guardSpecialistSkillProtocol(
      'literature',
      true,
      required,
      new Set(),
      'web_search',
      { query: 'SWOT tsunami' },
    )).toContain('GEORESEARCH_SPECIALIST_SKILL_REQUIRED')
    expect(guardSpecialistSkillProtocol(
      'literature',
      true,
      required,
      new Set(['literature-review']),
      'web_search',
      { query: 'SWOT tsunami' },
    )).toBeUndefined()
    expect(guardSpecialistSkillProtocol(
      'writing',
      true,
      ['manuscript-writing'],
      new Set(),
      'skill',
      { name: 'literature-review' },
    )).toContain('GEORESEARCH_SPECIALIST_SKILL_FORBIDDEN')
  })

  it('enforces the managed literature discovery tool budget across combined provider calls', () => {
    const budget = { literatureProviderCalls: 0, webSearchCalls: 0, sourceResolveCalls: 0 }
    expect(guardAndConsumeSpecialistToolBudget('literature', 'discovery', budget, 'literature_search')).toBeUndefined()
    expect(guardAndConsumeSpecialistToolBudget('literature', 'discovery', budget, 'literature_continue')).toBeUndefined()
    expect(guardAndConsumeSpecialistToolBudget('literature', 'discovery', budget, 'literature_search'))
      .toContain('combined literature_search + literature_continue budget of 2')

    expect(guardAndConsumeSpecialistToolBudget('literature', 'discovery', budget, 'web_search')).toBeUndefined()
    expect(guardAndConsumeSpecialistToolBudget('literature', 'discovery', budget, 'web_search'))
      .toContain('web_search budget of 1')

    for (let index = 0; index < 4; index += 1) {
      expect(guardAndConsumeSpecialistToolBudget('literature', 'discovery', budget, 'source_resolve')).toBeUndefined()
    }
    expect(guardAndConsumeSpecialistToolBudget('literature', 'discovery', budget, 'source_resolve'))
      .toContain('source_resolve budget of 4')
    expect(guardAndConsumeSpecialistToolBudget('literature', 'evidence-synthesis', budget, 'web_search')).toBeUndefined()
  })

  it('delivers the exact Host-held bootstrap payload once', () => {
    const payload = {
      schemaVersion: 1,
      role: 'literature',
      taskType: 'evidence-synthesis',
      requiredSkills: ['literature-review'],
      completionCriteria: ['Synthesize supported and contested findings.'],
      allowedOutputKinds: ['evidence-synthesis'],
      authority: {
        projectId: 'project-1',
        generation: 7,
        workspaceId: 'workspace-1',
        workspaceBindingVersion: 2,
        subjectRefs: [],
        artifactRefs: [],
      },
      researchQuestion: 'What is established?',
      constraints: ['Use primary literature.'],
      task: 'Synthesize the bounded evidence set.',
    } as const
    const bootstrap = new ManagedDelegationBootstrap(payload)

    expect(bootstrap.isDelivered).toBe(false)
    expect(bootstrap.deliver()).toEqual(payload)
    expect(bootstrap.isDelivered).toBe(true)
    expect(() => bootstrap.deliver()).toThrow(/GEORESEARCH_DELEGATION_BOOTSTRAP_ALREADY_DELIVERED/)
  })
})
