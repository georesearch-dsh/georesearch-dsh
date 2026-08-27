import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  PRODUCT_VERSION,
  digestTree,
  isSha256Digest,
  type Sha256Digest,
} from '@georesearch/dsh-contracts'

export const RUNTIME_PACKAGE_NAMES = [
  '@georesearch/dsh-contracts',
  '@georesearch/dsh-provider-lifecycle',
  '@georesearch/dsh-repository-providers',
  '@georesearch/dsh-compat-rc5',
  '@georesearch/dsh-installation-guard',
  '@georesearch/dsh-runtime-lease',
  '@georesearch/dsh-policy',
  '@georesearch/dsh-project-provider-files',
  '@georesearch/dsh-project-service',
  '@georesearch/dsh-file-service',
  '@georesearch/dsh-evidence-providers',
  '@georesearch/dsh-evidence-service',
  '@georesearch/dsh-run-supervisor',
  '@georesearch/dsh-run-service',
  '@georesearch/dsh-reproduction-service',
  '@georesearch/dsh-geospatial-provider-python',
  '@georesearch/dsh-geospatial-service',
  '@georesearch/dsh-experiment-service',
  '@georesearch/dsh-validation-service',
  '@georesearch/dsh-claim-service',
  '@georesearch/dsh-writing-service',
  '@georesearch/dsh-delegation-tools',
  '@georesearch/dsh-prompt',
  '@georesearch/dsh-agent-lifecycle',
  '@georesearch/dsh-bundle',
] as const

export interface DistributionPackage {
  readonly name: string
  readonly version: string
  readonly directory: string
  readonly treeDigest: Sha256Digest
}

export interface DistributionManifest {
  readonly schemaVersion: 1
  readonly productVersion: string
  readonly packages: readonly DistributionPackage[]
  readonly presetDirectory: string
  readonly presetTreeDigest: Sha256Digest
  readonly pythonDirectory: string
  readonly pythonTreeDigest: Sha256Digest
  readonly createdAt: string
}

export interface LoadedDistribution {
  readonly root: string
  readonly manifest: DistributionManifest
  readonly packageDirectories: ReadonlyMap<string, string>
  readonly presetRoot: string
  readonly pythonRoot: string
}

export async function loadDistribution(root: string): Promise<LoadedDistribution> {
  const absoluteRoot = resolve(root)
  const raw = JSON.parse(await readFile(join(absoluteRoot, 'distribution-manifest.json'), 'utf8')) as unknown
  const manifest = parseManifest(raw)
  const packages = new Map<string, string>()
  for (const entry of manifest.packages) {
    const directory = resolveContained(absoluteRoot, entry.directory)
    const packageJson = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as Record<string, unknown>
    if (packageJson.name !== entry.name || packageJson.version !== entry.version) {
      throw new Error(`distribution package identity mismatch in ${entry.directory}`)
    }
    const digest = (await digestTree(directory)).digest
    if (digest !== entry.treeDigest) throw new Error(`distribution package digest mismatch: ${entry.name}`)
    packages.set(entry.name, directory)
  }
  for (const name of RUNTIME_PACKAGE_NAMES) {
    if (!packages.has(name)) throw new Error(`distribution is missing runtime package ${name}`)
  }
  const presetRoot = resolveContained(absoluteRoot, manifest.presetDirectory)
  if ((await digestTree(presetRoot)).digest !== manifest.presetTreeDigest) {
    throw new Error('distribution preset digest mismatch')
  }
  const pythonRoot = resolveContained(absoluteRoot, manifest.pythonDirectory)
  if ((await digestTree(pythonRoot)).digest !== manifest.pythonTreeDigest) {
    throw new Error('distribution Python tree digest mismatch')
  }
  return { root: absoluteRoot, manifest, packageDirectories: packages, presetRoot, pythonRoot }
}

function parseManifest(value: unknown): DistributionManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('distribution manifest must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1 || record.productVersion !== PRODUCT_VERSION || !Array.isArray(record.packages)) {
    throw new TypeError('distribution manifest header is invalid')
  }
  const packages = record.packages.map((value, index): DistributionPackage => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError(`packages[${index}] must be an object`)
    }
    const entry = value as Record<string, unknown>
    if (typeof entry.name !== 'string' || typeof entry.version !== 'string'
      || typeof entry.directory !== 'string' || !isSha256Digest(entry.treeDigest)) {
      throw new TypeError(`packages[${index}] is invalid`)
    }
    return { name: entry.name, version: entry.version, directory: entry.directory, treeDigest: entry.treeDigest }
  })
  if (typeof record.presetDirectory !== 'string' || !isSha256Digest(record.presetTreeDigest)
    || typeof record.pythonDirectory !== 'string' || !isSha256Digest(record.pythonTreeDigest)
    || typeof record.createdAt !== 'string') {
    throw new TypeError('distribution asset fields are invalid')
  }
  return {
    schemaVersion: 1,
    productVersion: PRODUCT_VERSION,
    packages,
    presetDirectory: record.presetDirectory,
    presetTreeDigest: record.presetTreeDigest,
    pythonDirectory: record.pythonDirectory,
    pythonTreeDigest: record.pythonTreeDigest,
    createdAt: record.createdAt,
  }
}

function resolveContained(root: string, child: string): string {
  const resolved = resolve(root, child)
  const prefix = `${root}\\`.toLowerCase()
  if (resolved.toLowerCase() !== root.toLowerCase() && !resolved.toLowerCase().startsWith(prefix)) {
    throw new Error(`distribution path escapes root: ${child}`)
  }
  return resolved
}
