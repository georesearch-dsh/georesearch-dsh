import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@georesearch/dsh-installation-guard'
import type {} from '@georesearch/dsh-policy'
import type {} from '@georesearch/dsh-project-service'
import {
  operationIdentity,
  registerTool,
  type Agent,
  type ToolDefinition,
  type ToolExecution,
} from '@georesearch/dsh-compat-rc5'
import {
  GeoResearchError,
  MANUSCRIPT_AUDIT_SCHEMA,
  MANUSCRIPT_CANDIDATE_SCHEMA,
  MANUSCRIPT_RECORD_SCHEMA,
  WRITING_PACKET_SCHEMA,
  digestJson,
  operationKeyFor,
  parseManuscriptCandidate,
  requestDigestFor,
  type ClaimRecord,
  type JsonValue,
  type ManuscriptAudit,
  type ManuscriptBlock,
  type ManuscriptCandidate,
  type ManuscriptRecord,
  type ManuscriptSectionId,
  type ProjectReducerState,
  type ValidationFinding,
  type WritingPacket,
} from '@georesearch/dsh-contracts'
import {
  claimEligibleForWriting,
  collectWritingInputs,
  type GeoResearchProjectService,
  type ManuscriptCommitRequest,
} from '@georesearch/dsh-project-service'

declare module '@deepseek-ai/cordis' {
  interface Context {
    geoResearchWriting: GeoResearchWritingService
  }
}

export const name = 'georesearch-writing-service'
export const inject = [
  'geoResearchInstallation',
  'geoResearchPolicy',
  'geoResearchProjects',
  'tools',
]

export interface WritingProjectPort {
  resolveAgent(agent: Agent): ReturnType<GeoResearchProjectService['resolveAgent']>
  loadProject(projectId: string): ReturnType<GeoResearchProjectService['loadProject']>
  commitManuscript(projectId: string, request: ManuscriptCommitRequest): ReturnType<GeoResearchProjectService['commitManuscript']>
}

export interface WritingHostPort {
  requireWriting(agent: Agent): void
}

export interface WritingCoordinatorPorts {
  readonly projects: WritingProjectPort
  readonly host: WritingHostPort
}

export interface ManuscriptValidationOutcome {
  readonly manuscript: ManuscriptRecord
  readonly audit: ManuscriptAudit
}

export class WritingCoordinator {
  private readonly clock: () => string

  constructor(
    private readonly ports: WritingCoordinatorPorts,
    clock: () => string = () => new Date().toISOString(),
  ) {
    this.clock = clock
  }

  async readPacket(agent: Agent, packetId: string): Promise<WritingPacket> {
    this.ports.host.requireWriting(agent)
    const resolved = await this.ports.projects.resolveAgent(agent)
    const current = await this.ports.projects.loadProject(resolved.stateFile.projectId)
    const packet = current.state.writingPackets?.[packetId]
    if (packet === undefined) throw new GeoResearchError('WRITING_PACKET_NOT_FOUND', `WritingPacket ${packetId} is unknown`)
    if (!writingPacketCurrent(current.state, packet)) {
      throw new GeoResearchError('WRITING_PACKET_INVALID', `WritingPacket ${packetId} is stale`)
    }
    return packet
  }

  async candidate(execution: ToolExecution, value: unknown): Promise<ManuscriptCandidate> {
    const agent = exactAgent(execution, 'manuscript_candidate')
    const candidate = parseManuscriptCandidate(value)
    const packet = await this.readPacket(agent, candidate.packetId)
    if (candidate.packetDigest !== packet.digest) {
      throw new GeoResearchError('MANUSCRIPT_INVALID', 'ManuscriptCandidate packet digest is stale')
    }
    return candidate
  }

  async validate(
    execution: ToolExecution,
    expectedGeneration: number,
    value: unknown,
  ): Promise<ManuscriptValidationOutcome> {
    const agent = exactAgent(execution, 'manuscript_validate')
    this.ports.host.requireWriting(agent)
    positive(expectedGeneration, 'expectedGeneration')
    const candidate = parseManuscriptCandidate(value)
    const resolved = await this.ports.projects.resolveAgent(agent)
    const current = await this.ports.projects.loadProject(resolved.stateFile.projectId)
    if (current.generation !== expectedGeneration) {
      throw new GeoResearchError('PROJECT_GENERATION_CONFLICT', `expected generation ${expectedGeneration}, found ${current.generation}`)
    }
    const packet = current.state.writingPackets?.[candidate.packetId]
    if (packet === undefined || packet.digest !== candidate.packetDigest) {
      throw new GeoResearchError('WRITING_PACKET_NOT_FOUND', 'ManuscriptCandidate WritingPacket is unavailable')
    }
    const audit = auditManuscript(current.state, packet, candidate, this.clock())
    const createdAt = this.clock()
    const manuscriptBody = {
      ...candidate,
      projectId: current.projectId,
      workspaceId: resolved.binding.workspaceId,
      workspaceBindingVersion: resolved.binding.bindingVersion,
      auditId: audit.auditId,
      status: audit.overall === 'passed' ? 'validated' as const : 'blocked' as const,
      createdAt,
    }
    const manuscript: ManuscriptRecord = { ...manuscriptBody, digest: digestJson(manuscriptBody) }
    const operation = 'manuscript_validate'
    await this.ports.projects.commitManuscript(current.projectId, {
      expectedGeneration,
      operationKey: operationKeyFor(operationIdentity(execution, current.projectId, operation)),
      requestDigest: requestDigestFor(operation, candidate as unknown as JsonValue),
      manuscript,
      manuscriptAudit: audit,
    })
    return { manuscript, audit }
  }
}

export class GeoResearchWritingService extends Service {
  readonly coordinator: WritingCoordinator

  constructor(ctx: Context) {
    super(ctx, 'geoResearchWriting')
    this.coordinator = new WritingCoordinator({
      projects: ctx.geoResearchProjects,
      host: new HarnessWritingHost(ctx),
    })
  }

  readPacket(agent: Agent, packetId: string) {
    return this.coordinator.readPacket(agent, packetId)
  }

  candidate(execution: ToolExecution, value: unknown) {
    return this.coordinator.candidate(execution, value)
  }

  validate(execution: ToolExecution, expectedGeneration: number, value: unknown) {
    return this.coordinator.validate(execution, expectedGeneration, value)
  }
}

class HarnessWritingHost implements WritingHostPort {
  constructor(private readonly ctx: Context) {}

  requireWriting(agent: Agent): void {
    this.ctx.geoResearchInstallation.assertCurrent()
    const actor = this.ctx.geoResearchPolicy.actorFor(agent)
    if (actor !== 'writing') {
      throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', `writing operation is not authorized for ${actor ?? 'an unbound actor'}`)
    }
  }
}

export function apply(ctx: Context): void {
  ctx.geoResearchInstallation.assertCurrent()
  new GeoResearchWritingService(ctx)
  for (const tool of writingTools(ctx)) registerTool(ctx, tool)
}

export function writingTools(ctx: Context): readonly ToolDefinition[] {
  return [
    {
      name: 'writing_packet_read',
      description: 'Read one current isolated WritingPacket; no Project directory or unapproved state is exposed.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { packetId: { type: 'string', minLength: 1 } },
        required: ['packetId'],
      },
      output: { schema: WRITING_PACKET_SCHEMA, render: renderJson },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        const record = exactArgs(args, ['packetId'])
        return ctx.geoResearchWriting.readPacket(
          exactAgent(execution, 'writing_packet_read'),
          id(record.packetId, 'packetId'),
        ) as unknown as Promise<JsonValue>
      },
    },
    {
      name: 'manuscript_candidate',
      description: 'Strictly parse a WritingPacket-bound ManuscriptCandidate before deterministic audit.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { candidate: MANUSCRIPT_CANDIDATE_SCHEMA },
        required: ['candidate'],
      },
      output: { schema: MANUSCRIPT_CANDIDATE_SCHEMA, render: renderJson },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        const record = exactArgs(args, ['candidate'])
        return ctx.geoResearchWriting.candidate(execution, record.candidate) as unknown as Promise<JsonValue>
      },
    },
    {
      name: 'manuscript_validate',
      description: 'Audit every Claim, citation, section, and numeric token, then preserve both passed and failed manuscript outcomes.',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          expectedGeneration: { type: 'integer', minimum: 1 },
          candidate: MANUSCRIPT_CANDIDATE_SCHEMA,
        },
        required: ['expectedGeneration', 'candidate'],
      },
      output: {
        schema: {
          type: 'object', additionalProperties: false,
          properties: { manuscript: MANUSCRIPT_RECORD_SCHEMA, audit: MANUSCRIPT_AUDIT_SCHEMA },
          required: ['manuscript', 'audit'],
        },
        render: renderJson,
      },
      async execute(args, execution) {
        const record = exactArgs(args, ['expectedGeneration', 'candidate'])
        return ctx.geoResearchWriting.validate(
          execution,
          positive(record.expectedGeneration, 'expectedGeneration'),
          record.candidate,
        ) as unknown as Promise<JsonValue>
      },
    },
  ]
}

export function writingPacketCurrent(state: ProjectReducerState, packet: WritingPacket): boolean {
  const binding = state.workspaceBindings[packet.workspaceId]
  if (binding?.bindingVersion !== packet.workspaceBindingVersion
    || state.researchBrief?.digest !== packet.researchBrief.digest) return false
  const allClaims = Object.values(state.claims ?? {}).sort((left, right) => left.claimId.localeCompare(right.claimId))
  const eligible = allClaims.filter(claim => claimEligibleForWriting(claim, state))
  const forbidden = allClaims.filter(claim => !eligible.includes(claim)).map(claim => claim.claimId).sort()
  if (JSON.stringify(packet.claims.map(claim => claim.digest)) !== JSON.stringify(eligible.map(claim => claim.digest))
    || JSON.stringify(packet.forbiddenClaimIds) !== JSON.stringify(forbidden)) return false
  const closure = collectWritingInputs(state, eligible)
  return sameDigests(packet.sources, closure.sources)
    && sameDigests(packet.evidence, closure.evidence)
    && sameDigests(packet.experimentSpecs, closure.experimentSpecs)
    && JSON.stringify(packet.runs.map(digestJson)) === JSON.stringify(closure.runs.map(digestJson))
    && sameDigests(packet.results, closure.results)
    && sameDigests(packet.validationReports, closure.validationReports)
    && JSON.stringify(packet.artifactRefs) === JSON.stringify(closure.artifactRefs)
    && JSON.stringify(packet.limitations) === JSON.stringify(closure.limitations)
}

export function auditManuscript(
  state: ProjectReducerState,
  packet: WritingPacket,
  candidate: ManuscriptCandidate,
  auditedAt: string,
): ManuscriptAudit {
  const findings: ValidationFinding[] = []
  const packetCurrent = writingPacketCurrent(state, packet)
  const claims = new Map(packet.claims.map(claim => [claim.claimId, claim]))
  const evidence = new Set(packet.evidence.map(record => record.evidenceId))
  const results = new Map(packet.results.map(record => [record.resultId, record]))
  let claimsEligible = true
  let forbiddenClaimsAbsent = true
  let numbersTraceable = true
  let literatureTraceable = true
  let sectionsAllowed = true

  for (const section of candidate.sections) {
    for (const block of section.blocks) {
      const blockClaims = block.claimIds.map(claimId => claims.get(claimId))
      if (blockClaims.some(claim => claim === undefined || !claimEligibleForWriting(claim, state))) {
        claimsEligible = false
        findings.push(auditFinding('MANUSCRIPT_CLAIM_INELIGIBLE', `Block ${block.blockId} references an ineligible Claim.`, block, 'hard'))
      }
      if (block.claimIds.some(claimId => packet.forbiddenClaimIds.includes(claimId))) {
        forbiddenClaimsAbsent = false
        findings.push(auditFinding('MANUSCRIPT_FORBIDDEN_CLAIM', `Block ${block.blockId} references a forbidden Claim.`, block, 'hard'))
      }
      if (!blockClaims.every(claim => claim === undefined || sectionAllowed(claim, section.sectionId))) {
        sectionsAllowed = false
        findings.push(auditFinding('MANUSCRIPT_SECTION_INVALID', `Block ${block.blockId} uses a Claim outside its approved section.`, block, 'hard'))
      }
      if (!literatureBlockTraceable(block, blockClaims, evidence)) {
        literatureTraceable = false
        findings.push(auditFinding('MANUSCRIPT_CITATION_UNTRACED', `Block ${block.blockId} has an untraceable literature statement.`, block, 'hard'))
      }
      if (!numericBlockTraceable(block, blockClaims, results)) {
        numbersTraceable = false
        findings.push(auditFinding('MANUSCRIPT_NUMBER_UNTRACED', `Block ${block.blockId} has a numeric token that does not trace to a ResultRecord.`, block, 'hard'))
      }
    }
  }
  if (!packetCurrent) {
    findings.push({
      findingId: `finding-${digestJson({ code: 'WRITING_PACKET_STALE', packetId: packet.packetId }).slice(7, 31)}`,
      validatorId: 'manuscript.packet-current',
      severity: 'hard',
      code: 'WRITING_PACKET_STALE',
      message: 'The WritingPacket is no longer the complete current approved Claim closure.',
      subjectIds: [candidate.manuscriptId],
    })
  }
  const checks = {
    packetCurrent,
    claimsEligible,
    forbiddenClaimsAbsent,
    numbersTraceable,
    literatureTraceable,
    sectionsAllowed,
  }
  const overall = !packetCurrent ? 'blocked' as const
    : Object.values(checks).every(Boolean) ? 'passed' as const : 'failed' as const
  const auditBody = {
    schemaVersion: 1 as const,
    auditId: `manuscript-audit-${digestJson({ manuscriptId: candidate.manuscriptId, packetDigest: packet.digest }).slice(7, 31)}`,
    projectId: state.projectId,
    manuscriptId: candidate.manuscriptId,
    packetId: packet.packetId,
    packetDigest: packet.digest,
    checks,
    findings,
    overall,
    auditedAt,
  }
  return { ...auditBody, digest: digestJson(auditBody) }
}

function literatureBlockTraceable(
  block: ManuscriptBlock,
  claims: readonly (ClaimRecord | undefined)[],
  evidence: ReadonlySet<string>,
): boolean {
  if (block.evidenceIds.some(evidenceId => !evidence.has(evidenceId))) return false
  const literatureClaims = claims.filter((claim): claim is ClaimRecord => claim?.claimType === 'literature-fact')
  if (literatureClaims.length === 0) return block.evidenceIds.length === 0
  const supportedEvidence = new Set(literatureClaims.flatMap(claim => (
    claim.supportRefs.filter(reference => reference.kind === 'evidence').map(reference => reference.recordId)
  )))
  return block.evidenceIds.length > 0 && block.evidenceIds.every(evidenceId => supportedEvidence.has(evidenceId))
}

function numericBlockTraceable(
  block: ManuscriptBlock,
  claims: readonly (ClaimRecord | undefined)[],
  results: ReadonlyMap<string, WritingPacket['results'][number]>,
): boolean {
  const tokens = numericTokens(block.text).sort()
  const refs = block.numericRefs.map(reference => reference.literal).sort()
  if (JSON.stringify(tokens) !== JSON.stringify(refs)) return false
  const claimById = new Map(claims.filter((claim): claim is ClaimRecord => claim !== undefined).map(claim => [claim.claimId, claim]))
  return block.numericRefs.every(reference => {
    const claim = claimById.get(reference.claimId)
    const result = results.get(reference.resultId)
    if (claim === undefined || result === undefined
      || !block.claimIds.includes(reference.claimId)
      || !block.resultIds.includes(reference.resultId)) return false
    const supportsResult = claim.supportRefs.some(support => support.kind === 'result' && support.recordId === result.resultId)
      || claim.calculation?.operandResultIds.includes(result.resultId) === true
    const expected = claim.calculation?.value ?? result.value
    return supportsResult && numericEqual(reference.literal, expected)
  })
}

function numericTokens(text: string): string[] {
  return [...text.matchAll(/(?<![A-Za-z0-9_])[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?%?(?![A-Za-z0-9_])/gu)]
    .map(match => match[0])
}

function numericEqual(literal: string, expected: number): boolean {
  const percent = literal.endsWith('%')
  const parsed = Number(percent ? literal.slice(0, -1) : literal)
  if (!Number.isFinite(parsed)) return false
  const normalizedExpected = percent ? expected * 100 : expected
  return Math.abs(parsed - normalizedExpected) <= Math.max(1e-12, Math.abs(normalizedExpected) * 1e-9)
}

function sectionAllowed(claim: ClaimRecord, section: ManuscriptSectionId): boolean {
  if (!claim.intendedSections.includes(section)) return false
  if (section === 'conclusion' && claim.supportState !== 'independently-checked') return false
  return true
}

function auditFinding(
  code: string,
  message: string,
  block: ManuscriptBlock,
  severity: ValidationFinding['severity'],
): ValidationFinding {
  return {
    findingId: `finding-${digestJson({ code, blockId: block.blockId }).slice(7, 31)}`,
    validatorId: 'manuscript.traceability',
    severity,
    code,
    message,
    subjectIds: [block.blockId],
  }
}

function sameDigests<T extends { readonly digest: string }>(actual: readonly T[], expected: readonly T[]): boolean {
  return JSON.stringify(actual.map(record => record.digest)) === JSON.stringify(expected.map(record => record.digest))
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

function renderJson(_args: unknown, value: JsonValue) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}
