import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseManifest, projectManifest } from '@dsh-std/manifest'
import {
  createDshManifestCatalog,
  createDshProtocolCatalog,
} from '@dsh-std/adapter-dsh'
import {
  DELEGATION_BOOTSTRAP_TOOL,
  DELEGATION_TOOL_NAMES,
} from '@georesearch/dsh-contracts'
import {
  DSH_STANDARD_ADAPTER_VERSION,
  DSH_STANDARD_AUDIT_REVISION,
  DSH_STANDARD_DIRECT_PACKAGE_VERSIONS,
  DSH_STANDARD_MANIFEST_SCHEMA_CANONICAL_SHA256,
  DSH_STANDARD_MANIFEST_VERSION,
  DSH_STANDARD_SCHEMA_URI,
  GEORESEARCH_STANDARD_TOOL_TARGETS,
} from '../packages/bundle/src/standard-catalog.ts'
import { phase2HostToolNames } from '../packages/bundle/src/phase2-probe.ts'
import { phase25HostToolNames } from '../packages/bundle/src/phase25-probe.ts'
import { phase3HostToolNames } from '../packages/bundle/src/phase3-probe.ts'
import { phase4HostToolNames } from '../packages/bundle/src/phase4-probe.ts'
import { phase5HostToolNames } from '../packages/bundle/src/phase5-probe.ts'
import { phase6HostToolNames } from '../packages/bundle/src/phase6-probe.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const bundleRoot = join(root, 'packages', 'bundle')
const portable = parseManifest(
  await readFile(join(bundleRoot, 'dsh-plugin.json'), 'utf8'),
  { source: 'packages/bundle/dsh-plugin.json' },
)
const projected = projectManifest(portable)
const report = createDshManifestCatalog().validate(projected, createDshProtocolCatalog(), {
  source: 'packages/bundle/dsh-plugin.json',
})
if (!report.compatible || report.issues.length !== 0) {
  throw new Error(`DSH Standard manifest validation failed: ${JSON.stringify(report.issues)}`)
}
if (portable.manifestVersion !== DSH_STANDARD_MANIFEST_VERSION) {
  throw new Error('DSH Standard manifest version drifted')
}
if (portable.$schema !== DSH_STANDARD_SCHEMA_URI) {
  throw new Error('DSH Standard schema identifier drifted from the audited immutable source')
}

const manifestSchemaPath = fileURLToPath(
  import.meta.resolve('@dsh-std/manifest/schema/dsh-plugin-0.15.schema.json'),
)
const manifestSchema = JSON.parse(await readFile(manifestSchemaPath, 'utf8')) as unknown
const manifestSchemaDigest = createHash('sha256')
  .update(JSON.stringify(manifestSchema))
  .digest('hex')
if (manifestSchemaDigest !== DSH_STANDARD_MANIFEST_SCHEMA_CANONICAL_SHA256) {
  throw new Error('installed DSH Standard manifest schema differs from the audited revision')
}

const expectedTools = [...new Set([
  ...phase2HostToolNames(),
  ...phase25HostToolNames(),
  ...phase3HostToolNames(),
  ...phase4HostToolNames(),
  ...phase5HostToolNames(),
  ...phase6HostToolNames(),
  ...DELEGATION_TOOL_NAMES,
  DELEGATION_BOOTSTRAP_TOOL,
])].sort()
if (JSON.stringify(expectedTools) !== JSON.stringify([...GEORESEARCH_STANDARD_TOOL_TARGETS])) {
  throw new Error('DSH Standard ToolOverride catalog differs from the authoritative GeoResearch tool catalog')
}

const adapterSource = await readFile(join(bundleRoot, 'lib', 'standard-adapter.js'), 'utf8')
const facetSource = await readFile(join(bundleRoot, 'lib', 'standard-facet.js'), 'utf8')
const unresolvedStandardImport = /(?:from\s*|import\s*\(|require\s*\()\s*["']@dsh-std\//u
if (unresolvedStandardImport.test(adapterSource) || unresolvedStandardImport.test(facetSource)) {
  throw new Error('release bundle still depends on an external @dsh-std runtime package')
}
const portableFacetSources = await Promise.all([
  readFile(join(bundleRoot, 'src', 'standard-facet.ts'), 'utf8'),
  readFile(join(bundleRoot, 'src', 'standard-catalog.ts'), 'utf8'),
])
const productRuntimeImport = /(?:@deepseek-ai\/|from\s*["'][^"']*cordis|import\s*\(\s*["'][^"']*cordis)/u
if (portableFacetSources.some(source => productRuntimeImport.test(source))) {
  throw new Error('portable DSH Standard facet imports a product runtime API')
}

const bundleManifest = JSON.parse(
  await readFile(join(bundleRoot, 'package.json'), 'utf8'),
) as {
  readonly files?: readonly string[]
  readonly exports?: Readonly<Record<string, unknown>>
}
const rootManifest = JSON.parse(
  await readFile(join(root, 'package.json'), 'utf8'),
) as { readonly devDependencies?: Readonly<Record<string, string>> }
for (const [packageName, expectedVersion] of Object.entries(DSH_STANDARD_DIRECT_PACKAGE_VERSIONS)) {
  if (rootManifest.devDependencies?.[packageName] !== expectedVersion) {
    throw new Error(`${packageName} is not pinned to the audited release line`)
  }
  const entryPath = fileURLToPath(import.meta.resolve(packageName))
  const installedManifest = JSON.parse(
    await readFile(resolve(dirname(entryPath), '..', 'package.json'), 'utf8'),
  ) as { readonly version?: unknown }
  if (installedManifest.version !== expectedVersion) {
    throw new Error(`${packageName} installed version differs from package.json`)
  }
}
if (!bundleManifest.files?.includes('dsh-plugin.json')
  || bundleManifest.exports?.['./standard-adapter'] === undefined
  || bundleManifest.exports?.['./standard-facet'] === undefined
  || rootManifest.devDependencies?.['@dsh-std/adapter-dsh'] !== DSH_STANDARD_ADAPTER_VERSION) {
  throw new Error('bundle package metadata does not publish the DSH Standard boundary')
}
const patch = await readFile(join(bundleRoot, 'cordis.patch.yml'), 'utf8')
if (!patch.includes("name: '@georesearch/dsh-bundle/standard-adapter'")
  || !patch.includes('profileBaseUrl: !!js ctx.baseUrl')) {
  throw new Error('Cordis bundle does not bootstrap the DSH Standard adapter')
}

process.stdout.write(`${JSON.stringify({
  compatible: true,
  auditRevision: DSH_STANDARD_AUDIT_REVISION,
  manifestVersion: portable.manifestVersion,
  adapterVersion: DSH_STANDARD_ADAPTER_VERSION,
  directPackages: DSH_STANDARD_DIRECT_PACKAGE_VERSIONS,
  schema: {
    uri: DSH_STANDARD_SCHEMA_URI,
    canonicalSha256: manifestSchemaDigest,
  },
  component: portable.id,
  facet: 'host',
  toolOverrides: expectedTools.length,
  externalStandardRuntimeImports: 0,
  portableFacetProductImports: 0,
}, undefined, 2)}\n`)
