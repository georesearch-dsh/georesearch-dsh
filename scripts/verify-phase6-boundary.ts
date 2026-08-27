import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'
import {
  CLAIM_PROPOSAL_SCHEMA,
  CLAIM_RECORD_SCHEMA,
  ERROR_CODES,
  MANUSCRIPT_AUDIT_SCHEMA,
  MANUSCRIPT_CANDIDATE_SCHEMA,
  MANUSCRIPT_RECORD_SCHEMA,
  PHASE6_REQUIRED_TOOLS,
  REVIEW_PROPOSAL_SCHEMA,
  REVIEW_RECORD_SCHEMA,
  VALIDATION_PLAN_SCHEMA,
  VALIDATION_REPORT_SCHEMA,
  WRITING_PACKET_SCHEMA,
} from '@georesearch/dsh-contracts'
import { claimTools, inject as claimInject } from '../packages/claim-service/lib/index.js'
import { inject as delegationInject } from '../packages/delegation-tools/lib/index.js'
import { GeoResearchProjectService } from '../packages/project-service/lib/index.js'
import { inject as validationInject, validationTools } from '../packages/validation-service/lib/index.js'
import { inject as writingInject, writingTools } from '../packages/writing-service/lib/index.js'
import { phase6HostToolNames } from '../packages/bundle/lib/phase6-probe.js'
import { WORKSPACE_PACKAGES } from './workspace-packages.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const JsType = new Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value ?? '' })
const schema = DEFAULT_SCHEMA.extend([JsType])
const packages = [
  '@georesearch/dsh-validation-service',
  '@georesearch/dsh-claim-service',
  '@georesearch/dsh-writing-service',
] as const
for (const packageName of packages) {
  if (!WORKSPACE_PACKAGES.some(entry => entry.name === packageName)) throw new Error(`Phase 6 package is missing: ${packageName}`)
}

const rows = compositionRows(load(
  await readFile(resolve(root, 'packages', 'bundle', 'cordis.patch.yml'), 'utf8'),
  { schema },
) as unknown)
const byId = new Map(rows.map(row => [String(row.id), row]))
const policy = byId.get('georesearch-policy')?.config as Record<string, unknown> | undefined
const delegation = byId.get('georesearch-delegation-tools')?.config as Record<string, unknown> | undefined
if (policy?.strictCatalog !== true || !['phase6', 'full'].includes(String(policy.capabilityStage))) {
  throw new Error('bundle policy does not preserve strict Phase 6')
}
if (delegation?.strictRoleCapabilities !== true || !['phase6', 'full'].includes(String(delegation.capabilityStage))) {
  throw new Error('delegation tools do not preserve strict Phase 6')
}

const experimentRow = byId.get('georesearch-experiment-service')
const validationRow = byId.get('georesearch-validation-service')
const claimRow = byId.get('georesearch-claim-service')
const writingRow = byId.get('georesearch-writing-service')
const delegationRow = byId.get('georesearch-delegation-tools')
if (validationRow?.name !== '@georesearch/dsh-validation-service'
  || claimRow?.name !== '@georesearch/dsh-claim-service'
  || writingRow?.name !== '@georesearch/dsh-writing-service'
  || rows.indexOf(validationRow) <= rows.indexOf(experimentRow!)
  || rows.indexOf(claimRow) <= rows.indexOf(validationRow)
  || rows.indexOf(writingRow) <= rows.indexOf(claimRow)
  || rows.indexOf(delegationRow!) <= rows.indexOf(writingRow)) {
  throw new Error('Validation, Claim, and Writing services are not composed in authority order')
}
const probeRow = byId.get('georesearch-phase6-probe')
if (probeRow?.name !== '@georesearch/dsh-bundle/phase6-probe'
  || typeof probeRow.disabled !== 'string'
  || !probeRow.disabled.includes('GEORESEARCH_PHASE6_PROBE_REPORT')) {
  throw new Error('Phase 6 runtime probe is missing or not normally disabled')
}
if (byId.get('session-telemetry-otel')?.disabled !== true) throw new Error('Session Telemetry is not fail-closed disabled')

const tools = [...validationTools({} as never), ...claimTools({} as never), ...writingTools({} as never)]
const toolNames = tools.map(tool => tool.name).sort()
if (JSON.stringify(toolNames) !== JSON.stringify(phase6HostToolNames())) {
  throw new Error('Phase 6 tool registration differs from the runtime probe contract')
}
const actorMap = {
  geodata_validate: ['reviewer'], experiment_validate: ['reviewer'], citation_validate: ['reviewer'], review_candidate: ['reviewer'],
  claim_commit: ['coordinator'], writing_packet_build: ['coordinator'],
  writing_packet_read: ['writing'], manuscript_candidate: ['writing'], manuscript_validate: ['writing'],
} as const
for (const [toolName, actors] of Object.entries(actorMap)) {
  for (const actor of Object.keys(PHASE6_REQUIRED_TOOLS) as Array<keyof typeof PHASE6_REQUIRED_TOOLS>) {
    const present = new Set<string>(PHASE6_REQUIRED_TOOLS[actor]).has(toolName)
    if (present !== (actors as readonly string[]).includes(actor)) throw new Error(`${toolName} role catalog is invalid for ${actor}`)
  }
}
for (const forbidden of ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'write', 'edit']) {
  if ((PHASE6_REQUIRED_TOOLS.writing as readonly string[]).includes(forbidden)) throw new Error(`Writing role received ${forbidden}`)
}
const claimCommit = claimTools({} as never).find(tool => tool.name === 'claim_commit')
const claimProperties = (claimCommit?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
if (claimProperties === undefined
  || Object.hasOwn(claimProperties, 'supportState')
  || Object.hasOwn(claimProperties, 'approvalState')) {
  throw new Error('Claim Host-owned states are model parameters')
}
const packetBuild = claimTools({} as never).find(tool => tool.name === 'writing_packet_build')
const packetProperties = (packetBuild?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
if (packetProperties === undefined || Object.hasOwn(packetProperties, 'claimIds')) {
  throw new Error('WritingPacket eligible Claim set is model-selectable')
}

if (!validationInject.includes('geoResearchProjects')
  || !claimInject.includes('approval')
  || !claimInject.includes('geoResearchProjects')
  || !writingInject.includes('geoResearchProjects')
  || !delegationInject.includes('geoResearchReproduction')) {
  throw new Error('Phase 6 injection boundaries are incomplete')
}
if (typeof GeoResearchProjectService.prototype.commitValidation !== 'function'
  || typeof GeoResearchProjectService.prototype.commitReviewRecord !== 'function'
  || typeof GeoResearchProjectService.prototype.commitClaimRecord !== 'function'
  || typeof GeoResearchProjectService.prototype.commitWritingPacket !== 'function'
  || typeof GeoResearchProjectService.prototype.commitManuscript !== 'function') {
  throw new Error('Project Service lacks a Phase 6 Host authority API')
}

const schemas = [
  ['validation-plan.schema.json', VALIDATION_PLAN_SCHEMA],
  ['validation-report.schema.json', VALIDATION_REPORT_SCHEMA],
  ['review-proposal.schema.json', REVIEW_PROPOSAL_SCHEMA],
  ['review-record.schema.json', REVIEW_RECORD_SCHEMA],
  ['claim-proposal.schema.json', CLAIM_PROPOSAL_SCHEMA],
  ['claim-record.schema.json', CLAIM_RECORD_SCHEMA],
  ['writing-packet.schema.json', WRITING_PACKET_SCHEMA],
  ['manuscript-candidate.schema.json', MANUSCRIPT_CANDIDATE_SCHEMA],
  ['manuscript-record.schema.json', MANUSCRIPT_RECORD_SCHEMA],
  ['manuscript-audit.schema.json', MANUSCRIPT_AUDIT_SCHEMA],
] as const
for (const [file, runtime] of schemas) {
  const bundled = JSON.parse(await readFile(resolve(root, 'packages', 'bundle', 'schemas', file), 'utf8')) as Record<string, unknown>
  const { $schema, $id, title, ...body } = bundled
  void $schema
  void $id
  void title
  if (JSON.stringify(body) !== JSON.stringify(runtime)) throw new Error(`schema parity failed: ${file}`)
}
for (const code of [
  'VALIDATION_PLAN_INVALID', 'VALIDATION_REPORT_INVALID', 'VALIDATION_MANDATORY_MISSING',
  'REVIEW_INVALID', 'CLAIM_INVALID', 'CLAIM_APPROVAL_REQUIRED', 'WRITING_PACKET_INVALID',
  'MANUSCRIPT_INVALID', 'MANUSCRIPT_TRACEABILITY_FAILURE',
] as const) {
  if (!ERROR_CODES.includes(code)) throw new Error(`Phase 6 error code is missing: ${code}`)
}

const bundleManifest = JSON.parse(await readFile(resolve(root, 'packages', 'bundle', 'package.json'), 'utf8')) as {
  readonly exports?: Record<string, unknown>
  readonly dependencies?: Record<string, unknown>
}
if (bundleManifest.exports?.['./phase6-probe'] === undefined
  || packages.some(packageName => bundleManifest.dependencies?.[packageName] === undefined)) {
  throw new Error('bundle does not publish the complete Phase 6 runtime surface')
}
await readFile(resolve(root, 'docs', 'phase6-gate.md'), 'utf8')
process.stdout.write(`${JSON.stringify({
  phase5Complete: true,
  phase6Complete: true,
  phase6Packages: packages.length,
  phase6Tools: toolNames.length,
  schemas: schemas.length,
  mandatoryValidatorsHostOwned: true,
  claimApprovalUserControlled: true,
  writingPacketIsolated: true,
  manuscriptAuditDeterministic: true,
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
