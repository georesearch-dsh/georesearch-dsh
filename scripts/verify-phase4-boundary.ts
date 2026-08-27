import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'
import {
  ERROR_CODES,
  PHASE4_REPRODUCTION_TOOLS,
  PHASE4_REQUIRED_TOOLS,
  REPOSITORY_AUDIT_SCHEMA,
  REPRODUCTION_PLAN_SCHEMA,
  REPRODUCTION_REPORT_CANDIDATE_SCHEMA,
  REPRODUCTION_REPORT_SCHEMA,
  REPRODUCTION_TEST_SPEC_SCHEMA,
} from '@georesearch/dsh-contracts'
import { inject as delegationInject } from '../packages/delegation-tools/lib/index.js'
import { GeoResearchProjectService } from '../packages/project-service/lib/index.js'
import { GitRepositoryProvider } from '../packages/repository-providers/lib/index.js'
import {
  inject as reproductionInject,
  reproductionTools,
} from '../packages/reproduction-service/lib/index.js'
import { GeoResearchRunService } from '../packages/run-service/lib/index.js'
import { phase4HostToolNames } from '../packages/bundle/lib/phase4-probe.js'
import { WORKSPACE_PACKAGES } from './workspace-packages.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const JsType = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: value => value ?? '',
})
const schema = DEFAULT_SCHEMA.extend([JsType])

for (const packageName of [
  '@georesearch/dsh-repository-providers',
  '@georesearch/dsh-reproduction-service',
]) {
  if (!WORKSPACE_PACKAGES.some(entry => entry.name === packageName)) {
    throw new Error(`Phase 4 package is missing: ${packageName}`)
  }
}

const bundleSource = await readFile(resolve(root, 'packages', 'bundle', 'cordis.patch.yml'), 'utf8')
const rows = compositionRows(load(bundleSource, { schema }) as unknown)
const byId = new Map(rows.map(row => [String(row.id), row]))
const policy = byId.get('georesearch-policy')?.config as Record<string, unknown> | undefined
const delegation = byId.get('georesearch-delegation-tools')?.config as Record<string, unknown> | undefined
if (policy?.strictCatalog !== true
  || !['phase4', 'phase5', 'phase6', 'full'].includes(String(policy.capabilityStage))) {
  throw new Error('bundle policy does not preserve strict Phase 4')
}
if (delegation?.strictRoleCapabilities !== true
  || !['phase4', 'phase5', 'phase6', 'full'].includes(String(delegation.capabilityStage))) {
  throw new Error('delegation tools do not preserve strict Phase 4')
}

const runRow = byId.get('georesearch-run-service')
const reproductionRow = byId.get('georesearch-reproduction-service')
const delegationRow = byId.get('georesearch-delegation-tools')
if (runRow?.name !== '@georesearch/dsh-run-service'
  || reproductionRow?.name !== '@georesearch/dsh-reproduction-service'
  || rows.indexOf(reproductionRow) <= rows.indexOf(runRow)
  || rows.indexOf(delegationRow!) <= rows.indexOf(reproductionRow)) {
  throw new Error('Reproduction Service must be composed after Run and before Delegation')
}
const phase4ProbeRow = byId.get('georesearch-phase4-probe')
if (phase4ProbeRow?.name !== '@georesearch/dsh-bundle/phase4-probe'
  || typeof phase4ProbeRow.disabled !== 'string'
  || !phase4ProbeRow.disabled.includes('GEORESEARCH_PHASE4_PROBE_REPORT')) {
  throw new Error('Phase 4 runtime probe is missing or not normally disabled')
}
if (byId.get('session-telemetry-otel')?.disabled !== true) {
  throw new Error('Session Telemetry is not fail-closed disabled')
}

const modelTools = reproductionTools({} as never).map(tool => tool.name).sort()
if (JSON.stringify(modelTools) !== JSON.stringify([...PHASE4_REPRODUCTION_TOOLS].sort())
  || JSON.stringify(phase4HostToolNames()) !== JSON.stringify(modelTools)) {
  throw new Error('Phase 4 model tool registration differs from the frozen contract')
}
for (const toolName of PHASE4_REPRODUCTION_TOOLS) {
  if (!PHASE4_REQUIRED_TOOLS.experiment.includes(toolName)) {
    throw new Error(`Experiment role is missing ${toolName}`)
  }
  for (const actor of ['coordinator', 'literature', 'reviewer', 'writing'] as const) {
    if ((PHASE4_REQUIRED_TOOLS[actor] as readonly string[]).includes(toolName)) {
      throw new Error(`${actor} received Experiment-only tool ${toolName}`)
    }
  }
}
if (modelTools.some(toolName => toolName.includes('report_commit'))) {
  throw new Error('a model-visible ReproductionReport commit tool exists')
}
const testSpecTool = reproductionTools({} as never).find(tool => tool.name === 'test_spec_candidate')
const runner = (((testSpecTool?.parameters as Record<string, unknown>).properties as Record<string, unknown>)
  .spec as Record<string, unknown>).properties as Record<string, unknown>
const runnerEnum = (runner.runner as Record<string, unknown>).enum as readonly string[]
if (runnerEnum.includes('smoke')) throw new Error('dynamic TestSpec schema exposes smoke')

if (!reproductionInject.includes('geoResearchProjects')
  || !reproductionInject.includes('geoResearchRuns')
  || !delegationInject.includes('geoResearchReproduction')) {
  throw new Error('Phase 4 service and Host report commit injection boundaries are incomplete')
}
if (typeof GeoResearchProjectService.prototype.commitRepositoryAudit !== 'function'
  || typeof GeoResearchProjectService.prototype.commitReproductionPlan !== 'function'
  || typeof GeoResearchProjectService.prototype.commitReproductionTestSpec !== 'function'
  || typeof GeoResearchProjectService.prototype.commitReproductionReport !== 'function'
  || typeof GeoResearchProjectService.prototype.commitGeneratedArtifact !== 'function'
  || typeof GeoResearchProjectService.prototype.readArtifactForTool !== 'function'
  || typeof GeoResearchRunService.prototype.testSpecCandidate !== 'function'
  || typeof GeoResearchRunService.prototype.bindSourceTreeInspector !== 'function') {
  throw new Error('Project or Run Service lacks a Phase 4 Host API')
}

const provider = new GitRepositoryProvider()
try {
  if (provider.capability.providerId !== 'git-cli'
    || provider.capability.shell !== false
    || provider.capability.readOnlyCommands !== true) {
    throw new Error('Git Provider capability differs from the Phase 4 contract')
  }
  await provider.drain()
} finally {
  await provider.dispose()
}

const schemas = [
  ['repository-audit.schema.json', REPOSITORY_AUDIT_SCHEMA],
  ['reproduction-plan.schema.json', REPRODUCTION_PLAN_SCHEMA],
  ['reproduction-test-spec.schema.json', REPRODUCTION_TEST_SPEC_SCHEMA],
  ['reproduction-report-candidate.schema.json', REPRODUCTION_REPORT_CANDIDATE_SCHEMA],
  ['reproduction-report.schema.json', REPRODUCTION_REPORT_SCHEMA],
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
  'REPOSITORY_PROVIDER_UNAVAILABLE',
  'REPOSITORY_OUTPUT_TOO_LARGE',
  'REPOSITORY_REFERENCE_MISMATCH',
  'REPRODUCTION_PLAN_INVALID',
  'REPRODUCTION_REPORT_INVALID',
  'REPRODUCTION_BASELINE_MODIFIED',
] as const) {
  if (!ERROR_CODES.includes(code)) throw new Error(`Phase 4 error code is missing: ${code}`)
}

const bundleManifest = JSON.parse(
  await readFile(resolve(root, 'packages', 'bundle', 'package.json'), 'utf8'),
) as { readonly exports?: Record<string, unknown>; readonly dependencies?: Record<string, unknown> }
if (bundleManifest.exports?.['./phase4-probe'] === undefined
  || bundleManifest.dependencies?.['@georesearch/dsh-repository-providers'] === undefined
  || bundleManifest.dependencies?.['@georesearch/dsh-reproduction-service'] === undefined) {
  throw new Error('bundle does not publish the Phase 4 runtime surface')
}

await readFile(resolve(root, 'docs', 'phase4-gate.md'), 'utf8')
process.stdout.write(`${JSON.stringify({
  phase3Complete: true,
  phase4Complete: true,
  reproductionTools: modelTools.length,
  schemas: schemas.length,
  repositoryProvider: provider.capability.providerId,
  hostOnlyReportCommit: true,
  dynamicSmokeExcluded: true,
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
