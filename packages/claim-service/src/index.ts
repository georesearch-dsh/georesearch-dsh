import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@georesearch/dsh-installation-guard'
import type {} from '@georesearch/dsh-policy'
import type {} from '@georesearch/dsh-project-service'
import {
  operationIdentity,
  registerTool,
  requestUserApproval,
  type Agent,
  type ToolDefinition,
  type ToolExecution,
} from '@georesearch/dsh-compat-rc5'
import {
  CLAIM_PROPOSAL_SCHEMA,
  CLAIM_RECORD_SCHEMA,
  GeoResearchError,
  WRITING_PACKET_SCHEMA,
  digestJson,
  operationKeyFor,
  parseClaimProposal,
  requestDigestFor,
  type ClaimApprovalRecord,
  type ClaimProposal,
  type ClaimRecord,
  type JsonValue,
  type WritingPacket,
} from '@georesearch/dsh-contracts'
import {
  assessClaimSupport,
  claimEligibleForWriting,
  collectWritingInputs,
  type ClaimRecordCommitRequest,
  type GeoResearchProjectService,
  type WritingPacketCommitRequest,
} from '@georesearch/dsh-project-service'

declare module '@deepseek-ai/cordis' {
  interface Context {
    geoResearchClaims: GeoResearchClaimService
  }
}

export const name = 'georesearch-claim-service'
export const inject = [
  'geoResearchInstallation',
  'geoResearchPolicy',
  'geoResearchProjects',
  'approval',
  'tools',
]

export interface ClaimProjectPort {
  resolveAgent(agent: Agent): ReturnType<GeoResearchProjectService['resolveAgent']>
  loadProject(projectId: string): ReturnType<GeoResearchProjectService['loadProject']>
  commitClaimRecord(projectId: string, request: ClaimRecordCommitRequest): ReturnType<GeoResearchProjectService['commitClaimRecord']>
  commitWritingPacket(projectId: string, request: WritingPacketCommitRequest): ReturnType<GeoResearchProjectService['commitWritingPacket']>
}

export interface ClaimHostPort {
  requireCoordinator(agent: Agent): void
  isWorkflowAutonomous(agent: Agent): boolean
  requestApproval(execution: ToolExecution, reason: string): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>
}

export interface ClaimCoordinatorPorts {
  readonly projects: ClaimProjectPort
  readonly host: ClaimHostPort
}

export class ClaimCoordinator {
  private readonly clock: () => string

  constructor(
    private readonly ports: ClaimCoordinatorPorts,
    clock: () => string = () => new Date().toISOString(),
  ) {
    this.clock = clock
  }

  async commitClaim(
    execution: ToolExecution,
    expectedGeneration: number,
    value: unknown,
    requestedApproval: 'pending' | 'approved' | 'rejected',
  ): Promise<ClaimRecord> {
    const agent = exactAgent(execution, 'claim_commit')
    this.ports.host.requireCoordinator(agent)
    positive(expectedGeneration, 'expectedGeneration')
    const resolved = await this.ports.projects.resolveAgent(agent)
    const current = await this.ports.projects.loadProject(resolved.stateFile.projectId)
    if (current.generation !== expectedGeneration) {
      throw new GeoResearchError('PROJECT_GENERATION_CONFLICT', `expected generation ${expectedGeneration}, found ${current.generation}`)
    }
    const proposal = parseClaimProposal(value)
    const assessment = assessClaimSupport(current.state, proposal)
    if (requestedApproval === 'approved' && !supportMayBeApproved(proposal, assessment)) {
      throw new GeoResearchError('CLAIM_APPROVAL_REQUIRED', 'Claim does not satisfy the minimum support policy')
    }
    const decidedAt = this.clock()
    const approval = await this.approval(
      execution,
      agent,
      proposal,
      requestedApproval,
      assessment.supportState,
      decidedAt,
    )
    const approvalState = approval.outcome === 'approved'
      ? 'approved' as const
      : approval.outcome === 'rejected'
        ? 'rejected' as const
        : 'pending' as const
    const body = {
      ...proposal,
      projectId: current.projectId,
      workspaceId: resolved.binding.workspaceId,
      workspaceBindingVersion: resolved.binding.bindingVersion,
      calculation: assessment.calculation,
      supportState: approvalState === 'rejected' ? 'rejected' as const : assessment.supportState,
      approvalState,
      integrity: assessment.integrity,
      validity: assessment.validity,
      approval,
      committedAt: decidedAt,
    }
    const claim: ClaimRecord = { ...body, digest: digestJson(body) }
    const operation = 'claim_commit'
    await this.ports.projects.commitClaimRecord(current.projectId, {
      expectedGeneration,
      operationKey: operationKeyFor(operationIdentity(execution, current.projectId, operation)),
      requestDigest: requestDigestFor(operation, { proposal, requestedApproval } as unknown as JsonValue),
      claim,
    })
    return claim
  }

  async buildWritingPacket(
    execution: ToolExecution,
    expectedGeneration: number,
    packetId: string,
  ): Promise<WritingPacket> {
    const agent = exactAgent(execution, 'writing_packet_build')
    this.ports.host.requireCoordinator(agent)
    positive(expectedGeneration, 'expectedGeneration')
    const resolved = await this.ports.projects.resolveAgent(agent)
    const current = await this.ports.projects.loadProject(resolved.stateFile.projectId)
    if (current.generation !== expectedGeneration) {
      throw new GeoResearchError('PROJECT_GENERATION_CONFLICT', `expected generation ${expectedGeneration}, found ${current.generation}`)
    }
    const researchBrief = current.state.researchBrief
    if (researchBrief === undefined) throw new GeoResearchError('WRITING_PACKET_INVALID', 'current ResearchBrief is missing')
    const allClaims = Object.values(current.state.claims ?? {}).sort((left, right) => left.claimId.localeCompare(right.claimId))
    const claims = allClaims.filter(claim => claimEligibleForWriting(claim, current.state))
    const forbiddenClaimIds = allClaims.filter(claim => !claims.includes(claim)).map(claim => claim.claimId).sort()
    const closure = collectWritingInputs(current.state, claims)
    const builtAt = this.clock()
    const body = {
      schemaVersion: 1 as const,
      packetId,
      projectId: current.projectId,
      workspaceId: resolved.binding.workspaceId,
      workspaceBindingVersion: resolved.binding.bindingVersion,
      researchBrief,
      claims,
      ...closure,
      forbiddenClaimIds,
      builtAt,
    }
    const writingPacket: WritingPacket = { ...body, digest: digestJson(body) }
    const operation = 'writing_packet_build'
    await this.ports.projects.commitWritingPacket(current.projectId, {
      expectedGeneration,
      operationKey: operationKeyFor(operationIdentity(execution, current.projectId, operation)),
      requestDigest: requestDigestFor(operation, { packetId } as unknown as JsonValue),
      writingPacket,
    })
    return writingPacket
  }

  private async approval(
    execution: ToolExecution,
    agent: Agent,
    proposal: ClaimProposal,
    requested: 'pending' | 'approved' | 'rejected',
    supportState: string,
    decidedAt: string,
  ): Promise<ClaimApprovalRecord> {
    if (requested === 'pending') {
      return { requested, outcome: 'pending', source: 'coordinator', callId: String(execution.callId), decidedAt }
    }
    if (requested === 'rejected') {
      return { requested, outcome: 'rejected', source: 'coordinator', callId: String(execution.callId), decidedAt }
    }
    const outcome = this.ports.host.isWorkflowAutonomous(agent)
      ? 'allowed-once'
      : await this.ports.host.requestApproval(
        execution,
        `Approve GeoResearch Claim ${proposal.claimId} (${proposal.claimType}, support ${supportState}): ${proposal.statement}`,
      )
    return {
      requested,
      outcome: outcome === 'allowed-once' ? 'approved' : outcome,
      source: 'user',
      callId: String(execution.callId),
      decidedAt,
    }
  }
}

export class GeoResearchClaimService extends Service {
  readonly coordinator: ClaimCoordinator

  constructor(ctx: Context) {
    super(ctx, 'geoResearchClaims')
    this.coordinator = new ClaimCoordinator({
      projects: ctx.geoResearchProjects,
      host: new HarnessClaimHost(ctx),
    })
  }

  commitClaim(execution: ToolExecution, expectedGeneration: number, value: unknown, approval: 'pending' | 'approved' | 'rejected') {
    return this.coordinator.commitClaim(execution, expectedGeneration, value, approval)
  }

  buildWritingPacket(execution: ToolExecution, expectedGeneration: number, packetId: string) {
    return this.coordinator.buildWritingPacket(execution, expectedGeneration, packetId)
  }
}

class HarnessClaimHost implements ClaimHostPort {
  constructor(private readonly ctx: Context) {}

  requireCoordinator(agent: Agent): void {
    this.ctx.geoResearchInstallation.assertCurrent()
    const actor = this.ctx.geoResearchPolicy.actorFor(agent)
    if (actor !== 'coordinator') {
      throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', `coordinator operation is not authorized for ${actor ?? 'an unbound actor'}`)
    }
  }

  isWorkflowAutonomous(agent: Agent): boolean {
    return this.ctx.geoResearchPolicy.autonomyFor(agent).enabled
  }

  requestApproval(execution: ToolExecution, reason: string) {
    return requestUserApproval(
      this.ctx,
      exactAgent(execution, 'claim_commit'),
      'claim_commit',
      execution.callId,
      reason,
      execution.signal,
    )
  }
}

export function apply(ctx: Context): void {
  ctx.geoResearchInstallation.assertCurrent()
  new GeoResearchClaimService(ctx)
  for (const tool of claimTools(ctx)) registerTool(ctx, tool)
}

export function claimTools(ctx: Context): readonly ToolDefinition[] {
  return [
    {
      name: 'claim_commit',
      description: 'Host-assess a Claim proposal and record approval; session autonomy may satisfy user authorization, but support and integrity policy are always enforced.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          expectedGeneration: { type: 'integer', minimum: 1 },
          proposal: CLAIM_PROPOSAL_SCHEMA,
          requestedApproval: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
        },
        required: ['expectedGeneration', 'proposal', 'requestedApproval'],
      },
      output: { schema: CLAIM_RECORD_SCHEMA, render: renderJson },
      async execute(args, execution) {
        const record = exactArgs(args, ['expectedGeneration', 'proposal', 'requestedApproval'])
        return ctx.geoResearchClaims.commitClaim(
          execution,
          positive(record.expectedGeneration, 'expectedGeneration'),
          record.proposal,
          approvalState(record.requestedApproval),
        ) as unknown as Promise<JsonValue>
      },
    },
    {
      name: 'writing_packet_build',
      description: 'Build the complete isolated WritingPacket from every current, approved, verified Claim and its exact input closure.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          expectedGeneration: { type: 'integer', minimum: 1 },
          packetId: { type: 'string', minLength: 1 },
        },
        required: ['expectedGeneration', 'packetId'],
      },
      output: { schema: WRITING_PACKET_SCHEMA, render: renderJson },
      async execute(args, execution) {
        const record = exactArgs(args, ['expectedGeneration', 'packetId'])
        return ctx.geoResearchClaims.buildWritingPacket(
          execution,
          positive(record.expectedGeneration, 'expectedGeneration'),
          id(record.packetId, 'packetId'),
        ) as unknown as Promise<JsonValue>
      },
    },
  ]
}

function supportMayBeApproved(
  proposal: ClaimProposal,
  assessment: ReturnType<typeof assessClaimSupport>,
): boolean {
  if (assessment.integrity !== 'verified' || assessment.validity !== 'current') return false
  switch (proposal.claimType) {
    case 'literature-fact':
      return assessment.supportState === 'source-backed' || assessment.supportState === 'independently-checked'
    case 'experimental-observation':
      return assessment.supportState === 'experiment-supported' || assessment.supportState === 'independently-checked'
    case 'derived-calculation':
    case 'scientific-inference':
      return assessment.supportState === 'independently-checked'
    case 'hypothesis':
    case 'speculation':
      return assessment.supportState === 'proposed'
  }
}

function exactArgs(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('tool arguments must be an object')
  const record = value as Record<string, unknown>
  const unexpected = Object.keys(record).filter(key => !allowed.includes(key))
  if (unexpected.length > 0) throw new TypeError(`tool arguments contain unsupported fields: ${unexpected.join(', ')}`)
  return record
}

function exactAgent(execution: Pick<ToolExecution, 'agent'>, operation: string): Agent {
  if (execution.agent === undefined) throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', `${operation} requires an exact live Agent`)
  return execution.agent
}

function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive integer`)
  return value as number
}

function id(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u.test(value)) throw new TypeError(`${field} is invalid`)
  return value
}

function approvalState(value: unknown): 'pending' | 'approved' | 'rejected' {
  if (value !== 'pending' && value !== 'approved' && value !== 'rejected') throw new TypeError('requestedApproval is invalid')
  return value
}

function renderJson(_args: unknown, value: JsonValue) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}
