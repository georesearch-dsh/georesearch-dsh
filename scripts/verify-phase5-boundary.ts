import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'
import {
  DATASET_MANIFEST_SCHEMA,
  ERROR_CODES,
  EXPERIMENT_AMENDMENT_SCHEMA,
  EXPERIMENT_SPEC_CANDIDATE_SCHEMA,
  EXPERIMENT_SPEC_SCHEMA,
  GEODATA_INSPECTION_REPORT_SCHEMA,
  PHASE5_EXPERIMENT_TOOLS,
  PHASE5_REQUIRED_TOOLS,
  RESULT_ENVELOPE_SCHEMA,
  RESULT_RECORD_SCHEMA,
} from '@georesearch/dsh-contracts'
import { inject as delegationInject } from '../packages/delegation-tools/lib/index.js'
import {
  GeoResearchExperimentService,
  experimentTools,
  inject as experimentInject,
} from '../packages/experiment-service/lib/index.js'
import { PythonGeospatialProvider } from '../packages/geospatial-provider-python/lib/index.js'
import {
  GeoResearchGeospatialService,
  geospatialTools,
  inject as geospatialInject,
} from '../packages/geospatial-service/lib/index.js'
import { GeoResearchProjectService } from '../packages/project-service/lib/index.js'
import { phase5HostToolNames } from '../packages/bundle/lib/phase5-probe.js'
import { WORKSPACE_PACKAGES } from './workspace-packages.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const JsType = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: value => value ?? '',
})
const schema = DEFAULT_SCHEMA.extend([JsType])

const phase5Packages = [
  '@georesearch/dsh-geospatial-provider-python',
  '@georesearch/dsh-geospatial-service',
  '@georesearch/dsh-experiment-service',
] as const
for (const packageName of phase5Packages) {
  if (!WORKSPACE_PACKAGES.some(entry => entry.name === packageName)) {
    throw new Error(`Phase 5 package is missing: ${packageName}`)
  }
}

const bundleSource = await readFile(resolve(root, 'packages', 'bundle', 'cordis.patch.yml'), 'utf8')
const rows = compositionRows(load(bundleSource, { schema }) as unknown)
const byId = new Map(rows.map(row => [String(row.id), row]))
const policy = byId.get('georesearch-policy')?.config as Record<string, unknown> | undefined
const delegation = byId.get('georesearch-delegation-tools')?.config as Record<string, unknown> | undefined
if (policy?.strictCatalog !== true
  || !['phase5', 'phase6', 'full'].includes(String(policy.capabilityStage))) {
  throw new Error('bundle policy does not preserve strict Phase 5')
}
if (delegation?.strictRoleCapabilities !== true
  || !['phase5', 'phase6', 'full'].includes(String(delegation.capabilityStage))) {
  throw new Error('delegation tools do not preserve strict Phase 5')
}

const reproductionRow = byId.get('georesearch-reproduction-service')
const geospatialRow = byId.get('georesearch-geospatial-service')
const experimentRow = byId.get('georesearch-experiment-service')
const delegationRow = byId.get('georesearch-delegation-tools')
if (geospatialRow?.name !== '@georesearch/dsh-geospatial-service'
  || experimentRow?.name !== '@georesearch/dsh-experiment-service'
  || rows.indexOf(geospatialRow) <= rows.indexOf(reproductionRow!)
  || rows.indexOf(experimentRow) <= rows.indexOf(geospatialRow)
  || rows.indexOf(delegationRow!) <= rows.indexOf(experimentRow)) {
  throw new Error('Geospatial and Experiment services are not composed in authority order')
}
const phase5ProbeRow = byId.get('georesearch-phase5-probe')
if (phase5ProbeRow?.name !== '@georesearch/dsh-bundle/phase5-probe'
  || typeof phase5ProbeRow.disabled !== 'string'
  || !phase5ProbeRow.disabled.includes('GEORESEARCH_PHASE5_PROBE_REPORT')) {
  throw new Error('Phase 5 runtime probe is missing or not normally disabled')
}
if (byId.get('session-telemetry-otel')?.disabled !== true) {
  throw new Error('Session Telemetry is not fail-closed disabled')
}

const modelTools = [
  ...geospatialTools({} as never),
  ...experimentTools({} as never),
].map(tool => tool.name).sort()
const expectedTools = [
  ...PHASE5_EXPERIMENT_TOOLS,
  'experiment_spec_commit',
  'result_commit',
  'result_read',
].sort()
if (JSON.stringify(modelTools) !== JSON.stringify(expectedTools)
  || JSON.stringify(phase5HostToolNames()) !== JSON.stringify(expectedTools)) {
  throw new Error('Phase 5 model tool registration differs from the frozen contract')
}
const toolActors = {
  geodata_inspect: ['experiment'],
  experiment_spec_candidate: ['experiment'],
  experiment_spec_commit: ['coordinator'],
  result_commit: ['coordinator'],
  result_read: ['reviewer'],
} as const
for (const [toolName, allowedActors] of Object.entries(toolActors)) {
  for (const actor of Object.keys(PHASE5_REQUIRED_TOOLS) as Array<keyof typeof PHASE5_REQUIRED_TOOLS>) {
    const present = new Set<string>(PHASE5_REQUIRED_TOOLS[actor]).has(toolName)
    if (present !== (allowedActors as readonly string[]).includes(actor)) {
      throw new Error(`${toolName} role catalog is invalid for ${actor}`)
    }
  }
}
const resultCommit = experimentTools({} as never).find(tool => tool.name === 'result_commit')
const resultProperties = (resultCommit?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
if (resultProperties === undefined
  || JSON.stringify(Object.keys(resultProperties).sort()) !== JSON.stringify(['expectedGeneration', 'runId'])
  || Object.hasOwn(resultProperties, 'value')
  || Object.hasOwn(resultProperties, 'results')) {
  throw new Error('result_commit accepts model-supplied result values')
}

if (!geospatialInject.includes('geoResearchProjects')
  || !experimentInject.includes('geoResearchGeospatial')
  || !experimentInject.includes('geoResearchRuns')
  || !delegationInject.includes('geoResearchReproduction')) {
  throw new Error('Phase 5 service injection boundaries are incomplete')
}
if (typeof PythonGeospatialProvider.prototype.ready !== 'function'
  || typeof PythonGeospatialProvider.prototype.inspect !== 'function'
  || typeof PythonGeospatialProvider.prototype.drain !== 'function'
  || typeof PythonGeospatialProvider.prototype.dispose !== 'function'
  || typeof GeoResearchGeospatialService.prototype.verifyReport !== 'function'
  || typeof GeoResearchExperimentService.prototype.commitResults !== 'function'
  || typeof GeoResearchProjectService.prototype.commitExperimentSpec !== 'function'
  || typeof GeoResearchProjectService.prototype.commitResultRecords !== 'function') {
  throw new Error('Phase 5 Provider or Host authority API is incomplete')
}

const schemas = [
  ['geodata-inspection-report.schema.json', GEODATA_INSPECTION_REPORT_SCHEMA],
  ['dataset-manifest.schema.json', DATASET_MANIFEST_SCHEMA],
  ['experiment-spec-candidate.schema.json', EXPERIMENT_SPEC_CANDIDATE_SCHEMA],
  ['experiment-spec.schema.json', EXPERIMENT_SPEC_SCHEMA],
  ['experiment-amendment.schema.json', EXPERIMENT_AMENDMENT_SCHEMA],
  ['result-envelope.schema.json', RESULT_ENVELOPE_SCHEMA],
  ['result-record.schema.json', RESULT_RECORD_SCHEMA],
] as const
for (const [file, runtime] of schemas) {
  const bundled = JSON.parse(
    await readFile(resolve(root, 'packages', 'bundle', 'schemas', file), 'utf8'),
  ) as Record<string, unknown>
  const { $schema, $id, title, ...body } = bundled
  void $schema
  void $id
  void title
  if (JSON.stringify(body) !== JSON.stringify(runtime)) throw new Error(`schema parity failed: ${file}`)
}
for (const code of [
  'GEOSPATIAL_PROVIDER_UNAVAILABLE',
  'GEOSPATIAL_WORKER_CRASHED',
  'GEODATA_MANDATORY_CHECK_BLOCKED',
  'EXPERIMENT_SPEC_INVALID',
  'EXPERIMENT_AMENDMENT_INVALID',
  'RESULT_ENVELOPE_INVALID',
  'RESULT_INVALID',
] as const) {
  if (!ERROR_CODES.includes(code)) throw new Error(`Phase 5 error code is missing: ${code}`)
}

const bundleManifest = JSON.parse(
  await readFile(resolve(root, 'packages', 'bundle', 'package.json'), 'utf8'),
) as { readonly exports?: Record<string, unknown>; readonly dependencies?: Record<string, unknown> }
if (bundleManifest.exports?.['./phase5-probe'] === undefined
  || phase5Packages.some(packageName => bundleManifest.dependencies?.[packageName] === undefined)) {
  throw new Error('bundle does not publish the complete Phase 5 runtime surface')
}

await readFile(resolve(root, 'docs', 'phase5-gate.md'), 'utf8')
process.stdout.write(`${JSON.stringify({
  phase4Complete: true,
  phase5Complete: true,
  phase5Packages: phase5Packages.length,
  phase5Tools: modelTools.length,
  schemas: schemas.length,
  hostOnlyResultValues: true,
  persistentPythonProvider: true,
  telemetryDisabled: true,
}, undefined, 2)}\n`)

function compositionRows(value: unknown): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const child of current) visit(child)
      return
    }
    if (typeof current !== 'object' || current === null) return
    const record = current as Record<string, unknown>
    if (typeof record.id === 'string') rows.push(record)
    if (Array.isArray(record.insert)) visit(record.insert)
    if (Array.isArray(record.config)) visit(record.config)
  }
  visit(value)
  return rows
}
