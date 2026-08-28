import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, sha256Bytes } from '@georesearch/dsh-contracts'
import { publint } from 'publint'
import { formatMessage } from 'publint/utils'
import { WORKSPACE_PACKAGES } from './workspace-packages.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repositoryUrl = 'git+https://github.com/georesearch-dsh/georesearch-dsh.git'
const homepageUrl = 'https://github.com/georesearch-dsh/georesearch-dsh#readme'
const bugsUrl = 'https://github.com/georesearch-dsh/georesearch-dsh/issues'
const registryUrl = 'https://registry.npmjs.org/'
const rootManifest = await readJson(join(root, 'package.json')) as PackageManifest & {
  readonly packageManager: string
}
const releaseMetadata = await readJson(join(root, 'release-metadata.json')) as {
  readonly productVersion: string
  readonly createdAt: string
}
const baseline = await readJson(join(root, 'docs', 'phase0-baseline.json')) as {
  readonly harness: {
    readonly version: string
    readonly commit: string
    readonly sourceIdentity: {
      readonly localPatch: {
        readonly id: string
        readonly manifestSha256: string
      }
    }
  }
}

if (rootManifest.version !== releaseMetadata.productVersion) {
  throw new Error('release metadata product version differs from the workspace')
}
assertRepositoryMetadata(rootManifest, 'workspace root')

const distributionManifestPath = join(root, 'dist', 'distribution', 'distribution-manifest.json')
const distributionManifestBytes = await readFile(distributionManifestPath)
const distributionManifest = JSON.parse(distributionManifestBytes.toString('utf8')) as {
  readonly productVersion: string
  readonly createdAt: string
  readonly packages: readonly Array<{
    readonly name: string
    readonly version: string
    readonly directory: string
    readonly treeDigest: string
  }>
}
if (distributionManifest.productVersion !== rootManifest.version
  || distributionManifest.createdAt !== releaseMetadata.createdAt) {
  throw new Error('distribution release identity differs from release-metadata.json')
}

const liveReportPath = join(root, 'dist', 'reports', 'phase7-live-e2e.json')
const liveReportBytes = await readFile(liveReportPath)
const liveReport = JSON.parse(liveReportBytes.toString('utf8')) as {
  readonly schemaVersion: number
  readonly checkedAt: string
  readonly releaseIdentity?: {
    readonly productVersion: string
    readonly distributionCreatedAt: string
    readonly distributionManifestSha256: string
    readonly harnessVersion: string
    readonly harnessCommit: string
    readonly harnessPatchId: string
    readonly harnessPatchManifestSha256: string
  }
  readonly checks: Readonly<Record<string, boolean>>
  readonly lifecycle: Readonly<Record<string, boolean>>
}
const expectedDistributionDigest = sha256Bytes(distributionManifestBytes)
if (liveReport.schemaVersion !== 2
  || liveReport.releaseIdentity?.productVersion !== rootManifest.version
  || liveReport.releaseIdentity.distributionCreatedAt !== releaseMetadata.createdAt
  || liveReport.releaseIdentity.distributionManifestSha256 !== expectedDistributionDigest
  || liveReport.releaseIdentity.harnessVersion !== baseline.harness.version
  || liveReport.releaseIdentity.harnessCommit !== baseline.harness.commit
  || liveReport.releaseIdentity.harnessPatchId !== baseline.harness.sourceIdentity.localPatch.id
  || liveReport.releaseIdentity.harnessPatchManifestSha256 !== baseline.harness.sourceIdentity.localPatch.manifestSha256) {
  throw new Error('Phase 7 live report is stale relative to the current release candidate')
}
if (Date.parse(liveReport.checkedAt) < Date.parse(releaseMetadata.createdAt)) {
  throw new Error('Phase 7 live report predates the current release metadata')
}
assertBooleanRecord(liveReport.checks, 'Phase 7 live check')
assertBooleanRecord(liveReport.lifecycle, 'Phase 7 lifecycle check')

const packageNames = new Set(WORKSPACE_PACKAGES.map(entry => entry.name))
const packageIndex = new Map(WORKSPACE_PACKAGES.map((entry, index) => [entry.name, index]))
const distributionPackages = new Map(distributionManifest.packages.map(entry => [entry.name, entry]))
if (distributionPackages.size !== WORKSPACE_PACKAGES.length) {
  throw new Error('distribution package count differs from the release catalog')
}

const tarballRoot = join(root, 'dist', 'tarballs')
const releasePackages: ReleasePackage[] = []
const stagingTag = `candidate-${rootManifest.version.replaceAll('.', '-')}`
for (const [index, entry] of WORKSPACE_PACKAGES.entries()) {
  const sourceManifest = await readJson(join(root, 'packages', entry.folder, 'package.json')) as PackageManifest
  if (sourceManifest.name !== entry.name || sourceManifest.version !== rootManifest.version) {
    throw new Error(`source package identity drift: ${entry.name}`)
  }
  assertPackageMetadata(sourceManifest, entry.name)
  for (const dependencyName of workspaceDependencies(sourceManifest, packageNames)) {
    const dependencyIndex = packageIndex.get(dependencyName)
    if (dependencyIndex === undefined || dependencyIndex >= index) {
      throw new Error(`release package order is not topological: ${entry.name} depends on ${dependencyName}`)
    }
  }

  const distributionEntry = distributionPackages.get(entry.name)
  if (distributionEntry === undefined || distributionEntry.version !== rootManifest.version) {
    throw new Error(`distribution manifest is missing ${entry.name}`)
  }
  const distributionPackageRoot = join(root, 'dist', 'distribution', ...distributionEntry.directory.split('/'))
  const distributionPackageManifest = await readJson(join(distributionPackageRoot, 'package.json')) as PackageManifest
  assertPackageMetadata(distributionPackageManifest, `${entry.name} distribution`)
  assertNoLocalRanges(distributionPackageManifest, entry.name)

  const lint = await publint({ pkgDir: distributionPackageRoot, pack: false, strict: true, level: 'warning' })
  if (lint.messages.length > 0) {
    const messages = lint.messages
      .map(message => formatMessage(message, lint.pkg, { color: false }))
      .filter((message): message is string => message !== undefined)
    throw new Error(`publint failed for ${entry.name}:\n${messages.join('\n')}`)
  }

  const filename = packedFilename(entry.name, rootManifest.version)
  const tarball = join(tarballRoot, filename)
  const tarballBytes = await readFile(tarball)
  const packedManifest = JSON.parse(runChecked('tar', ['-xOf', tarball, 'package/package.json']).stdout) as PackageManifest
  if (canonicalJson(packedManifest) !== canonicalJson(distributionPackageManifest)) {
    throw new Error(`packed manifest differs from the distribution for ${entry.name}`)
  }
  runChecked('npm', [
    'publish', tarball, '--dry-run', '--ignore-scripts', '--access', 'public', '--tag', stagingTag,
    '--provenance=false', '--json',
  ])

  const sha256 = createHash('sha256').update(tarballBytes).digest('hex')
  const sha512 = createHash('sha512').update(tarballBytes).digest('base64')
  releasePackages.push({
    name: entry.name,
    version: rootManifest.version,
    filename,
    bytes: tarballBytes.byteLength,
    sha256: `sha256:${sha256}`,
    integrity: `sha512-${sha512}`,
  })
}

const actualTarballs = (await readdir(tarballRoot, { withFileTypes: true }))
  .filter(entry => entry.isFile() && entry.name.endsWith('.tgz'))
  .map(entry => entry.name)
  .sort()
const expectedTarballs = releasePackages.map(entry => entry.filename).sort()
if (canonicalJson(actualTarballs) !== canonicalJson(expectedTarballs)) {
  throw new Error('tarball directory contains missing or unexpected archives')
}

const gitStatus = runChecked('git', ['status', '--porcelain']).stdout.trim()
const sourceTreeClean = gitStatus.length === 0
if (!sourceTreeClean && process.env.GEORESEARCH_RELEASE_ALLOW_DIRTY !== '1') {
  throw new Error('release readiness requires a clean Git worktree')
}
const sourceCommit = runChecked('git', ['rev-parse', 'HEAD']).stdout.trim()
const sourceTree = runChecked('git', ['rev-parse', 'HEAD^{tree}']).stdout.trim()

const releaseManifest = {
  schemaVersion: 1,
  productVersion: rootManifest.version,
  createdAt: releaseMetadata.createdAt,
  source: {
    repository: repositoryUrl,
    commit: sourceCommit,
    tree: sourceTree,
    clean: sourceTreeClean,
  },
  harness: {
    version: baseline.harness.version,
    commit: baseline.harness.commit,
    patchId: baseline.harness.sourceIdentity.localPatch.id,
    patchManifestSha256: baseline.harness.sourceIdentity.localPatch.manifestSha256,
  },
  evidence: {
    distributionManifestSha256: expectedDistributionDigest,
    phase7LiveReportSha256: sha256Bytes(liveReportBytes),
    phase7LiveCheckedAt: liveReport.checkedAt,
  },
  publish: {
    registry: registryUrl,
    access: 'public',
    provenanceRequired: true,
    stagingTag,
    finalTag: 'latest',
    order: releasePackages.map(entry => entry.name),
  },
  packages: releasePackages,
}
const releaseRoot = join(root, 'dist', 'release')
await mkdir(releaseRoot, { recursive: true })
await writeFile(join(releaseRoot, 'release-manifest.json'), `${JSON.stringify(releaseManifest, undefined, 2)}\n`, 'utf8')
await writeFile(join(releaseRoot, 'SHA256SUMS'), `${releasePackages
  .map(entry => `${entry.sha256.slice('sha256:'.length)}  ${entry.filename}`)
  .join('\n')}\n`, 'utf8')

process.stdout.write(`${JSON.stringify({
  releaseReady: true,
  productVersion: rootManifest.version,
  packages: releasePackages.length,
  sourceTreeClean,
  publint: true,
  npmPublishDryRun: true,
  productionAuditRequired: true,
  liveEvidenceCurrent: true,
  provenanceRequired: true,
  releaseManifest: join(releaseRoot, 'release-manifest.json'),
  checksums: join(releaseRoot, 'SHA256SUMS'),
}, undefined, 2)}\n`)

interface PackageManifest {
  readonly name?: string
  readonly version?: string
  readonly private?: boolean
  readonly license?: string
  readonly repository?: { readonly type?: string; readonly url?: string } | string
  readonly homepage?: string
  readonly bugs?: { readonly url?: string } | string
  readonly publishConfig?: { readonly access?: string; readonly registry?: string }
  readonly files?: readonly string[]
  readonly dependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
}

interface ReleasePackage {
  readonly name: string
  readonly version: string
  readonly filename: string
  readonly bytes: number
  readonly sha256: string
  readonly integrity: string
}

function assertRepositoryMetadata(manifest: PackageManifest, label: string): void {
  const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url
  const bugs = typeof manifest.bugs === 'string' ? manifest.bugs : manifest.bugs?.url
  if (repository !== repositoryUrl || manifest.homepage !== homepageUrl || bugs !== bugsUrl) {
    throw new Error(`${label} repository metadata is incomplete or inconsistent`)
  }
}

function assertPackageMetadata(manifest: PackageManifest, label: string): void {
  if (manifest.private === true) throw new Error(`${label} is marked private`)
  if (manifest.license !== 'MIT') throw new Error(`${label} does not declare the MIT license`)
  assertRepositoryMetadata(manifest, label)
  if (manifest.publishConfig?.access !== 'public' || manifest.publishConfig.registry !== registryUrl) {
    throw new Error(`${label} does not enforce public npm publication through the official registry`)
  }
  for (const required of ['lib', 'README.md', 'LICENSE']) {
    if (!manifest.files?.includes(required)) throw new Error(`${label} package files omit ${required}`)
  }
}

function workspaceDependencies(manifest: PackageManifest, names: ReadonlySet<string>): string[] {
  return Object.keys({
    ...(manifest.dependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  }).filter(name => names.has(name)).sort()
}

function assertNoLocalRanges(value: unknown, packageName: string): void {
  if (typeof value === 'string') {
    if (/^(?:workspace|link|file):/u.test(value)) {
      throw new Error(`${packageName} retained a local dependency range: ${value}`)
    }
    return
  }
  if (Array.isArray(value)) {
    for (const child of value) assertNoLocalRanges(child, packageName)
    return
  }
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value as Record<string, unknown>)) assertNoLocalRanges(child, packageName)
  }
}

function assertBooleanRecord(record: Readonly<Record<string, boolean>>, label: string): void {
  for (const [name, value] of Object.entries(record)) {
    if (value !== true) throw new Error(`${label} failed: ${name}`)
  }
}

function packedFilename(name: string, version: string): string {
  return `${name.replace(/^@/u, '').replaceAll('/', '-')}-${version}.tgz`
}

function runChecked(command: string, args: readonly string[]): { readonly stdout: string; readonly stderr: string } {
  const windowsShellCommand = process.platform === 'win32' && command === 'npm'
  const executable = windowsShellCommand ? (process.env.ComSpec ?? 'cmd.exe') : command
  const commandArgs = windowsShellCommand ? ['/d', '/c', command, ...args] : [...args]
  const result = spawnSync(executable, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
    env: {
      ...process.env,
      CI: '1',
      npm_config_cache: join(root, '.tmp', 'npm-cache'),
      npm_config_update_notifier: 'false',
    },
    maxBuffer: 16 * 1024 * 1024,
  })
  if ((result.status ?? 1) !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with exit ${String(result.status)}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n'))
  }
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}
