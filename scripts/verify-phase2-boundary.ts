import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'
import {
  PROJECT_SNAPSHOT_SCHEMA,
  RESEARCH_BRIEF_SCHEMA,
  RUN_RECORD_SCHEMA,
  requiredToolsFor,
  type GeoResearchActor,
} from '@georesearch/dsh-contracts'
import { WORKSPACE_PACKAGES } from './workspace-packages.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const JsType = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: value => value ?? '',
})
const schema = DEFAULT_SCHEMA.extend([JsType])
const actors: readonly GeoResearchActor[] = [
  'coordinator', 'literature', 'experiment', 'reviewer', 'writing',
]

const requiredPackages = [
  '@georesearch/dsh-project-provider-files',
  '@georesearch/dsh-project-service',
  '@georesearch/dsh-run-supervisor',
  '@georesearch/dsh-run-service',
]
for (const name of requiredPackages) {
  if (!WORKSPACE_PACKAGES.some(entry => entry.name === name)) throw new Error(`Phase 2 package is missing: ${name}`)
}
const bundleSource = await readFile(resolve(root, 'packages', 'bundle', 'cordis.patch.yml'), 'utf8')
const parsed = load(bundleSource, { schema }) as unknown
const rows = compositionRows(parsed)
const byId = new Map(rows.map(row => [String(row.id), row]))
const policy = byId.get('georesearch-policy')?.config as Record<string, unknown> | undefined
const delegation = byId.get('georesearch-delegation-tools')?.config as Record<string, unknown> | undefined
if (policy?.strictCatalog !== true
  || !['phase2', 'phase3', 'phase4', 'phase5', 'phase6', 'full'].includes(String(policy.capabilityStage))) {
  throw new Error('bundle policy does not preserve the strict Phase 2 foundation')
}
if (delegation?.strictRoleCapabilities !== true
  || !['phase2', 'phase3', 'phase4', 'phase5', 'phase6', 'full'].includes(String(delegation.capabilityStage))) {
  throw new Error('delegation tools do not preserve the strict Phase 2 foundation')
}
if (byId.get('georesearch-project-service')?.name !== '@georesearch/dsh-project-service'
  || byId.get('georesearch-run-service')?.name !== '@georesearch/dsh-run-service') {
  throw new Error('Phase 2 services are not composed')
}
if (byId.get('georesearch-phase1-probe')?.name !== '@georesearch/dsh-bundle/phase1-probe'
  || byId.get('georesearch-phase2-probe')?.name !== '@georesearch/dsh-bundle/phase2-probe') {
  throw new Error('foundation and Phase 2 runtime probes are not both composed')
}
if (byId.get('session-telemetry-otel')?.disabled !== true) {
  throw new Error('Session Telemetry is not fail-closed disabled')
}

const phase2Tools = [...new Set(actors.flatMap(actor => requiredToolsFor(actor, 'phase2')))]
const expected = [
  'research_project_status',
  'research_brief_commit',
  'artifact_commit',
  'deliverable_publish',
  'artifact_read',
  'formal_run_candidate',
  'formal_run_submit',
  'local_test_run',
  'run_status',
  'run_cancel',
  'run_record_read',
]
for (const tool of expected) {
  if (!phase2Tools.includes(tool)) throw new Error(`Phase 2 catalog is missing ${tool}`)
}

const schemas = [
  ['research-brief.schema.json', RESEARCH_BRIEF_SCHEMA],
  ['project-snapshot.schema.json', PROJECT_SNAPSHOT_SCHEMA],
  ['run-record.schema.json', RUN_RECORD_SCHEMA],
] as const
for (const [file, runtime] of schemas) {
  const bundled = JSON.parse(await readFile(resolve(root, 'packages', 'bundle', 'schemas', file), 'utf8')) as Record<string, unknown>
  const { $schema, $id, title, ...body } = bundled
  void $schema
  void $id
  void title
  if (JSON.stringify(body) !== JSON.stringify(runtime)) throw new Error(`schema parity failed: ${file}`)
}

await readFile(resolve(root, 'docs', 'phase2-gate.md'), 'utf8')
process.stdout.write(`${JSON.stringify({
  phase2Complete: true,
  phase3Started: policy.capabilityStage !== 'phase2',
  runtimePackages: requiredPackages.length,
  phase2Tools: expected.length,
  schemas: schemas.length,
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
