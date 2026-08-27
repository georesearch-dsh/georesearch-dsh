import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@georesearch/dsh-installation-guard'
import type {} from '@georesearch/dsh-policy'
import type {} from '@georesearch/dsh-project-service'
import {
  registerTool,
  resolveDshHome,
  spawnSubprocess,
  type Agent,
  type ToolDefinition,
  type ToolExecution,
} from '@georesearch/dsh-compat-rc5'
import {
  GEODATA_ACTIONS,
  GEODATA_INSPECTION_REPORT_SCHEMA,
  GeoResearchError,
  PROFILE_ID,
  digestJson,
  nowUtc,
  parseGeodataInspectionReport,
  type DatasetLabelClass,
  type DatasetManifest,
  type DatasetSplitMembership,
  type GeodataAction,
  type GeodataInspectionReport,
  type JsonValue,
  type Sha256Digest,
} from '@georesearch/dsh-contracts'
import {
  PythonGeospatialProvider,
  type ProviderInspectionOptions,
} from '@georesearch/dsh-geospatial-provider-python'
import type { GeoResearchProjectService } from '@georesearch/dsh-project-service'

declare module '@deepseek-ai/cordis' {
  interface Context {
    geoResearchGeospatial: GeoResearchGeospatialService
  }
}

export const name = 'georesearch-geospatial-service'
export const inject = [
  'geoResearchInstallation',
  'geoResearchPolicy',
  'geoResearchProjects',
  'subprocess',
  'tools',
]

export interface Config {
  readonly home?: string
  readonly pythonRoot?: string
  readonly pythonExecutable?: string
  readonly requestTimeoutMs?: number
  readonly graceMs?: number
}

export interface GeodataInspectionRequest {
  readonly datasetId: string
  readonly datasetName: string
  readonly datasetVersion: string
  readonly sourceUri: string | null
  readonly sourceProvider: string
  readonly artifactIds: readonly string[]
  readonly actions: readonly GeodataAction[]
  readonly splits: readonly DatasetSplitMembership[]
  readonly qualityMasks: readonly string[]
  readonly preprocessingLevel: string
  readonly labelSchema: readonly DatasetLabelClass[]
  readonly knownLimitations: readonly string[]
  readonly machineLearning: boolean
  readonly classification: boolean
  readonly categoricalResampling: string | null
  readonly spatialStatistics: ProviderInspectionOptions['spatialStatistics']
}

export interface GeospatialProjectPort {
  resolveAgent(agent: Agent): ReturnType<GeoResearchProjectService['resolveAgent']>
  resolveArtifactFile(agent: Agent, artifactId: string): ReturnType<GeoResearchProjectService['resolveArtifactFile']>
}

export interface GeospatialHostPort {
  requireExperiment(agent: Agent): void
}

export interface GeospatialCoordinatorPorts {
  readonly projects: GeospatialProjectPort
  readonly provider: Pick<PythonGeospatialProvider, 'inspect' | 'capability'>
  readonly host: GeospatialHostPort
}

export class GeospatialCoordinator {
  private readonly clock: () => string

  constructor(private readonly ports: GeospatialCoordinatorPorts, now: () => string = nowUtc) {
    this.clock = now
  }

  async inspect(execution: ToolExecution, value: unknown): Promise<GeodataInspectionReport> {
    const agent = exactAgent(execution, 'geodata_inspect')
    this.ports.host.requireExperiment(agent)
    const request = parseInspectionRequest(value)
    return await this.inspectForAgent(agent, request, execution.signal)
  }

  private async inspectForAgent(
    agent: Agent,
    request: GeodataInspectionRequest,
    signal: AbortSignal,
  ): Promise<GeodataInspectionReport> {
    const resolved = await this.ports.projects.resolveAgent(agent)
    const assets = await Promise.all(request.artifactIds.map(async artifactId => {
      const artifact = await this.ports.projects.resolveArtifactFile(agent, artifactId)
      if (artifact.projectId !== resolved.stateFile.projectId || artifact.workspaceId !== resolved.binding.workspaceId) {
        throw new GeoResearchError('GEODATA_INVALID', `Artifact ${artifactId} belongs to another Project binding`)
      }
      return {
        artifactId: artifact.artifact.artifactId,
        digest: artifact.artifact.digest,
        kind: artifact.artifact.kind,
        mediaType: artifact.artifact.mediaType,
        path: artifact.path,
      }
    }))
    const inspectedAt = this.clock()
    const providerResult = await this.ports.provider.inspect({
      assets,
      splits: request.splits,
      options: {
        machineLearning: request.machineLearning,
        classification: request.classification,
        categoricalResampling: request.categoricalResampling,
        labelSchema: request.labelSchema,
        spatialStatistics: request.spatialStatistics,
      },
      signal,
    })
    const actions = [...new Set([...request.actions, ...GEODATA_ACTIONS])].sort() as GeodataAction[]
    const overall = providerResult.checks.some(check => check.mandatory && check.status === 'blocked')
      ? 'blocked'
      : providerResult.checks.some(check => check.mandatory && check.status === 'failed') ? 'failed' : 'passed'
    const reportId = `geodata-${digestJson({
      domain: 'georesearch.geodata-report-id/v1',
      projectId: resolved.stateFile.projectId,
      workspaceId: resolved.binding.workspaceId,
      datasetId: request.datasetId,
      assetDigests: assets.map(asset => asset.digest),
      splits: request.splits,
    }).slice('sha256:'.length, 'sha256:'.length + 80)}`
    const body = {
      schemaVersion: 1 as const,
      reportId,
      projectId: resolved.stateFile.projectId,
      workspaceId: resolved.binding.workspaceId,
      workspaceBindingVersion: resolved.binding.bindingVersion,
      datasetId: request.datasetId,
      datasetName: request.datasetName,
      datasetVersion: request.datasetVersion,
      source: { uri: request.sourceUri, provider: request.sourceProvider, accessedAt: inspectedAt },
      actions,
      provider: this.ports.provider.capability,
      assets: providerResult.assets,
      splits: request.splits,
      qualityMasks: request.qualityMasks,
      preprocessingLevel: request.preprocessingLevel,
      labelSchema: request.labelSchema,
      knownLimitations: request.knownLimitations,
      checks: providerResult.checks,
      overall,
      inspectedAt,
    }
    return parseGeodataInspectionReport({ ...body, digest: digestJson(body) })
  }

  async verifyReport(agent: Agent, report: GeodataInspectionReport, signal?: AbortSignal): Promise<void> {
    const request: GeodataInspectionRequest = {
      datasetId: report.datasetId,
      datasetName: report.datasetName,
      datasetVersion: report.datasetVersion,
      sourceUri: report.source.uri,
      sourceProvider: report.source.provider,
      artifactIds: report.assets.map(asset => asset.artifactRef.artifactId),
      actions: report.actions,
      splits: report.splits,
      qualityMasks: report.qualityMasks,
      preprocessingLevel: report.preprocessingLevel,
      labelSchema: report.labelSchema,
      knownLimitations: report.knownLimitations,
      machineLearning: report.checks.some(check => check.domain === 'geospatial-ml' && check.status !== 'not-applicable'),
      classification: report.checks.some(check => check.checkId === 'label-schema' && check.mandatory),
      categoricalResampling: report.checks.find(check => check.checkId === 'categorical-resampling')?.status === 'passed'
        ? 'nearest'
        : null,
      spatialStatistics: {
        blockingStrategy: 'reported-and-host-revalidated',
        autocorrelation: 'reported-and-host-revalidated',
        multipleComparison: 'reported-and-host-revalidated',
        effectSize: 'reported-and-host-revalidated',
      },
    }
    const verified = await this.inspectForAgent(agent, request, signal ?? new AbortController().signal)
    if (digestJson(reportComparable(verified)) !== digestJson(reportComparable(report))) {
      throw new GeoResearchError('GEODATA_INVALID', `inspection report ${report.reportId} no longer matches the registered Artifacts`)
    }
  }

  manifestFromReport(report: GeodataInspectionReport, role: DatasetManifestRole = 'training'): DatasetManifest {
    const spatialAssets = report.assets.filter(asset => asset.spatialExtent !== null)
    const raster = report.assets.find(asset => asset.width !== null)
    const extent = unionExtents(spatialAssets.map(asset => asset.spatialExtent).filter(value => value !== null))
    const body = {
      schemaVersion: 1 as const,
      datasetId: report.datasetId,
      name: report.datasetName,
      version: report.datasetVersion,
      projectId: report.projectId,
      workspaceId: report.workspaceId,
      workspaceBindingVersion: report.workspaceBindingVersion,
      source: report.source,
      assetRefs: report.assets.map(asset => asset.artifactRef),
      assetDigests: report.assets.map(asset => asset.artifactRef.digest),
      spatialExtent: extent,
      timeRange: { start: null, end: null },
      crs: spatialAssets[0]?.crs ?? { authority: null, wktDigest: null, axisOrder: [], units: [] },
      resolution: raster?.resolution ?? null,
      bands: raster?.bands ?? [],
      fields: uniqueFields(report.assets.flatMap(asset => asset.fields)),
      qualityMasks: report.qualityMasks,
      preprocessingLevel: report.preprocessingLevel,
      labelSchema: report.labelSchema,
      splits: report.splits,
      knownLimitations: [
        ...report.knownLimitations,
        ...(role === 'training' ? [] : [`Experiment dataset role: ${role}`]),
      ],
      inspectionReportDigest: report.digest,
      status: report.overall === 'passed' ? 'verified' as const : 'blocked' as const,
      createdAt: this.clock(),
    }
    return { ...body, digest: digestJson(body) }
  }
}

export type DatasetManifestRole = 'training' | 'validation' | 'testing' | 'covariate' | 'labels'

export class GeoResearchGeospatialService extends Service {
  readonly provider: PythonGeospatialProvider
  readonly coordinator: GeospatialCoordinator

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'geoResearchGeospatial')
    const pythonRoot = config.pythonRoot ?? join(resolveDshHome(config.home), 'profiles', PROFILE_ID, 'python')
    this.provider = new PythonGeospatialProvider({
      runtime: { spawn: spec => spawnSubprocess(ctx, spec) },
      pythonRoot,
      ...(config.pythonExecutable === undefined ? {} : { pythonExecutable: config.pythonExecutable }),
      ...(config.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: config.requestTimeoutMs }),
      ...(config.graceMs === undefined ? {} : { graceMs: config.graceMs }),
    })
    this.coordinator = new GeospatialCoordinator({
      projects: ctx.geoResearchProjects,
      provider: this.provider,
      host: new HarnessGeospatialHost(ctx),
    })
    ctx.effect(
      () => async () => await this.provider.dispose(),
      'georesearch-geospatial-service: Python provider disposal',
    )
  }

  inspect(execution: ToolExecution, value: unknown): Promise<GeodataInspectionReport> {
    return this.coordinator.inspect(execution, value)
  }

  verifyReport(agent: Agent, report: GeodataInspectionReport, signal?: AbortSignal): Promise<void> {
    return this.coordinator.verifyReport(agent, report, signal)
  }

  manifestFromReport(report: GeodataInspectionReport, role?: DatasetManifestRole): DatasetManifest {
    return this.coordinator.manifestFromReport(report, role)
  }

  drain(): Promise<void> {
    return this.provider.drain()
  }
}

class HarnessGeospatialHost implements GeospatialHostPort {
  constructor(private readonly ctx: Context) {}

  requireExperiment(agent: Agent): void {
    this.ctx.geoResearchInstallation.assertCurrent()
    const actor = this.ctx.geoResearchPolicy.actorFor(agent)
    if (actor !== 'experiment' && actor !== 'coordinator') {
      throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', `geodata inspection is not authorized for ${actor ?? 'an unbound actor'}`)
    }
  }
}

export function apply(ctx: Context, config: Config = {}): void {
  ctx.geoResearchInstallation.assertCurrent()
  new GeoResearchGeospatialService(ctx, config)
  for (const tool of geospatialTools(ctx)) registerTool(ctx, tool)
}

export function geospatialTools(ctx: Context): readonly ToolDefinition[] {
  return [{
    name: 'geodata_inspect',
    description: 'Inspect registered geospatial Artifacts with deterministic CRS, alignment, NoData, optical, leakage, and spatial-statistical checks.',
    parameters: GEODATA_INSPECT_PARAMETERS,
    output: { schema: GEODATA_INSPECTION_REPORT_SCHEMA, render: renderJson },
    isConcurrencySafe: () => true,
    async execute(args, execution) {
      return ctx.geoResearchGeospatial.inspect(execution, args) as unknown as Promise<JsonValue>
    },
  }]
}

const SPLIT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    splitId: { type: 'string', minLength: 1 }, role: { type: 'string', enum: ['train', 'validation', 'test', 'holdout'] },
    sampleIds: { type: 'array', items: { type: 'string' } }, spatialUnitIds: { type: 'array', items: { type: 'string' } },
    sourceAssetDigests: { type: 'array', items: { type: 'string', pattern: '^sha256:[0-9a-f]{64}$' } },
    temporalKeys: { type: 'array', items: { type: 'string' } },
  },
  required: ['splitId', 'role', 'sampleIds', 'spatialUnitIds', 'sourceAssetDigests', 'temporalKeys'],
} as const

const GEODATA_INSPECT_PARAMETERS: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object', additionalProperties: false,
  properties: {
    datasetId: { type: 'string', minLength: 1 }, datasetName: { type: 'string', minLength: 1 },
    datasetVersion: { type: 'string', minLength: 1 }, sourceUri: { type: ['string', 'null'] },
    sourceProvider: { type: 'string', minLength: 1 }, artifactIds: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
    actions: { type: 'array', items: { type: 'string', enum: GEODATA_ACTIONS } },
    splits: { type: 'array', items: SPLIT_SCHEMA }, qualityMasks: { type: 'array', items: { type: 'string' } },
    preprocessingLevel: { type: 'string', minLength: 1 },
    labelSchema: {
      type: 'array', items: {
        type: 'object', additionalProperties: false,
        properties: { value: { type: 'string', minLength: 1 }, label: { type: 'string', minLength: 1 } },
        required: ['value', 'label'],
      },
    },
    knownLimitations: { type: 'array', items: { type: 'string' } }, machineLearning: { type: 'boolean' },
    classification: { type: 'boolean' }, categoricalResampling: { type: ['string', 'null'] },
    spatialStatistics: {
      type: 'object', additionalProperties: false,
      properties: {
        blockingStrategy: { type: 'string', minLength: 1 }, autocorrelation: { type: 'string', minLength: 1 },
        multipleComparison: { type: 'string', minLength: 1 }, effectSize: { type: 'string', minLength: 1 },
      },
      required: ['blockingStrategy', 'autocorrelation', 'multipleComparison', 'effectSize'],
    },
  },
  required: [
    'datasetId', 'datasetName', 'datasetVersion', 'sourceUri', 'sourceProvider', 'artifactIds', 'actions',
    'splits', 'qualityMasks', 'preprocessingLevel', 'labelSchema', 'knownLimitations', 'machineLearning',
    'classification', 'categoricalResampling', 'spatialStatistics',
  ],
})

function parseInspectionRequest(value: unknown): GeodataInspectionRequest {
  const record = exactRecord(value, 'geodata_inspect arguments', [
    'datasetId', 'datasetName', 'datasetVersion', 'sourceUri', 'sourceProvider', 'artifactIds', 'actions',
    'splits', 'qualityMasks', 'preprocessingLevel', 'labelSchema', 'knownLimitations', 'machineLearning',
    'classification', 'categoricalResampling', 'spatialStatistics',
  ])
  const artifactIds = stringArray(record.artifactIds, 'artifactIds')
  if (artifactIds.length === 0 || new Set(artifactIds).size !== artifactIds.length) throw new TypeError('artifactIds must be non-empty and unique')
  const actions = enumArray(record.actions, GEODATA_ACTIONS, 'actions')
  const statistics = exactRecord(record.spatialStatistics, 'spatialStatistics', ['blockingStrategy', 'autocorrelation', 'multipleComparison', 'effectSize'])
  return {
    datasetId: id(record.datasetId, 'datasetId'), datasetName: text(record.datasetName, 'datasetName'),
    datasetVersion: text(record.datasetVersion, 'datasetVersion'), sourceUri: nullableText(record.sourceUri, 'sourceUri'),
    sourceProvider: text(record.sourceProvider, 'sourceProvider'), artifactIds, actions,
    splits: parseSplits(record.splits), qualityMasks: stringArray(record.qualityMasks, 'qualityMasks'),
    preprocessingLevel: text(record.preprocessingLevel, 'preprocessingLevel'), labelSchema: parseLabels(record.labelSchema),
    knownLimitations: stringArray(record.knownLimitations, 'knownLimitations'),
    machineLearning: booleanValue(record.machineLearning, 'machineLearning'), classification: booleanValue(record.classification, 'classification'),
    categoricalResampling: nullableText(record.categoricalResampling, 'categoricalResampling'),
    spatialStatistics: {
      blockingStrategy: text(statistics.blockingStrategy, 'spatialStatistics.blockingStrategy'),
      autocorrelation: text(statistics.autocorrelation, 'spatialStatistics.autocorrelation'),
      multipleComparison: text(statistics.multipleComparison, 'spatialStatistics.multipleComparison'),
      effectSize: text(statistics.effectSize, 'spatialStatistics.effectSize'),
    },
  }
}

function parseSplits(value: unknown): DatasetSplitMembership[] {
  if (!Array.isArray(value)) throw new TypeError('splits must be an array')
  return value.map((item, index) => {
    const record = exactRecord(item, `splits[${index}]`, ['splitId', 'role', 'sampleIds', 'spatialUnitIds', 'sourceAssetDigests', 'temporalKeys'])
    return {
      splitId: id(record.splitId, `splits[${index}].splitId`),
      role: enumValue(record.role, ['train', 'validation', 'test', 'holdout'] as const, `splits[${index}].role`),
      sampleIds: stringArray(record.sampleIds, `splits[${index}].sampleIds`),
      spatialUnitIds: stringArray(record.spatialUnitIds, `splits[${index}].spatialUnitIds`),
      sourceAssetDigests: digestArray(record.sourceAssetDigests, `splits[${index}].sourceAssetDigests`),
      temporalKeys: stringArray(record.temporalKeys, `splits[${index}].temporalKeys`),
    }
  })
}

function parseLabels(value: unknown): DatasetLabelClass[] {
  if (!Array.isArray(value)) throw new TypeError('labelSchema must be an array')
  return value.map((item, index) => {
    const record = exactRecord(item, `labelSchema[${index}]`, ['value', 'label'])
    return { value: text(record.value, `labelSchema[${index}].value`), label: text(record.label, `labelSchema[${index}].label`) }
  })
}

function reportComparable(report: GeodataInspectionReport): unknown {
  return {
    projectId: report.projectId, workspaceId: report.workspaceId, workspaceBindingVersion: report.workspaceBindingVersion,
    datasetId: report.datasetId, datasetName: report.datasetName, datasetVersion: report.datasetVersion,
    source: { uri: report.source.uri, provider: report.source.provider }, actions: [...report.actions].sort(),
    provider: report.provider, assets: report.assets, splits: report.splits, qualityMasks: report.qualityMasks,
    preprocessingLevel: report.preprocessingLevel, labelSchema: report.labelSchema,
    knownLimitations: report.knownLimitations, checks: report.checks, overall: report.overall,
  }
}

function unionExtents(extents: readonly (readonly [number, number, number, number])[]): readonly [number, number, number, number] | null {
  if (extents.length === 0) return null
  return [
    Math.min(...extents.map(value => value[0])), Math.min(...extents.map(value => value[1])),
    Math.max(...extents.map(value => value[2])), Math.max(...extents.map(value => value[3])),
  ]
}

function uniqueFields(fields: DatasetManifest['fields']): DatasetManifest['fields'] {
  const byName = new Map(fields.map(field => [field.name, field]))
  return [...byName.values()].sort((left, right) => left.name.localeCompare(right.name))
}

function exactAgent(execution: Pick<ToolExecution, 'agent'>, operation: string): Agent {
  if (execution.agent === undefined) throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', `${operation} requires an exact live Agent`)
  return execution.agent
}

function exactRecord(value: unknown, field: string, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${field} must be an object`)
  const record = value as Record<string, unknown>
  const unexpected = Object.keys(record).filter(key => !allowed.includes(key))
  if (unexpected.length > 0) throw new TypeError(`${field} contains unsupported fields: ${unexpected.join(', ')}`)
  return record
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) throw new TypeError(`${field} must be non-empty NUL-free text`)
  return value
}

function nullableText(value: unknown, field: string): string | null {
  return value === null ? null : text(value, field)
}

function id(value: unknown, field: string): string {
  const result = text(value, field)
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(result)) throw new TypeError(`${field} is invalid`)
  return result
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  return value.map((item, index) => text(item, `${field}[${index}]`))
}

function digestArray(value: unknown, field: string): Sha256Digest[] {
  return stringArray(value, field).map((item, index) => {
    if (!/^sha256:[0-9a-f]{64}$/u.test(item)) throw new TypeError(`${field}[${index}] is invalid`)
    return item as Sha256Digest
  })
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be boolean`)
  return value
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, field: string): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) throw new TypeError(`${field} is invalid`)
  return value as T[number]
}

function enumArray<const T extends readonly string[]>(value: unknown, values: T, field: string): T[number][] {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  return value.map((item, index) => enumValue(item, values, `${field}[${index}]`))
}

function renderJson(_args: unknown, value: JsonValue) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}
