import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@georesearch/dsh-claim-service'
import type {} from '@georesearch/dsh-installation-guard'
import type {} from '@georesearch/dsh-policy'
import type {} from '@georesearch/dsh-project-service'
import type {} from '@georesearch/dsh-validation-service'
import type {} from '@georesearch/dsh-writing-service'
import { claimTools } from '@georesearch/dsh-claim-service'
import { registeredToolNames } from '@georesearch/dsh-compat-rc5'
import {
  CLAIM_PROPOSAL_SCHEMA,
  CLAIM_RECORD_SCHEMA,
  MANUSCRIPT_AUDIT_SCHEMA,
  MANUSCRIPT_CANDIDATE_SCHEMA,
  MANUSCRIPT_RECORD_SCHEMA,
  PHASE5_REQUIRED_TOOLS,
  PHASE6_REQUIRED_TOOLS,
  REVIEW_PROPOSAL_SCHEMA,
  REVIEW_RECORD_SCHEMA,
  VALIDATION_PLAN_SCHEMA,
  VALIDATION_REPORT_SCHEMA,
  WRITING_PACKET_SCHEMA,
  nowUtc,
  type GeoResearchActor,
} from '@georesearch/dsh-contracts'
import { validationTools } from '@georesearch/dsh-validation-service'
import { writingTools } from '@georesearch/dsh-writing-service'

export const name = 'georesearch-phase6-probe'
export const inject = [
  'geoResearchInstallation',
  'geoResearchPolicy',
  'geoResearchProjects',
  'geoResearchValidation',
  'geoResearchClaims',
  'geoResearchWriting',
  'tools',
]

const PHASE6_SCHEMAS = [
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
] as const

const TOOL_ACTORS = {
  geodata_validate: ['reviewer'],
  experiment_validate: ['reviewer'],
  citation_validate: ['reviewer'],
  review_subject_read: ['reviewer'],
  review_candidate: ['reviewer'],
  claim_commit: ['coordinator'],
  writing_packet_build: ['coordinator'],
  writing_packet_read: ['writing'],
  manuscript_candidate: ['writing'],
  manuscript_validate: ['writing'],
} as const satisfies Record<string, readonly GeoResearchActor[]>

export interface Config {
  readonly reportPath: string
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (typeof config.reportPath !== 'string' || config.reportPath.length === 0) {
    throw new TypeError('georesearch-phase6-probe: reportPath is required')
  }
  ctx.geoResearchInstallation.assertCurrent()
  if ((ctx.geoResearchPolicy.capabilityStage !== 'phase6'
    && ctx.geoResearchPolicy.capabilityStage !== 'full')
    || !ctx.geoResearchPolicy.strictCatalog) {
    throw new Error('georesearch-phase6-probe: policy is not in strict Phase 6 mode')
  }
  if (ctx.get('sessionTelemetry', false) !== undefined) {
    throw new Error('georesearch-phase6-probe: Session Telemetry is present')
  }

  const requiredTools = phase6HostToolNames()
  if (JSON.stringify(requiredTools) !== JSON.stringify(phase6ContractToolNames())) {
    throw new Error('georesearch-phase6-probe: local Phase 6 tool catalog differs from the contract')
  }
  const registered = new Set(registeredToolNames(ctx))
  const missing = requiredTools.filter(toolName => !registered.has(toolName))
  if (missing.length > 0) {
    throw new Error(`georesearch-phase6-probe: Phase 6 tools are missing: ${missing.join(', ')}`)
  }
  for (const [toolName, allowedActors] of Object.entries(TOOL_ACTORS)) {
    for (const actor of Object.keys(PHASE6_REQUIRED_TOOLS) as GeoResearchActor[]) {
      const present = new Set<string>(PHASE6_REQUIRED_TOOLS[actor]).has(toolName)
      if (present !== allowedActors.includes(actor as never)) {
        throw new Error(`georesearch-phase6-probe: ${toolName} role catalog is invalid for ${actor}`)
      }
    }
  }

  const claimCommit = claimTools(ctx).find(tool => tool.name === 'claim_commit')
  const claimProperties = (claimCommit?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
  if (claimProperties === undefined
    || JSON.stringify(Object.keys(claimProperties).sort())
      !== JSON.stringify(['expectedGeneration', 'proposal', 'requestedApproval'])
    || Object.hasOwn(claimProperties, 'supportState')
    || Object.hasOwn(claimProperties, 'approvalState')) {
    throw new Error('georesearch-phase6-probe: claim_commit accepts Host-owned states')
  }
  const packetBuild = claimTools(ctx).find(tool => tool.name === 'writing_packet_build')
  const packetProperties = (packetBuild?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
  if (packetProperties === undefined
    || JSON.stringify(Object.keys(packetProperties).sort()) !== JSON.stringify(['expectedGeneration', 'packetId'])
    || Object.hasOwn(packetProperties, 'claimIds')) {
    throw new Error('georesearch-phase6-probe: WritingPacket filtering is model-selectable')
  }

  assertServiceToolNames('Validation', validationTools(ctx), phase6AddedToolNames('reviewer'))
  assertServiceToolNames('Claim', claimTools(ctx), phase6AddedToolNames('coordinator'))
  assertServiceToolNames('Writing', writingTools(ctx), phase6AddedToolNames('writing'))
  for (const forbidden of ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'write', 'edit']) {
    if ((PHASE6_REQUIRED_TOOLS.writing as readonly string[]).includes(forbidden)) {
      throw new Error(`georesearch-phase6-probe: Writing role received forbidden tool ${forbidden}`)
    }
  }
  if (PHASE6_SCHEMAS.some(schema => schema.additionalProperties !== false)) {
    throw new Error('georesearch-phase6-probe: Phase 6 schemas are not strict')
  }
  for (const serviceName of [
    'geoResearchProjects',
    'geoResearchValidation',
    'geoResearchClaims',
    'geoResearchWriting',
  ]) {
    if (ctx.get(serviceName, false) === undefined) {
      throw new Error(`georesearch-phase6-probe: ctx.${serviceName} is unavailable`)
    }
  }

  const report = {
    schemaVersion: 1,
    phase: 'phase6-validation-claim-writing',
    checkedAt: nowUtc(),
    installation: {
      installationId: ctx.geoResearchInstallation.active.installationId,
      generation: ctx.geoResearchInstallation.active.generation,
      productVersion: ctx.geoResearchInstallation.active.productVersion,
    },
    policy: {
      capabilityStage: ctx.geoResearchPolicy.capabilityStage,
      strictCatalog: ctx.geoResearchPolicy.strictCatalog,
    },
    requiredTools,
    schemaCount: PHASE6_SCHEMAS.length,
    checks: {
      installationCurrent: true,
      strictPhase6Policy: true,
      projectAuthority: true,
      validationService: true,
      claimService: true,
      writingService: true,
      phase6Tools: true,
      exactRoleCatalogs: true,
      hostOwnedClaimStates: true,
      hostOwnedPacketFilter: true,
      writingPacketIsolation: true,
      reviewerDoesNotMutateSubjects: true,
      schemasFrozen: true,
      telemetryAbsent: true,
    },
  }
  await atomicWriteJson(resolve(config.reportPath), report)
}

export function phase6HostToolNames(): string[] {
  return Object.keys(TOOL_ACTORS).sort()
}

function phase6ContractToolNames(): string[] {
  const actors = Object.keys(PHASE6_REQUIRED_TOOLS) as GeoResearchActor[]
  return [...new Set(actors.flatMap(phase6AddedToolNames))].sort()
}

function phase6AddedToolNames(actor: GeoResearchActor): string[] {
  const previous = new Set<string>(PHASE5_REQUIRED_TOOLS[actor])
  return PHASE6_REQUIRED_TOOLS[actor].filter(toolName => !previous.has(toolName)).sort()
}

function assertServiceToolNames(
  label: string,
  definitions: readonly { readonly name: string }[],
  expected: readonly string[],
): void {
  const actual = definitions.map(definition => definition.name).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `georesearch-phase6-probe: ${label} service tools differ from the contract; `
      + `expected ${expected.join(', ')}, received ${actual.join(', ')}`,
    )
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  await rename(temporary, path)
}
