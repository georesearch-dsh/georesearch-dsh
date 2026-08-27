import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DSH_STANDARD_ADAPTER_VERSION,
  DSH_STANDARD_MANIFEST_VERSION,
  DSH_STANDARD_SCHEMA_URI,
  DSH_STANDARD_TOOL_API_VERSION,
  DSH_STANDARD_TOOL_OVERRIDE_KIND,
  GEORESEARCH_STANDARD_TOOL_TARGETS,
  standardToolContributionId,
  standardToolOverrideDescription,
} from '../packages/bundle/src/standard-catalog.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const bundleRoot = join(root, 'packages', 'bundle')
const packageManifest = JSON.parse(
  await readFile(join(bundleRoot, 'package.json'), 'utf8'),
) as { readonly version?: unknown }
if (typeof packageManifest.version !== 'string') {
  throw new Error('@georesearch/dsh-bundle has no package version')
}

const manifest = {
  $schema: DSH_STANDARD_SCHEMA_URI,
  manifestVersion: DSH_STANDARD_MANIFEST_VERSION,
  id: 'org.deepseek.georesearch',
  name: 'GeoResearch for DeepSeek Harness',
  version: packageManifest.version,
  facets: {
    host: {
      entry: 'lib/standard-facet.js',
      apiVersion: 'v1alpha1',
    },
  },
  permissions: [
    {
      name: 'storage.local',
      scope: 'component',
      reason: 'Persist project, artifact, run, evidence, validation, claim, and writing records.',
    },
    {
      name: 'messages.observe',
      scope: 'owned-sessions',
      reason: 'Maintain role and delegation policy for GeoResearch-owned Agent sessions.',
    },
    {
      name: 'x-georesearch.fs.workspace-read',
      scope: 'workspace',
      reason: 'Inspect user-selected research data, papers, repositories, and generated artifacts.',
    },
    {
      name: 'x-georesearch.fs.workspace-write',
      scope: 'workspace',
      reason: 'Write approved run outputs and deliverables through Host-enforced workspace policy.',
    },
    {
      name: 'x-georesearch.net.crossref',
      scope: 'https://api.crossref.org',
      reason: 'Run bounded bibliographic searches and replay-safe continuation requests.',
    },
    {
      name: 'x-georesearch.net.source-read',
      scope: 'https',
      reason: 'Read user-requested public papers, repositories, and scientific datasets.',
    },
    {
      name: 'x-georesearch.process.git-readonly',
      scope: 'workspace',
      reason: 'Audit source repositories using the bounded read-only Git provider.',
    },
    {
      name: 'x-georesearch.process.python-worker',
      scope: 'managed-worker',
      reason: 'Run the persistent bounded geospatial worker and approved experiment candidates.',
    },
    {
      name: 'x-georesearch.credentials.deepseek',
      scope: 'DEEPSEEK_API_KEY',
      reason: 'Resolve the Host-managed credential for bounded DeepSeek vision analysis.',
    },
  ],
  contributes: {
    'x-org.deepseek.georesearch.extensions': GEORESEARCH_STANDARD_TOOL_TARGETS.map(target => ({
      id: standardToolContributionId(target),
      apiVersion: DSH_STANDARD_TOOL_API_VERSION,
      kind: DSH_STANDARD_TOOL_OVERRIDE_KIND,
      name: target,
      spec: {
        target,
        executionOnly: true,
        description: standardToolOverrideDescription(target),
      },
    })),
  },
  license: 'MIT',
  compat: {
    hosts: [
      'deepseek-harness@0.1.0-rc.5',
      `@dsh-std/adapter-dsh@${DSH_STANDARD_ADAPTER_VERSION}`,
    ],
  },
  overrides: [
    {
      target: '@deepseek-ai/dsh-profile/cordis.patch.yml',
      kind: 'patch',
      description: 'Compose the existing GeoResearch rc.5 product services and bootstrap the DSH Standard adapter.',
    },
    {
      target: '@deepseek-ai/dsh-tools/agent-scoped-tool-view',
      kind: 'patch',
      description: 'Apply role-filtered GeoResearch tools and the read_image specialization through Harness policy.',
    },
    {
      target: '@deepseek-ai/dsh-session/telemetry',
      kind: 'patch',
      description: 'Disable unredacted rc.5 session telemetry for the managed research profile.',
    },
  ],
}

const output = `${JSON.stringify(manifest, undefined, 2)}\n`
const outputPath = join(bundleRoot, 'dsh-plugin.json')
if (process.argv.includes('--check')) {
  const current = await readFile(outputPath, 'utf8').catch(() => '')
  if (current !== output) {
    throw new Error('packages/bundle/dsh-plugin.json is stale; run pnpm dsh-std:sync')
  }
} else {
  await writeFile(outputPath, output, 'utf8')
  process.stdout.write(`${outputPath}\n`)
}
