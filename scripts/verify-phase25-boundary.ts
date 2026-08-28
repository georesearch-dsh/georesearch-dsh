import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'
import {
  GENERIC_ATTACHMENT_LIMITS,
  INSPECTABLE_ATTACHMENT_ARCHIVE_FORMATS,
  PHASE25_ATTACHMENT_TOOLS,
  PHASE25_REQUIRED_TOOLS,
  READABLE_ATTACHMENT_STRATEGIES,
  RECOGNIZED_ATTACHMENT_ARCHIVE_FORMATS,
  STORED_ATTACHMENT_ARCHIVE_FORMATS,
} from '@georesearch/dsh-contracts'
import {
  DEEPSEEK_VISION_MODEL,
  FILE_API_PATH,
  fileTools,
  inject as fileInject,
} from '../packages/file-service/lib/index.js'
import { WORKSPACE_PACKAGES } from './workspace-packages.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const JsType = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: value => value ?? '',
})
const schema = DEFAULT_SCHEMA.extend([JsType])

if (!WORKSPACE_PACKAGES.some(entry => entry.name === '@georesearch/dsh-file-service')) {
  throw new Error('Phase 2.5 file-service package is missing')
}
const bundleSource = await readFile(resolve(root, 'packages', 'bundle', 'cordis.patch.yml'), 'utf8')
const rows = compositionRows(load(bundleSource, { schema }) as unknown)
const byId = new Map(rows.map(row => [String(row.id), row]))
const projectRow = byId.get('georesearch-project-service')
const fileRow = byId.get('georesearch-file-service')
const runRow = byId.get('georesearch-run-service')
if (fileRow?.name !== '@georesearch/dsh-file-service'
  || rows.indexOf(fileRow) <= rows.indexOf(projectRow!)
  || rows.indexOf(runRow!) <= rows.indexOf(fileRow)) {
  throw new Error('file-service must be composed between Project and Run services')
}
const fileConfig = fileRow.config as Record<string, unknown> | undefined
if (fileConfig?.visionCredentialRef !== 'DEEPSEEK_API_KEY'
  || fileConfig.visionTimeoutMs !== 120_000
  || fileConfig.visionMaxOutputTokens !== 4_096) {
  throw new Error('file-service DeepSeek visual analysis configuration is not pinned')
}
const probeRow = byId.get('georesearch-phase25-probe')
if (probeRow?.name !== '@georesearch/dsh-bundle/phase25-probe'
  || typeof probeRow.disabled !== 'string'
  || !probeRow.disabled.includes('GEORESEARCH_PHASE25_PROBE_REPORT')) {
  throw new Error('Phase 2.5 runtime probe is missing or not normally disabled')
}
const policy = byId.get('georesearch-policy')?.config as Record<string, unknown> | undefined
if (policy?.strictCatalog !== true
  || !['phase2', 'phase3', 'phase4', 'phase5', 'phase6', 'full'].includes(String(policy.capabilityStage))) {
  throw new Error('Phase 2.5 foundation requires a strict Phase 2 or Phase 3 policy catalog')
}

const toolNames = fileTools({} as never, {} as never).map(tool => tool.name).sort()
if (JSON.stringify(toolNames) !== JSON.stringify([...PHASE25_ATTACHMENT_TOOLS].sort())) {
  throw new Error('file-service tool registration differs from the Phase 2.5 contract')
}
for (const actor of ['coordinator', 'literature', 'experiment', 'reviewer'] as const) {
  const allowlist = new Set<string>(PHASE25_REQUIRED_TOOLS[actor])
  if (PHASE25_ATTACHMENT_TOOLS.some(toolName => !allowlist.has(toolName))) {
    throw new Error(`${actor} is missing an attachment tool`)
  }
}
const writing = new Set<string>(PHASE25_REQUIRED_TOOLS.writing)
if (PHASE25_ATTACHMENT_TOOLS.some(toolName => writing.has(toolName))) {
  throw new Error('writing role bypasses the approved writing packet boundary')
}
if (FILE_API_PATH !== '/api/georesearch/files/v1'
  || GENERIC_ATTACHMENT_LIMITS.maxFilesPerBatch !== 32
  || GENERIC_ATTACHMENT_LIMITS.maxFileBytes !== 256 * 1024 * 1024
  || GENERIC_ATTACHMENT_LIMITS.maxBatchBytes !== 512 * 1024 * 1024) {
  throw new Error('Phase 2.5 upload protocol limits changed unexpectedly')
}
if (!fileInject.includes('credentials') || DEEPSEEK_VISION_MODEL !== 'deepseek-v4-flash-vision-exp') {
  throw new Error('automatic DeepSeek visual analysis is not wired into the file service')
}
if (JSON.stringify(INSPECTABLE_ATTACHMENT_ARCHIVE_FORMATS) !== JSON.stringify(['zip', 'tar', 'tar.gz'])
  || JSON.stringify(STORED_ATTACHMENT_ARCHIVE_FORMATS) !== JSON.stringify(INSPECTABLE_ATTACHMENT_ARCHIVE_FORMATS)
  || RECOGNIZED_ATTACHMENT_ARCHIVE_FORMATS.length !== 7) {
  throw new Error('Phase 2.5 archive support boundary changed unexpectedly')
}
if (JSON.stringify(READABLE_ATTACHMENT_STRATEGIES) !== JSON.stringify(['direct-text', 'document', 'data', 'image', 'archive'])) {
  throw new Error('Phase 2.5 readable upload strategy boundary changed unexpectedly')
}

const bundleManifest = JSON.parse(
  await readFile(resolve(root, 'packages', 'bundle', 'package.json'), 'utf8'),
) as { readonly exports?: Record<string, unknown> }
if (bundleManifest.exports?.['./phase25-probe'] === undefined) {
  throw new Error('bundle does not export its Phase 2.5 runtime probe')
}
const fileManifest = JSON.parse(
  await readFile(resolve(root, 'packages', 'file-service', 'package.json'), 'utf8'),
) as {
  readonly exports?: Record<string, unknown>
  readonly dsh?: { readonly client?: { readonly platform?: unknown; readonly inject?: unknown } }
  readonly peerDependencies?: Readonly<Record<string, string>>
}
if (fileManifest.exports?.['./client'] === undefined
  || fileManifest.dsh?.client?.platform !== 'web'
  || !Array.isArray(fileManifest.dsh.client.inject)
  || fileManifest.peerDependencies?.['@deepseek-ai/dsh-credentials'] !== '0.1.0-rc.5') {
  throw new Error('file-service client entry is not declared for the Harness Web client')
}
const clientBundle = await stat(resolve(root, 'packages', 'file-service', 'lib', 'client.cjs'))
if (!clientBundle.isFile() || clientBundle.size < 1 || clientBundle.size > 128 * 1024) {
  throw new Error(`file-service client bundle size is invalid: ${clientBundle.size}`)
}

await readFile(resolve(root, 'docs', 'phase2.5-gate.md'), 'utf8')
process.stdout.write(`${JSON.stringify({
  phase2Complete: true,
  phase2_5Complete: true,
  phase3Started: policy.capabilityStage !== 'phase2',
  attachmentTools: PHASE25_ATTACHMENT_TOOLS.length,
  readableStrategies: READABLE_ATTACHMENT_STRATEGIES.length,
  inspectableArchiveFormats: INSPECTABLE_ATTACHMENT_ARCHIVE_FORMATS.length,
  recognizedArchiveFormats: RECOGNIZED_ATTACHMENT_ARCHIVE_FORMATS.length,
  storedArchiveFormats: STORED_ATTACHMENT_ARCHIVE_FORMATS.length,
  maxFilesPerBatch: GENERIC_ATTACHMENT_LIMITS.maxFilesPerBatch,
  automaticVisionModel: DEEPSEEK_VISION_MODEL,
  clientBundleBytes: clientBundle.size,
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
