import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const expectedRepository = 'LYP-PYL/georesearch-dsh'
const expectedRepositoryUrl = 'git+https://github.com/LYP-PYL/georesearch-dsh.git'
const expectedRegistry = 'https://registry.npmjs.org/'
const provenancePredicate = 'https://slsa.dev/provenance/v1'

export interface ReleasePackage {
  readonly name: string
  readonly version: string
  readonly filename: string
  readonly bytes: number
  readonly sha256: string
  readonly integrity: string
}

export interface ReleaseManifest {
  readonly schemaVersion: 1
  readonly productVersion: string
  readonly createdAt: string
  readonly source: {
    readonly repository: string
    readonly commit: string
    readonly tree: string
    readonly clean: true
  }
  readonly publish: {
    readonly registry: string
    readonly access: 'public'
    readonly provenanceRequired: true
    readonly stagingTag: string
    readonly finalTag: 'latest'
    readonly order: readonly string[]
  }
  readonly packages: readonly ReleasePackage[]
}

interface NpmVersionMetadata {
  readonly name?: string
  readonly version?: string
  readonly dist?: {
    readonly integrity?: string
    readonly attestations?: {
      readonly provenance?: { readonly predicateType?: string }
    }
  }
}

interface NpmPackument {
  readonly 'dist-tags'?: Readonly<Record<string, string>>
}

interface CommandResult {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}

export function validateReleaseManifest(value: unknown, releaseTag: string): ReleaseManifest {
  const manifest = expectRecord(value, 'release manifest')
  const productVersion = expectString(manifest.productVersion, 'productVersion')
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(productVersion)) {
    throw new Error('release manifest productVersion is not strict SemVer')
  }
  if (releaseTag !== `v${productVersion}`) {
    throw new Error(`release tag must be v${productVersion}`)
  }
  if (manifest.schemaVersion !== 1) throw new Error('unsupported release manifest schema')
  const createdAt = expectString(manifest.createdAt, 'createdAt')
  if (new Date(createdAt).toISOString() !== createdAt) throw new Error('release createdAt is invalid')

  const source = expectRecord(manifest.source, 'source')
  if (source.repository !== expectedRepositoryUrl
    || source.clean !== true
    || !/^[0-9a-f]{40}$/u.test(expectString(source.commit, 'source.commit'))
    || !/^[0-9a-f]{40}$/u.test(expectString(source.tree, 'source.tree'))) {
    throw new Error('release source identity is invalid')
  }

  const publish = expectRecord(manifest.publish, 'publish')
  const expectedStagingTag = `candidate-${productVersion.replaceAll('.', '-')}`
  if (publish.registry !== expectedRegistry
    || publish.access !== 'public'
    || publish.provenanceRequired !== true
    || publish.stagingTag !== expectedStagingTag
    || publish.finalTag !== 'latest') {
    throw new Error('release publication policy is invalid')
  }

  const order = expectStringArray(publish.order, 'publish.order')
  const rawPackages = expectArray(manifest.packages, 'packages')
  const packages = rawPackages.map((entry, index) => validateReleasePackage(entry, productVersion, index))
  if (packages.length !== 26 || order.length !== packages.length) {
    throw new Error('release manifest must contain exactly 26 packages')
  }
  if (new Set(order).size !== order.length || new Set(packages.map(entry => entry.name)).size !== packages.length) {
    throw new Error('release manifest contains duplicate packages')
  }
  if (packages.some((entry, index) => order[index] !== entry.name)) {
    throw new Error('release package order differs from the publication order')
  }

  return manifest as unknown as ReleaseManifest
}

export function parseSha256Sums(value: string): ReadonlyMap<string, string> {
  const checksums = new Map<string, string>()
  const lines = value.trimEnd().split(/\r?\n/u)
  for (const [index, line] of lines.entries()) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/u.exec(line)
    if (match === null) throw new Error(`invalid SHA256SUMS line ${index + 1}`)
    const [, digest, filename] = match
    if (digest === undefined || filename === undefined || checksums.has(filename)) {
      throw new Error('SHA256SUMS contains a duplicate filename')
    }
    checksums.set(filename, digest)
  }
  return checksums
}

export function assertAssetDigests(
  manifest: ReleaseManifest,
  checksums: ReadonlyMap<string, string>,
  assets: ReadonlyMap<string, Uint8Array>,
): void {
  if (checksums.size !== manifest.packages.length || assets.size !== manifest.packages.length) {
    throw new Error('release asset count differs from the manifest')
  }
  for (const entry of manifest.packages) {
    const bytes = assets.get(entry.filename)
    if (bytes === undefined) throw new Error(`release asset is missing: ${entry.filename}`)
    if (bytes.byteLength !== entry.bytes) throw new Error(`release asset size differs: ${entry.filename}`)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const sha512 = createHash('sha512').update(bytes).digest('base64')
    if (entry.sha256 !== `sha256:${sha256}`
      || checksums.get(entry.filename) !== sha256
      || entry.integrity !== `sha512-${sha512}`) {
      throw new Error(`release asset digest differs: ${entry.filename}`)
    }
  }
}

export function hasNpmProvenance(metadata: NpmVersionMetadata): boolean {
  return metadata.dist?.attestations?.provenance?.predicateType === provenancePredicate
}

async function main(): Promise<void> {
  const releaseTag = requireEnvironment('RELEASE_TAG')
  const assetsRoot = resolve(requireEnvironment('RELEASE_ASSETS_DIR'))
  assertGitHubRuntime()

  const { manifest, assetPaths } = await loadAndValidateAssets(assetsRoot, releaseTag)
  verifyGitAndReleaseIdentity(manifest, releaseTag)
  verifyPackedManifests(manifest, assetPaths)
  runChecked('npm', ['whoami', '--registry', manifest.publish.registry])

  const existing = new Map<string, NpmVersionMetadata | null>()
  for (const entry of manifest.packages) {
    const metadata = await fetchPackageVersion(entry.name, entry.version)
    if (metadata !== null) assertPublishedVersion(entry, metadata)
    existing.set(entry.name, metadata)
  }

  for (const entry of manifest.packages) {
    if (existing.get(entry.name) === null) {
      await publishPackage(entry, assetPaths.get(entry.filename) as string, manifest.publish)
    } else {
      process.stdout.write(`Already published with matching provenance: ${entry.name}@${entry.version}\n`)
    }
    addDistTag(entry, manifest.publish.stagingTag, manifest.publish.registry)
    await waitForDistTag(entry, manifest.publish.stagingTag)
  }

  for (const entry of manifest.packages) {
    const metadata = await waitForPublishedVersion(entry)
    assertPublishedVersion(entry, metadata)
  }
  for (const entry of manifest.packages) {
    addDistTag(entry, manifest.publish.finalTag, manifest.publish.registry)
  }
  for (const entry of manifest.packages) {
    await waitForDistTag(entry, manifest.publish.finalTag)
  }

  process.stdout.write(`${JSON.stringify({
    published: true,
    releaseTag,
    packages: manifest.packages.length,
    stagingTag: manifest.publish.stagingTag,
    finalTag: manifest.publish.finalTag,
    provenance: true,
  }, undefined, 2)}\n`)
}

async function loadAndValidateAssets(
  assetsRoot: string,
  releaseTag: string,
): Promise<{ readonly manifest: ReleaseManifest; readonly assetPaths: ReadonlyMap<string, string> }> {
  const manifestPath = join(assetsRoot, 'release-manifest.json')
  const checksumPath = join(assetsRoot, 'SHA256SUMS')
  const manifest = validateReleaseManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown, releaseTag)
  const checksums = parseSha256Sums(await readFile(checksumPath, 'utf8'))
  const actualFiles = (await readdir(assetsRoot, { withFileTypes: true }))
    .filter(entry => entry.isFile())
    .map(entry => entry.name)
    .sort()
  const expectedFiles = [
    'SHA256SUMS',
    'release-manifest.json',
    ...manifest.packages.map(entry => entry.filename),
  ].sort()
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error('draft Release contains missing or unexpected assets')
  }

  const assetBytes = new Map<string, Uint8Array>()
  const assetPaths = new Map<string, string>()
  for (const entry of manifest.packages) {
    const path = join(assetsRoot, entry.filename)
    assetBytes.set(entry.filename, await readFile(path))
    assetPaths.set(entry.filename, path)
  }
  assertAssetDigests(manifest, checksums, assetBytes)
  return { manifest, assetPaths }
}

function verifyGitAndReleaseIdentity(manifest: ReleaseManifest, releaseTag: string): void {
  if (runChecked('gh', ['api', `repos/${expectedRepository}`, '--jq', '.visibility']).stdout.trim() !== 'public') {
    throw new Error('npm provenance publication requires a public GitHub repository')
  }
  const release = JSON.parse(runChecked('gh', [
    'release', 'view', releaseTag, '--repo', expectedRepository, '--json', 'isDraft,tagName',
  ]).stdout) as { readonly isDraft?: boolean; readonly tagName?: string }
  if (release.isDraft !== true || release.tagName !== releaseTag) {
    throw new Error('packages may only be published from the matching draft GitHub Release')
  }
  if (runChecked('git', ['cat-file', '-t', `refs/tags/${releaseTag}`]).stdout.trim() !== 'tag') {
    throw new Error('release tag must be annotated')
  }
  const commit = runChecked('git', ['rev-parse', `${releaseTag}^{commit}`]).stdout.trim()
  const tree = runChecked('git', ['rev-parse', `${releaseTag}^{tree}`]).stdout.trim()
  const head = runChecked('git', ['rev-parse', 'HEAD']).stdout.trim()
  const status = runChecked('git', ['status', '--porcelain', '--untracked-files=no']).stdout.trim()
  if (commit !== manifest.source.commit || head !== commit || tree !== manifest.source.tree || status.length > 0) {
    throw new Error('checked-out tag differs from the verified release source')
  }
}

function verifyPackedManifests(
  manifest: ReleaseManifest,
  assetPaths: ReadonlyMap<string, string>,
): void {
  for (const entry of manifest.packages) {
    const path = assetPaths.get(entry.filename)
    if (path === undefined) throw new Error(`asset path is missing: ${entry.filename}`)
    const packed = JSON.parse(runChecked('tar', ['-xOf', path, 'package/package.json']).stdout) as {
      readonly name?: string
      readonly version?: string
      readonly repository?: string | { readonly url?: string }
      readonly publishConfig?: { readonly access?: string; readonly registry?: string }
    }
    const repository = typeof packed.repository === 'string' ? packed.repository : packed.repository?.url
    if (packed.name !== entry.name
      || packed.version !== entry.version
      || repository !== expectedRepositoryUrl
      || packed.publishConfig?.access !== 'public'
      || packed.publishConfig.registry !== expectedRegistry) {
      throw new Error(`packed npm metadata differs from the release policy: ${entry.name}`)
    }
  }
}

async function publishPackage(
  entry: ReleasePackage,
  path: string,
  policy: ReleaseManifest['publish'],
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    process.stdout.write(`Publishing ${entry.name}@${entry.version} (${attempt}/3)\n`)
    const result = runCommand('npm', [
      'publish', path,
      '--ignore-scripts',
      '--provenance',
      '--access', policy.access,
      '--tag', policy.stagingTag,
      '--registry', policy.registry,
    ])
    if (result.status === 0) {
      const metadata = await waitForPublishedVersion(entry)
      assertPublishedVersion(entry, metadata)
      return
    }

    const afterFailure = await fetchPackageVersion(entry.name, entry.version)
    if (afterFailure !== null) {
      assertPublishedVersion(entry, afterFailure)
      return
    }
    if (attempt === 3) {
      throw new Error(redactSecrets([
        `npm publish failed for ${entry.name}@${entry.version}`,
        result.stdout,
        result.stderr,
      ].filter(Boolean).join('\n')))
    }
    await delay(5_000 * attempt)
  }
}

function addDistTag(entry: ReleasePackage, tag: string, registry: string): void {
  runChecked('npm', ['dist-tag', 'add', `${entry.name}@${entry.version}`, tag, '--registry', registry])
}

async function waitForPublishedVersion(entry: ReleasePackage): Promise<NpmVersionMetadata> {
  for (let attempt = 1; attempt <= 18; attempt += 1) {
    const metadata = await fetchPackageVersion(entry.name, entry.version)
    if (metadata !== null
      && metadata.dist?.integrity === entry.integrity
      && hasNpmProvenance(metadata)) {
      return metadata
    }
    if (metadata !== null && metadata.dist?.integrity !== entry.integrity) {
      assertPublishedVersion(entry, metadata)
    }
    await delay(5_000)
  }
  throw new Error(`npm registry did not expose matching provenance for ${entry.name}@${entry.version}`)
}

async function waitForDistTag(entry: ReleasePackage, tag: string): Promise<void> {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const packument = await fetchRegistryJson<NpmPackument>(encodeURIComponent(entry.name))
    if (packument === null) throw new Error(`npm package disappeared: ${entry.name}`)
    if (packument['dist-tags']?.[tag] === entry.version) return
    await delay(3_000)
  }
  throw new Error(`npm dist-tag ${tag} did not resolve to ${entry.name}@${entry.version}`)
}

async function fetchPackageVersion(name: string, version: string): Promise<NpmVersionMetadata | null> {
  return fetchRegistryJson<NpmVersionMetadata>(
    `${encodeURIComponent(name)}/${encodeURIComponent(version)}`,
    true,
  )
}

async function fetchRegistryJson<T>(path: string, allowNotFound = false): Promise<T | null> {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(new URL(path, expectedRegistry), {
      headers: { accept: 'application/json', 'cache-control': 'no-cache' },
      signal: AbortSignal.timeout(20_000),
    })
    if (allowNotFound && response.status === 404) return null
    if (response.ok) return await response.json() as T
    if (attempt === 5 || (response.status !== 429 && response.status < 500)) {
      throw new Error(`npm registry request failed with HTTP ${response.status}`)
    }
    await delay(2_000 * attempt)
  }
  throw new Error('npm registry request exhausted retries')
}

function assertPublishedVersion(entry: ReleasePackage, metadata: NpmVersionMetadata): void {
  if (metadata.name !== entry.name
    || metadata.version !== entry.version
    || metadata.dist?.integrity !== entry.integrity) {
    throw new Error(`npm already contains a different immutable version: ${entry.name}@${entry.version}`)
  }
  if (!hasNpmProvenance(metadata)) {
    throw new Error(`npm version lacks required provenance: ${entry.name}@${entry.version}`)
  }
}

function assertGitHubRuntime(): void {
  if (process.env.GITHUB_ACTIONS !== 'true'
    || process.env.GITHUB_REPOSITORY !== expectedRepository
    || !process.env.ACTIONS_ID_TOKEN_REQUEST_URL
    || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    || !process.env.NODE_AUTH_TOKEN) {
    throw new Error('publication requires the authorized GitHub Actions OIDC environment and NPM_TOKEN')
  }
}

function validateReleasePackage(value: unknown, productVersion: string, index: number): ReleasePackage {
  const entry = expectRecord(value, `packages[${index}]`)
  const name = expectString(entry.name, `packages[${index}].name`)
  const version = expectString(entry.version, `packages[${index}].version`)
  const filename = expectString(entry.filename, `packages[${index}].filename`)
  const bytes = entry.bytes
  const sha256 = expectString(entry.sha256, `packages[${index}].sha256`)
  const integrity = expectString(entry.integrity, `packages[${index}].integrity`)
  const expectedFilename = `${name.replace(/^@/u, '').replaceAll('/', '-')}-${productVersion}.tgz`
  if (!/^@georesearch\/[a-z0-9-]+$/u.test(name)
    || version !== productVersion
    || filename !== expectedFilename
    || basename(filename) !== filename
    || typeof bytes !== 'number'
    || !Number.isSafeInteger(bytes)
    || bytes <= 0
    || !/^sha256:[0-9a-f]{64}$/u.test(sha256)
    || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(integrity)) {
    throw new Error(`invalid release package at index ${index}`)
  }
  return { name, version, filename, bytes, sha256, integrity }
}

function runChecked(command: string, args: readonly string[]): CommandResult {
  const result = runCommand(command, args)
  if (result.status !== 0) {
    throw new Error(redactSecrets([
      `${command} ${args.join(' ')} failed with exit ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join('\n')))
  }
  return result
}

function runCommand(command: string, args: readonly string[]): CommandResult {
  const result = spawnSync(command, [...args], {
    encoding: 'utf8',
    shell: false,
    env: {
      ...process.env,
      CI: '1',
      npm_config_update_notifier: 'false',
    },
    maxBuffer: 16 * 1024 * 1024,
  })
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  }
}

function redactSecrets(value: string): string {
  let result = value
  for (const secret of [process.env.NODE_AUTH_TOKEN, process.env.GH_TOKEN]) {
    if (secret) result = result.replaceAll(secret, '[REDACTED]')
  }
  return result
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function expectArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`)
  return value
}

function expectStringArray(value: unknown, label: string): readonly string[] {
  const entries = expectArray(value, label)
  if (entries.some(entry => typeof entry !== 'string')) throw new TypeError(`${label} must contain strings`)
  return entries as readonly string[]
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a string`)
  return value
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && pathToFileURL(resolve(entrypoint)).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${redactSecrets(error instanceof Error ? error.stack ?? error.message : String(error))}\n`)
    process.exitCode = 1
  })
}
