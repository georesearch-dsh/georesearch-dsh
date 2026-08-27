import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@georesearch/dsh-installation-guard'
import type {} from '@georesearch/dsh-policy'
import type {} from '@georesearch/dsh-project-service'
import type {} from '@georesearch/dsh-file-service'
import { registeredToolNames } from '@georesearch/dsh-compat-rc5'
import {
  GENERIC_ATTACHMENT_LIMITS,
  PHASE25_ATTACHMENT_TOOLS,
  PHASE25_REQUIRED_TOOLS,
  READABLE_ATTACHMENT_STRATEGIES,
  nowUtc,
  type GeoResearchActor,
} from '@georesearch/dsh-contracts'
import { FILE_API_PATH } from '@georesearch/dsh-file-service'

export const name = 'georesearch-phase25-probe'
export const inject = [
  'geoResearchInstallation',
  'geoResearchPolicy',
  'geoResearchProjects',
  'geoResearchFiles',
  'tools',
]

const ATTACHMENT_ACTORS: readonly GeoResearchActor[] = [
  'coordinator', 'literature', 'experiment', 'reviewer',
]

export interface Config {
  readonly reportPath: string
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (typeof config.reportPath !== 'string' || config.reportPath.length === 0) {
    throw new TypeError('georesearch-phase25-probe: reportPath is required')
  }
  ctx.geoResearchInstallation.assertCurrent()
  if ((ctx.geoResearchPolicy.capabilityStage !== 'phase2'
    && ctx.geoResearchPolicy.capabilityStage !== 'phase3'
    && ctx.geoResearchPolicy.capabilityStage !== 'phase4'
    && ctx.geoResearchPolicy.capabilityStage !== 'phase5'
    && ctx.geoResearchPolicy.capabilityStage !== 'phase6'
    && ctx.geoResearchPolicy.capabilityStage !== 'full')
    || !ctx.geoResearchPolicy.strictCatalog) {
    throw new Error('georesearch-phase25-probe: policy does not provide the strict Phase 2.5 foundation')
  }

  const requiredTools = phase25HostToolNames()
  const registered = new Set(registeredToolNames(ctx))
  const missing = requiredTools.filter(toolName => !registered.has(toolName))
  if (missing.length > 0) {
    throw new Error(`georesearch-phase25-probe: attachment tools are missing: ${missing.join(', ')}`)
  }
  for (const actor of ATTACHMENT_ACTORS) {
    const catalog = new Set<string>(PHASE25_REQUIRED_TOOLS[actor])
    if (requiredTools.some(toolName => !catalog.has(toolName))) {
      throw new Error(`georesearch-phase25-probe: ${actor} attachment catalog is incomplete`)
    }
  }
  const writingCatalog = new Set<string>(PHASE25_REQUIRED_TOOLS.writing)
  if (PHASE25_ATTACHMENT_TOOLS.some(toolName => writingCatalog.has(toolName))) {
    throw new Error('georesearch-phase25-probe: writing role bypasses the approved writing packet boundary')
  }
  if (ctx.get('geoResearchProjects', false) === undefined || ctx.get('geoResearchFiles', false) === undefined) {
    throw new Error('georesearch-phase25-probe: Project or File service is unavailable')
  }
  if (ctx.geoResearchFiles.maxFileBytes !== GENERIC_ATTACHMENT_LIMITS.maxFileBytes
    || ctx.geoResearchFiles.maxDirectReadBytes !== GENERIC_ATTACHMENT_LIMITS.maxDirectReadBytes) {
    throw new Error('georesearch-phase25-probe: attachment safety limits differ from the Phase 2.5 contract')
  }

  const report = {
    schemaVersion: 1,
    phase: 'phase2.5-universal-attachments',
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
    apiPath: FILE_API_PATH,
    requiredTools,
    attachmentActors: ATTACHMENT_ACTORS,
    readableStrategies: READABLE_ATTACHMENT_STRATEGIES,
    limits: GENERIC_ATTACHMENT_LIMITS,
    checks: {
      installationCurrent: true,
      strictPhase25Foundation: true,
      projectService: true,
      fileService: true,
      attachmentTools: true,
      roleCatalogs: true,
      writingPacketBoundary: true,
      boundedUploadAndRead: true,
      readableUploadsOnly: true,
      phase3Compatible: true,
    },
  }
  await atomicWriteJson(resolve(config.reportPath), report)
}

export function phase25HostToolNames(): string[] {
  return [...PHASE25_ATTACHMENT_TOOLS].sort()
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  await rename(temporary, path)
}
