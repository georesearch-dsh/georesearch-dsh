import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@georesearch/dsh-installation-guard'
import type {} from '@georesearch/dsh-policy'
import type {} from '@georesearch/dsh-project-service'
import type {} from '@georesearch/dsh-run-service'
import { registeredToolNames } from '@georesearch/dsh-compat-rc5'
import {
  PROJECT_SNAPSHOT_SCHEMA,
  RESEARCH_BRIEF_SCHEMA,
  RUN_RECORD_SCHEMA,
  nowUtc,
  requiredToolsFor,
  type GeoResearchActor,
} from '@georesearch/dsh-contracts'

export const name = 'georesearch-phase2-probe'
export const inject = [
  'geoResearchInstallation',
  'geoResearchPolicy',
  'geoResearchProjects',
  'geoResearchRuns',
  'tools',
  'sandbox',
  'sandboxPolicy',
  'subprocess',
]

const ACTORS: readonly GeoResearchActor[] = [
  'coordinator', 'literature', 'experiment', 'reviewer', 'writing',
]

const PHASE3_TOOL_NAMES = [
  'literature_search',
  'literature_continue',
  'paper_read',
  'source_resolve',
  'evidence_candidate',
  'citation_check',
] as const

export interface Config {
  readonly reportPath: string
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (typeof config.reportPath !== 'string' || config.reportPath.length === 0) {
    throw new TypeError('georesearch-phase2-probe: reportPath is required')
  }
  ctx.geoResearchInstallation.assertCurrent()
  const capabilityStage = ctx.geoResearchPolicy.capabilityStage
  if ((capabilityStage !== 'phase2' && capabilityStage !== 'phase3' && capabilityStage !== 'phase4'
    && capabilityStage !== 'phase5' && capabilityStage !== 'phase6' && capabilityStage !== 'full')
    || !ctx.geoResearchPolicy.strictCatalog) {
    throw new Error('georesearch-phase2-probe: policy does not provide the strict Phase 2 foundation')
  }

  const registered = new Set(registeredToolNames(ctx))
  const requiredTools = phase2HostToolNames()
  const missing = requiredTools.filter(toolName => !registered.has(toolName))
  if (missing.length > 0) {
    throw new Error(`georesearch-phase2-probe: Phase 2 tools are missing: ${missing.join(', ')}`)
  }
  const phase3Tools = PHASE3_TOOL_NAMES.filter(toolName => registered.has(toolName))
  const phase3TransitionConsistent = capabilityStage === 'phase2'
    ? phase3Tools.length === 0
    : phase3Tools.length === PHASE3_TOOL_NAMES.length
  if (!phase3TransitionConsistent) {
    throw new Error('georesearch-phase2-probe: Phase 3 stage and tool registration disagree')
  }
  if (ctx.get('sessionTelemetry', false) !== undefined) {
    throw new Error('georesearch-phase2-probe: Session Telemetry is present')
  }
  for (const service of ['geoResearchProjects', 'geoResearchRuns', 'sandbox', 'sandboxPolicy', 'subprocess']) {
    if (ctx.get(service, false) === undefined) throw new Error(`georesearch-phase2-probe: ctx.${service} is unavailable`)
  }
  const schemasFrozen = [RESEARCH_BRIEF_SCHEMA, PROJECT_SNAPSHOT_SCHEMA, RUN_RECORD_SCHEMA]
    .every(schema => schema.additionalProperties === false)
  if (!schemasFrozen) throw new Error('georesearch-phase2-probe: Phase 2 schemas are not strict')

  const report = {
    schemaVersion: 1,
    phase: 'phase2-project-run-foundation',
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
    phase3Tools,
    telemetryAbsent: true,
    checks: {
      installationCurrent: true,
      strictPhase2Foundation: true,
      projectService: true,
      runService: true,
      executionServices: true,
      phase2Tools: true,
      schemasFrozen: true,
      telemetryAbsent: true,
      phase3TransitionConsistent: true,
    },
  }
  await atomicWriteJson(resolve(config.reportPath), report)
}

export function phase2HostToolNames(): string[] {
  const phase1 = new Set(ACTORS.flatMap(actor => requiredToolsFor(actor, 'phase1')))
  return [...new Set(ACTORS.flatMap(actor => requiredToolsFor(actor, 'phase2'))
    .filter(toolName => !phase1.has(toolName)))].sort()
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  await rename(temporary, path)
}
