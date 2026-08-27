import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@georesearch/dsh-installation-guard'
import type {} from '@georesearch/dsh-policy'
import type {} from '@georesearch/dsh-project-service'
import type {} from '@georesearch/dsh-reproduction-service'
import type {} from '@georesearch/dsh-run-service'
import { registeredToolNames } from '@georesearch/dsh-compat-rc5'
import {
  PHASE4_REPRODUCTION_TOOLS,
  PHASE4_REQUIRED_TOOLS,
  REPOSITORY_AUDIT_SCHEMA,
  REPRODUCTION_PLAN_BODY_SCHEMA,
  REPRODUCTION_PLAN_SCHEMA,
  REPRODUCTION_REPORT_CANDIDATE_SCHEMA,
  REPRODUCTION_REPORT_SCHEMA,
  REPRODUCTION_TEST_SPEC_SCHEMA,
  nowUtc,
  type GeoResearchActor,
} from '@georesearch/dsh-contracts'

export const name = 'georesearch-phase4-probe'
export const inject = [
  'geoResearchInstallation',
  'geoResearchPolicy',
  'geoResearchProjects',
  'geoResearchRuns',
  'geoResearchReproduction',
  'tools',
]

const NON_EXPERIMENT_ACTORS: readonly GeoResearchActor[] = [
  'coordinator', 'literature', 'reviewer', 'writing',
]

const PHASE4_SCHEMAS = [
  REPOSITORY_AUDIT_SCHEMA,
  REPRODUCTION_PLAN_SCHEMA,
  REPRODUCTION_TEST_SPEC_SCHEMA,
  REPRODUCTION_REPORT_CANDIDATE_SCHEMA,
  REPRODUCTION_REPORT_SCHEMA,
] as const

export interface Config {
  readonly reportPath: string
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (typeof config.reportPath !== 'string' || config.reportPath.length === 0) {
    throw new TypeError('georesearch-phase4-probe: reportPath is required')
  }
  ctx.geoResearchInstallation.assertCurrent()
  if ((ctx.geoResearchPolicy.capabilityStage !== 'phase4'
    && ctx.geoResearchPolicy.capabilityStage !== 'phase5'
    && ctx.geoResearchPolicy.capabilityStage !== 'phase6'
    && ctx.geoResearchPolicy.capabilityStage !== 'full')
    || !ctx.geoResearchPolicy.strictCatalog) {
    throw new Error('georesearch-phase4-probe: policy is not in strict Phase 4 mode')
  }
  if (ctx.get('sessionTelemetry', false) !== undefined) {
    throw new Error('georesearch-phase4-probe: Session Telemetry is present')
  }

  const requiredTools = phase4HostToolNames()
  const registered = new Set(registeredToolNames(ctx))
  const missing = requiredTools.filter(toolName => !registered.has(toolName))
  if (missing.length > 0) {
    throw new Error(`georesearch-phase4-probe: Phase 4 tools are missing: ${missing.join(', ')}`)
  }
  const experimentCatalog = new Set<string>(PHASE4_REQUIRED_TOOLS.experiment)
  if (requiredTools.some(toolName => !experimentCatalog.has(toolName))) {
    throw new Error('georesearch-phase4-probe: Experiment catalog is incomplete')
  }
  for (const actor of NON_EXPERIMENT_ACTORS) {
    const catalog = new Set<string>(PHASE4_REQUIRED_TOOLS[actor])
    if (requiredTools.some(toolName => catalog.has(toolName))) {
      throw new Error(`georesearch-phase4-probe: ${actor} received an Experiment-only tool`)
    }
  }
  if (registered.has('reproduction_report_commit') || registered.has('reproduction_report_candidate_commit')) {
    throw new Error('georesearch-phase4-probe: a model-visible reproduction report commit tool is registered')
  }
  if (!registered.has('artifact_read')) {
    throw new Error('georesearch-phase4-probe: Reviewer report Artifact reading is unavailable')
  }

  const capability = ctx.geoResearchReproduction.repository.capability
  if (capability.providerId !== 'git-cli' || capability.shell !== false
    || capability.readOnlyCommands !== true || capability.maxFiles < 1
    || capability.maxChanges < 1 || capability.maxHashedBytes < 1) {
    throw new Error('georesearch-phase4-probe: repository provider capability is incompatible')
  }
  if (REPRODUCTION_PLAN_BODY_SCHEMA.additionalProperties !== false
    || PHASE4_SCHEMAS.some(schema => schema.additionalProperties !== false)) {
    throw new Error('georesearch-phase4-probe: Phase 4 schemas are not strict')
  }
  for (const serviceName of ['geoResearchProjects', 'geoResearchRuns', 'geoResearchReproduction']) {
    if (ctx.get(serviceName, false) === undefined) {
      throw new Error(`georesearch-phase4-probe: ctx.${serviceName} is unavailable`)
    }
  }

  const report = {
    schemaVersion: 1,
    phase: 'phase4-repository-reproduction',
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
    repositoryCapability: capability,
    schemaCount: PHASE4_SCHEMAS.length,
    checks: {
      installationCurrent: true,
      strictPhase4Policy: true,
      projectService: true,
      runService: true,
      reproductionService: true,
      phase4Tools: true,
      experimentOnlyCatalog: true,
      hostOnlyReportCommit: true,
      reviewerArtifactRead: true,
      readOnlyGitProvider: true,
      dynamicSmokeExcluded: true,
      schemasFrozen: true,
      telemetryAbsent: true,
    },
  }
  await atomicWriteJson(resolve(config.reportPath), report)
}

export function phase4HostToolNames(): string[] {
  return [...PHASE4_REPRODUCTION_TOOLS].sort()
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  await rename(temporary, path)
}
