import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@georesearch/dsh-experiment-service'
import type {} from '@georesearch/dsh-geospatial-service'
import type {} from '@georesearch/dsh-installation-guard'
import type {} from '@georesearch/dsh-policy'
import type {} from '@georesearch/dsh-project-service'
import type {} from '@georesearch/dsh-run-service'
import { registeredToolNames } from '@georesearch/dsh-compat-rc5'
import {
  DATASET_MANIFEST_SCHEMA,
  EXPERIMENT_AMENDMENT_SCHEMA,
  EXPERIMENT_SPEC_CANDIDATE_SCHEMA,
  EXPERIMENT_SPEC_SCHEMA,
  GEODATA_INSPECTION_REPORT_SCHEMA,
  PHASE5_REQUIRED_TOOLS,
  RESULT_ENVELOPE_SCHEMA,
  RESULT_RECORD_SCHEMA,
  nowUtc,
  type GeoResearchActor,
} from '@georesearch/dsh-contracts'
import { experimentTools } from '@georesearch/dsh-experiment-service'

export const name = 'georesearch-phase5-probe'
export const inject = [
  'geoResearchInstallation',
  'geoResearchPolicy',
  'geoResearchProjects',
  'geoResearchRuns',
  'geoResearchGeospatial',
  'geoResearchExperiments',
  'tools',
]

const PHASE5_SCHEMAS = [
  GEODATA_INSPECTION_REPORT_SCHEMA,
  DATASET_MANIFEST_SCHEMA,
  EXPERIMENT_SPEC_CANDIDATE_SCHEMA,
  EXPERIMENT_SPEC_SCHEMA,
  EXPERIMENT_AMENDMENT_SCHEMA,
  RESULT_ENVELOPE_SCHEMA,
  RESULT_RECORD_SCHEMA,
] as const

const TOOL_ACTORS = {
  geodata_inspect: ['experiment'],
  experiment_spec_candidate: ['experiment'],
  experiment_spec_commit: ['coordinator'],
  result_commit: ['coordinator'],
  result_read: ['reviewer'],
} as const satisfies Record<string, readonly GeoResearchActor[]>

export interface Config {
  readonly reportPath: string
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (typeof config.reportPath !== 'string' || config.reportPath.length === 0) {
    throw new TypeError('georesearch-phase5-probe: reportPath is required')
  }
  ctx.geoResearchInstallation.assertCurrent()
  if ((ctx.geoResearchPolicy.capabilityStage !== 'phase5'
    && ctx.geoResearchPolicy.capabilityStage !== 'phase6'
    && ctx.geoResearchPolicy.capabilityStage !== 'full')
    || !ctx.geoResearchPolicy.strictCatalog) {
    throw new Error('georesearch-phase5-probe: policy is not in strict Phase 5 mode')
  }
  if (ctx.get('sessionTelemetry', false) !== undefined) {
    throw new Error('georesearch-phase5-probe: Session Telemetry is present')
  }

  const requiredTools = phase5HostToolNames()
  const registered = new Set(registeredToolNames(ctx))
  const missing = requiredTools.filter(toolName => !registered.has(toolName))
  if (missing.length > 0) {
    throw new Error(`georesearch-phase5-probe: Phase 5 tools are missing: ${missing.join(', ')}`)
  }
  for (const [toolName, allowedActors] of Object.entries(TOOL_ACTORS)) {
    for (const actor of Object.keys(PHASE5_REQUIRED_TOOLS) as GeoResearchActor[]) {
      const present = new Set<string>(PHASE5_REQUIRED_TOOLS[actor]).has(toolName)
      if (present !== allowedActors.includes(actor as never)) {
        throw new Error(`georesearch-phase5-probe: ${toolName} role catalog is invalid for ${actor}`)
      }
    }
  }

  const resultCommit = experimentTools(ctx).find(tool => tool.name === 'result_commit')
  const resultProperties = (resultCommit?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
  if (resultProperties === undefined
    || JSON.stringify(Object.keys(resultProperties).sort()) !== JSON.stringify(['expectedGeneration', 'runId'])
    || Object.hasOwn(resultProperties, 'value') || Object.hasOwn(resultProperties, 'results')) {
    throw new Error('georesearch-phase5-probe: result_commit accepts model-supplied result values')
  }

  const capability = await ctx.geoResearchGeospatial.provider.ready()
  if (capability.providerId !== 'python-geospatial'
    || capability.protocol !== 'georesearch-worker/1'
    || capability.shell !== false
    || capability.persistentWorker !== true
    || capability.cancel !== true
    || capability.deadlines !== true
    || capability.libraries.rasterio === null
    || capability.libraries.rasterio === undefined
    || capability.libraries.pyproj === null
    || capability.libraries.pyproj === undefined) {
    throw new Error('georesearch-phase5-probe: Python geospatial capability is incompatible')
  }
  if (PHASE5_SCHEMAS.some(schema => schema.additionalProperties !== false)) {
    throw new Error('georesearch-phase5-probe: Phase 5 schemas are not strict')
  }
  for (const serviceName of [
    'geoResearchProjects',
    'geoResearchRuns',
    'geoResearchGeospatial',
    'geoResearchExperiments',
  ]) {
    if (ctx.get(serviceName, false) === undefined) {
      throw new Error(`georesearch-phase5-probe: ctx.${serviceName} is unavailable`)
    }
  }

  const report = {
    schemaVersion: 1,
    phase: 'phase5-geospatial-experiment',
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
    schemaCount: PHASE5_SCHEMAS.length,
    checks: {
      installationCurrent: true,
      strictPhase5Policy: true,
      projectService: true,
      runService: true,
      geospatialService: true,
      experimentService: true,
      phase5Tools: true,
      exactRoleCatalogs: true,
      hostOnlyResultValues: true,
      persistentPythonProvider: true,
      mandatoryRasterio: true,
      mandatoryPyproj: true,
      schemasFrozen: true,
      telemetryAbsent: true,
    },
  }
  await atomicWriteJson(resolve(config.reportPath), report)
}

export function phase5HostToolNames(): string[] {
  return Object.keys(TOOL_ACTORS).sort()
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  await rename(temporary, path)
}
