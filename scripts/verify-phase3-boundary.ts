import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'
import {
  CONTINUATION_ADVANCE_OUTCOME_SCHEMA,
  ERROR_CODES,
  EVIDENCE_CANDIDATE_SCHEMA,
  EVIDENCE_RECORD_SCHEMA,
  LITERATURE_CONTINUATION_RECORD_SCHEMA,
  LITERATURE_SEARCH_REQUEST_SCHEMA,
  LITERATURE_SEARCH_RESULT_SCHEMA,
  PAPER_READ_RESULT_SCHEMA,
  PHASE3_LITERATURE_TOOLS,
  PHASE3_REQUIRED_TOOLS,
  SOURCE_RECORD_SCHEMA,
} from '@georesearch/dsh-contracts'
import { inject as delegationInject } from '../packages/delegation-tools/lib/index.js'
import { evidenceTools, inject as evidenceInject } from '../packages/evidence-service/lib/index.js'
import { CrossrefLiteratureProvider } from '../packages/evidence-providers/lib/index.js'
import { GeoResearchProjectService } from '../packages/project-service/lib/index.js'
import { phase3HostToolNames } from '../packages/bundle/lib/phase3-probe.js'
import { WORKSPACE_PACKAGES } from './workspace-packages.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const JsType = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: value => value ?? '',
})
const schema = DEFAULT_SCHEMA.extend([JsType])

for (const packageName of [
  '@georesearch/dsh-evidence-providers',
  '@georesearch/dsh-evidence-service',
]) {
  if (!WORKSPACE_PACKAGES.some(entry => entry.name === packageName)) {
    throw new Error(`Phase 3 package is missing: ${packageName}`)
  }
}

const bundleSource = await readFile(resolve(root, 'packages', 'bundle', 'cordis.patch.yml'), 'utf8')
const rows = compositionRows(load(bundleSource, { schema }) as unknown)
const byId = new Map(rows.map(row => [String(row.id), row]))
const policy = byId.get('georesearch-policy')?.config as Record<string, unknown> | undefined
const delegation = byId.get('georesearch-delegation-tools')?.config as Record<string, unknown> | undefined
if (policy?.strictCatalog !== true
  || !['phase3', 'phase4', 'phase5', 'phase6', 'full'].includes(String(policy.capabilityStage))) {
  throw new Error('bundle policy does not preserve strict Phase 3')
}
if (delegation?.strictRoleCapabilities !== true
  || !['phase3', 'phase4', 'phase5', 'phase6', 'full'].includes(String(delegation.capabilityStage))) {
  throw new Error('delegation tools do not preserve strict Phase 3')
}

const projectRow = byId.get('georesearch-project-service')
const fileRow = byId.get('georesearch-file-service')
const evidenceRow = byId.get('georesearch-evidence-service')
const runRow = byId.get('georesearch-run-service')
if (evidenceRow?.name !== '@georesearch/dsh-evidence-service'
  || rows.indexOf(evidenceRow) <= rows.indexOf(projectRow!)
  || rows.indexOf(evidenceRow) <= rows.indexOf(fileRow!)
  || rows.indexOf(runRow!) <= rows.indexOf(evidenceRow)) {
  throw new Error('Evidence Service must be composed after Project/File and before Run')
}
const phase3ProbeRow = byId.get('georesearch-phase3-probe')
if (phase3ProbeRow?.name !== '@georesearch/dsh-bundle/phase3-probe'
  || typeof phase3ProbeRow.disabled !== 'string'
  || !phase3ProbeRow.disabled.includes('GEORESEARCH_PHASE3_PROBE_REPORT')) {
  throw new Error('Phase 3 runtime probe is missing or not normally disabled')
}
if (byId.get('session-telemetry-otel')?.disabled !== true) {
  throw new Error('Session Telemetry is not fail-closed disabled')
}
const web = byId.get('tool-web')
if (web?.disabled !== false || (web.config as Record<string, unknown> | undefined)?.fetch !== false) {
  throw new Error('Literature web_search must be enabled without an unbacked web_fetch tool')
}
for (const toolName of ['write', 'edit', 'web_search', 'web_fetch'] as const) {
  if ((PHASE3_REQUIRED_TOOLS.coordinator as readonly string[]).includes(toolName)) {
    throw new Error(`Phase 3 coordinator received specialist-only tool ${toolName}`)
  }
}
for (const toolName of ['write', 'edit'] as const) {
  if (!(PHASE3_REQUIRED_TOOLS.experiment as readonly string[]).includes(toolName)) {
    throw new Error(`Phase 3 experiment role is missing ${toolName}`)
  }
}
if (!(PHASE3_REQUIRED_TOOLS.literature as readonly string[]).includes('web_search')) {
  throw new Error('Phase 3 literature role is missing web_search')
}
if ((PHASE3_REQUIRED_TOOLS.literature as readonly string[]).includes('web_fetch')) {
  throw new Error('Phase 3 literature role requires an unavailable web_fetch provider')
}

const modelTools = evidenceTools({} as never).map(tool => tool.name).sort()
if (JSON.stringify(modelTools) !== JSON.stringify([...PHASE3_LITERATURE_TOOLS].sort())
  || JSON.stringify(phase3HostToolNames()) !== JSON.stringify(modelTools)) {
  throw new Error('Phase 3 model tool registration differs from the frozen contract')
}
for (const toolName of PHASE3_LITERATURE_TOOLS) {
  if (!PHASE3_REQUIRED_TOOLS.literature.includes(toolName)) {
    throw new Error(`literature role is missing ${toolName}`)
  }
  for (const actor of ['coordinator', 'experiment', 'reviewer', 'writing'] as const) {
    if ((PHASE3_REQUIRED_TOOLS[actor] as readonly string[]).includes(toolName)) {
      throw new Error(`${actor} received literature-only tool ${toolName}`)
    }
  }
}
if (!evidenceInject.includes('credentials')
  || !evidenceInject.includes('geoResearchProjects')
  || !delegationInject.includes('geoResearchEvidence')) {
  throw new Error('Phase 3 service and Host commit injection boundaries are incomplete')
}
if (typeof GeoResearchProjectService.prototype.withVerifiedReadLease !== 'function'
  || typeof GeoResearchProjectService.prototype.commitSourceRecord !== 'function'
  || typeof GeoResearchProjectService.prototype.commitEvidenceRecord !== 'function') {
  throw new Error('Project Service lacks the Phase 3 Artifact/Source/Evidence Host APIs')
}

const provider = new CrossrefLiteratureProvider()
try {
  if (provider.capability.providerId !== 'crossref'
    || provider.capability.replaySemantics !== 'replay-safe-read'
    || !provider.capability.supportsCredentialRef
    || provider.capability.maxPageSize !== 100) {
    throw new Error('Crossref Provider capability differs from the Phase 3 contract')
  }
  await provider.drain()
} finally {
  await provider.dispose()
}

const schemas = [
  ['literature-search-request.schema.json', LITERATURE_SEARCH_REQUEST_SCHEMA],
  ['literature-search-result.schema.json', LITERATURE_SEARCH_RESULT_SCHEMA],
  ['literature-continuation.schema.json', LITERATURE_CONTINUATION_RECORD_SCHEMA],
  ['continuation-advance-outcome.schema.json', CONTINUATION_ADVANCE_OUTCOME_SCHEMA],
  ['paper-read-result.schema.json', PAPER_READ_RESULT_SCHEMA],
  ['source-record.schema.json', SOURCE_RECORD_SCHEMA],
  ['evidence-candidate.schema.json', EVIDENCE_CANDIDATE_SCHEMA],
  ['evidence-record.schema.json', EVIDENCE_RECORD_SCHEMA],
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
  'LITERATURE_CONTINUATION_RECOVERY_REQUIRED',
  'LITERATURE_PAGINATION_STALLED',
  'PDF_ARTIFACT_REQUIRED',
  'EVIDENCE_READ_RECEIPT_MISMATCH',
  'CITATION_INVALID',
] as const) {
  if (!ERROR_CODES.includes(code)) throw new Error(`Phase 3 error code is missing: ${code}`)
}

const bundleManifest = JSON.parse(
  await readFile(resolve(root, 'packages', 'bundle', 'package.json'), 'utf8'),
) as { readonly exports?: Record<string, unknown>; readonly dependencies?: Record<string, unknown> }
if (bundleManifest.exports?.['./phase3-probe'] === undefined
  || bundleManifest.dependencies?.['@georesearch/dsh-evidence-service'] === undefined
  || bundleManifest.dependencies?.['@georesearch/dsh-evidence-providers'] === undefined) {
  throw new Error('bundle does not publish the Phase 3 runtime surface')
}

await readFile(resolve(root, 'docs', 'phase3-gate.md'), 'utf8')
process.stdout.write(`${JSON.stringify({
  phase2Complete: true,
  phase2_5Complete: true,
  phase3Complete: true,
  literatureTools: modelTools.length,
  schemas: schemas.length,
  provider: provider.capability.providerId,
  hostOnlyEvidenceCommit: true,
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
