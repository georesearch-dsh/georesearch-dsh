import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@georesearch/dsh-evidence-service'
import type {} from '@georesearch/dsh-installation-guard'
import type {} from '@georesearch/dsh-policy'
import { registeredToolNames } from '@georesearch/dsh-compat-rc5'
import {
  CONTINUATION_ADVANCE_OUTCOME_SCHEMA,
  EVIDENCE_CANDIDATE_SCHEMA,
  EVIDENCE_RECORD_SCHEMA,
  LITERATURE_CONTINUATION_RECORD_SCHEMA,
  LITERATURE_SEARCH_REQUEST_SCHEMA,
  LITERATURE_SEARCH_RESULT_SCHEMA,
  PAPER_READ_RESULT_SCHEMA,
  PHASE3_LITERATURE_TOOLS,
  PHASE3_REQUIRED_TOOLS,
  SOURCE_RECORD_SCHEMA,
  isSha256Digest,
  nowUtc,
  type GeoResearchActor,
} from '@georesearch/dsh-contracts'

export const name = 'georesearch-phase3-probe'
export const inject = [
  'geoResearchInstallation',
  'geoResearchPolicy',
  'geoResearchProjects',
  'geoResearchFiles',
  'geoResearchEvidence',
  'tools',
]

const NON_LITERATURE_ACTORS: readonly GeoResearchActor[] = [
  'coordinator', 'experiment', 'reviewer', 'writing',
]

const PHASE3_SCHEMAS = [
  LITERATURE_SEARCH_REQUEST_SCHEMA,
  LITERATURE_SEARCH_RESULT_SCHEMA,
  LITERATURE_CONTINUATION_RECORD_SCHEMA,
  CONTINUATION_ADVANCE_OUTCOME_SCHEMA,
  PAPER_READ_RESULT_SCHEMA,
  SOURCE_RECORD_SCHEMA,
  EVIDENCE_CANDIDATE_SCHEMA,
  EVIDENCE_RECORD_SCHEMA,
] as const

export interface Config {
  readonly reportPath: string
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (typeof config.reportPath !== 'string' || config.reportPath.length === 0) {
    throw new TypeError('georesearch-phase3-probe: reportPath is required')
  }
  ctx.geoResearchInstallation.assertCurrent()
  if ((ctx.geoResearchPolicy.capabilityStage !== 'phase3'
    && ctx.geoResearchPolicy.capabilityStage !== 'phase4'
    && ctx.geoResearchPolicy.capabilityStage !== 'phase5'
    && ctx.geoResearchPolicy.capabilityStage !== 'phase6'
    && ctx.geoResearchPolicy.capabilityStage !== 'full')
    || !ctx.geoResearchPolicy.strictCatalog) {
    throw new Error('georesearch-phase3-probe: policy does not preserve the strict Phase 3 foundation')
  }
  if (ctx.get('sessionTelemetry', false) !== undefined) {
    throw new Error('georesearch-phase3-probe: Session Telemetry is present')
  }

  const requiredTools = phase3HostToolNames()
  const registered = new Set(registeredToolNames(ctx))
  const missing = requiredTools.filter(toolName => !registered.has(toolName))
  if (missing.length > 0) {
    throw new Error(`georesearch-phase3-probe: Phase 3 tools are missing: ${missing.join(', ')}`)
  }
  const literatureCatalog = new Set<string>(PHASE3_REQUIRED_TOOLS.literature)
  if (requiredTools.some(toolName => !literatureCatalog.has(toolName))) {
    throw new Error('georesearch-phase3-probe: literature role catalog is incomplete')
  }
  for (const actor of NON_LITERATURE_ACTORS) {
    const catalog = new Set<string>(PHASE3_REQUIRED_TOOLS[actor])
    if (requiredTools.some(toolName => catalog.has(toolName))) {
      throw new Error(`georesearch-phase3-probe: ${actor} received a literature-only tool`)
    }
  }
  if (registered.has('evidence_commit') || registered.has('evidence_record_commit')) {
    throw new Error('georesearch-phase3-probe: a model-visible evidence commit tool is registered')
  }

  const service = ctx.geoResearchEvidence
  const capability = service.coordinator.provider.capability
  const lineage = service.coordinator.lineage
  if (capability.providerId !== 'crossref'
    || capability.replaySemantics !== 'replay-safe-read'
    || capability.maxPageSize < 1
    || !capability.supportsCredentialRef
    || !isSha256Digest(capability.continuationFormatDigest)) {
    throw new Error('georesearch-phase3-probe: literature provider capability is incompatible')
  }
  if (!isSha256Digest(lineage.configDigest)
    || lineage.providerId.length === 0
    || lineage.providerVersion.length === 0
    || lineage.parserId.length === 0
    || lineage.parserVersion.length === 0) {
    throw new Error('georesearch-phase3-probe: PDF parser lineage is incomplete')
  }
  if (PHASE3_SCHEMAS.some(schema => schema.additionalProperties !== false)) {
    throw new Error('georesearch-phase3-probe: Phase 3 schemas are not strict')
  }
  for (const serviceName of ['geoResearchProjects', 'geoResearchFiles', 'geoResearchEvidence']) {
    if (ctx.get(serviceName, false) === undefined) {
      throw new Error(`georesearch-phase3-probe: ctx.${serviceName} is unavailable`)
    }
  }

  const report = {
    schemaVersion: 1,
    phase: 'phase3-literature-evidence',
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
    providerCapability: capability,
    parserLineage: lineage,
    schemaCount: PHASE3_SCHEMAS.length,
    checks: {
      installationCurrent: true,
      strictPhase3Policy: true,
      projectService: true,
      fileService: true,
      evidenceService: true,
      phase3Tools: true,
      literatureOnlyCatalog: true,
      hostOnlyEvidenceCommit: true,
      providerReplayCapability: true,
      continuationCoordinator: true,
      pdfParserLineage: true,
      schemasFrozen: true,
      telemetryAbsent: true,
    },
  }
  await atomicWriteJson(resolve(config.reportPath), report)
}

export function phase3HostToolNames(): string[] {
  return [...PHASE3_LITERATURE_TOOLS].sort()
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  await rename(temporary, path)
}
