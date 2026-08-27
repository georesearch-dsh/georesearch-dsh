import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  GEORESEARCH_BUNDLE_PACKAGE,
  PRODUCT_VERSION,
  PROFILE_ID,
  WEB_APP_BUNDLE_PACKAGE,
  sha256Bytes,
  type InstallerProfileIntegrationRecord,
  type Sha256Digest,
} from '@georesearch/dsh-contracts'
import { RUNTIME_PACKAGE_NAMES } from './distribution.js'

const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

const PROFILE_FILES = ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml'] as const
type ProfileFile = typeof PROFILE_FILES[number]

export interface FileSnapshot {
  readonly present: boolean
  readonly bytes: Uint8Array
  readonly digest: Sha256Digest
}

export interface ProfileFileMutation {
  readonly path: ProfileFile
  readonly snapshot: FileSnapshot
  readonly bytes: Uint8Array
}

export interface PlannedProfileIntegration {
  readonly profileName: string
  readonly sourceRoot: string
  readonly mutations: readonly ProfileFileMutation[]
}

export interface ProfileIntegrationPlan {
  readonly profiles: readonly PlannedProfileIntegration[]
}

/** Discover every Web Profile and plan the GeoResearch-owned manifest additions. */
export async function planProfileIntegrations(
  home: string,
  existingProfileNames: readonly string[],
  previousProductVersion: string | undefined,
): Promise<ProfileIntegrationPlan> {
  const profilesRoot = join(resolve(home), 'profiles')
  const existing = new Set(existingProfileNames)
  const discovered = await discoverWebProfileNames(profilesRoot)
  const names = new Set([...existing, ...discovered])
  if (names.size === 0) names.add('web')
  names.delete(PROFILE_ID)

  const profiles: PlannedProfileIntegration[] = []
  for (const profileName of [...names].sort()) {
    const sourceRoot = join(profilesRoot, profileName)
    const snapshots = await snapshotProfileFiles(sourceRoot)
    const manifest = snapshots['package.json'].present
      ? parseProfileManifest(snapshots['package.json'].bytes, profileName)
      : defaultWebManifest(profileName)
    const packageMutation = integrateManifest(
      manifest,
      snapshots['package.json'],
      profileName,
      existing.has(profileName),
      previousProductVersion,
    )
    const mutations: ProfileFileMutation[] = []
    if (packageMutation !== undefined) mutations.push(packageMutation)
    if (!snapshots['cordis.patch.yml'].present) {
      mutations.push(fileMutation('cordis.patch.yml', snapshots['cordis.patch.yml'], PROFILE_PATCH_TEMPLATE))
    }
    if (!snapshots['pnpm-workspace.yaml'].present) {
      mutations.push(fileMutation('pnpm-workspace.yaml', snapshots['pnpm-workspace.yaml'], PROFILE_PNPM_WORKSPACE))
    }
    profiles.push({ profileName, sourceRoot, mutations })
  }
  return { profiles }
}

/** Plan removal of only GeoResearch-owned fields from integrated Profile manifests. */
export async function planProfileRemoval(
  home: string,
  profileNames: readonly string[],
  productVersion: string,
): Promise<ProfileIntegrationPlan> {
  const profilesRoot = join(resolve(home), 'profiles')
  const profiles: PlannedProfileIntegration[] = []
  for (const profileName of [...profileNames].sort()) {
    const sourceRoot = join(profilesRoot, profileName)
    const snapshot = await snapshotFile(join(sourceRoot, 'package.json'))
    if (!snapshot.present) throw new Error(`integrated Profile is missing package.json: ${profileName}`)
    const manifest = parseProfileManifest(snapshot.bytes, profileName)
    const dependencies = dependencyRecord(manifest, profileName)
    for (const packageName of RUNTIME_PACKAGE_NAMES) {
      if (dependencies[packageName] !== productVersion) {
        throw new Error(`integrated Profile dependency was modified: ${profileName}/${packageName}`)
      }
      delete dependencies[packageName]
    }
    const bundles = profileBundles(manifest, profileName)
    if (bundles.filter(name => name === GEORESEARCH_BUNDLE_PACKAGE).length !== 1) {
      throw new Error(`integrated Profile bundle was modified: ${profileName}/${GEORESEARCH_BUNDLE_PACKAGE}`)
    }
    manifest.dependencies = dependencies
    manifest.dsh = {
      ...objectRecord(manifest.dsh, `${profileName}.dsh`),
      profile: {
        ...objectRecord(objectRecord(manifest.dsh, `${profileName}.dsh`).profile, `${profileName}.dsh.profile`),
        bundles: bundles.filter(name => name !== GEORESEARCH_BUNDLE_PACKAGE),
      },
    }
    profiles.push({
      profileName,
      sourceRoot,
      mutations: [fileMutation('package.json', snapshot, serializeManifest(manifest))],
    })
  }
  return { profiles }
}

/** Journal rows needed to restore every Profile file changed by a transaction. */
export function journalProfileIntegrations(
  plan: ProfileIntegrationPlan,
): readonly InstallerProfileIntegrationRecord[] {
  return plan.profiles
    .filter(profile => profile.mutations.length > 0)
    .map(profile => ({
      profileName: profile.profileName,
      files: profile.mutations.map(mutation => ({
        path: mutation.path,
        existedBefore: mutation.snapshot.present,
      })),
    }))
}

/** Fail when a Profile file changed after its installation plan was built. */
export async function assertProfilePlanUnchanged(plan: ProfileIntegrationPlan): Promise<void> {
  for (const profile of plan.profiles) {
    for (const mutation of profile.mutations) {
      const current = await snapshotFile(join(profile.sourceRoot, mutation.path))
      if (current.present !== mutation.snapshot.present || current.digest !== mutation.snapshot.digest) {
        throw new Error(`Profile changed during installer transaction: ${profile.profileName}/${mutation.path}`)
      }
    }
  }
}

/** Read one optional file without following mutable state after the handle closes. */
export async function snapshotFile(path: string): Promise<FileSnapshot> {
  try {
    const bytes = await readFile(path)
    return { present: true, bytes, digest: sha256Bytes(bytes) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const bytes = new Uint8Array()
      return { present: false, bytes, digest: sha256Bytes(bytes) }
    }
    throw error
  }
}

async function discoverWebProfileNames(profilesRoot: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(profilesRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const names: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules' || entry.name === PROFILE_ID) continue
    const packagePath = join(profilesRoot, entry.name, 'package.json')
    let bytes: Uint8Array
    try {
      bytes = await readFile(packagePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    const manifest = parseProfileManifest(bytes, entry.name)
    if (optionalProfileBundles(manifest).includes(WEB_APP_BUNDLE_PACKAGE)) names.push(entry.name)
  }
  return names
}

async function snapshotProfileFiles(root: string): Promise<Record<ProfileFile, FileSnapshot>> {
  const values = await Promise.all(PROFILE_FILES.map(path => snapshotFile(join(root, path))))
  return Object.fromEntries(PROFILE_FILES.map((path, index) => [path, values[index]])) as Record<ProfileFile, FileSnapshot>
}

function integrateManifest(
  manifest: Record<string, unknown>,
  snapshot: FileSnapshot,
  profileName: string,
  alreadyIntegrated: boolean,
  previousProductVersion: string | undefined,
): ProfileFileMutation | undefined {
  const dependencies = dependencyRecord(manifest, profileName)
  let changed = !snapshot.present
  for (const packageName of RUNTIME_PACKAGE_NAMES) {
    const current = dependencies[packageName]
    if (current !== undefined) {
      if (!alreadyIntegrated || previousProductVersion === undefined || current !== previousProductVersion) {
        throw new Error(`Profile already owns conflicting dependency: ${profileName}/${packageName}`)
      }
    }
    if (current !== PRODUCT_VERSION) {
      dependencies[packageName] = PRODUCT_VERSION
      changed = true
    }
  }

  const bundles = profileBundles(manifest, profileName)
  if (!bundles.includes(WEB_APP_BUNDLE_PACKAGE)) {
    throw new Error(`Profile is not a Web Profile: ${profileName}`)
  }
  const occurrences = bundles.filter(name => name === GEORESEARCH_BUNDLE_PACKAGE).length
  if ((alreadyIntegrated && occurrences !== 1) || (!alreadyIntegrated && occurrences !== 0)) {
    throw new Error(`Profile already owns conflicting bundle state: ${profileName}/${GEORESEARCH_BUNDLE_PACKAGE}`)
  }
  if (occurrences === 0) {
    bundles.push(GEORESEARCH_BUNDLE_PACKAGE)
    changed = true
  }
  if (!changed) return undefined

  const dsh = objectRecord(manifest.dsh, `${profileName}.dsh`)
  const profile = objectRecord(dsh.profile, `${profileName}.dsh.profile`)
  manifest.dependencies = dependencies
  manifest.dsh = { ...dsh, profile: { ...profile, bundles } }
  return fileMutation('package.json', snapshot, serializeManifest(manifest))
}

function defaultWebManifest(profileName: string): Record<string, unknown> {
  return {
    name: `dsh-profile-${profileName}`,
    private: true,
    dependencies: {},
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE_PACKAGE],
      },
    },
  }
}

function parseProfileManifest(bytes: Uint8Array, profileName: string): Record<string, unknown> {
  const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown
  return objectRecord(value, `${profileName}.package.json`)
}

function dependencyRecord(manifest: Record<string, unknown>, profileName: string): Record<string, string> {
  if (manifest.dependencies === undefined) return {}
  const dependencies = objectRecord(manifest.dependencies, `${profileName}.dependencies`)
  for (const [name, value] of Object.entries(dependencies)) {
    if (typeof value !== 'string') throw new TypeError(`${profileName}.dependencies.${name} must be a string`)
  }
  return { ...dependencies } as Record<string, string>
}

function profileBundles(manifest: Record<string, unknown>, profileName: string): string[] {
  const dsh = objectRecord(manifest.dsh, `${profileName}.dsh`)
  const profile = objectRecord(dsh.profile, `${profileName}.dsh.profile`)
  if (!Array.isArray(profile.bundles) || !profile.bundles.every(value => typeof value === 'string')) {
    throw new TypeError(`${profileName}.dsh.profile.bundles must be a string array`)
  }
  return [...profile.bundles] as string[]
}

function optionalProfileBundles(manifest: Record<string, unknown>): string[] {
  if (typeof manifest.dsh !== 'object' || manifest.dsh === null || Array.isArray(manifest.dsh)) return []
  const profile = (manifest.dsh as Record<string, unknown>).profile
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return []
  const bundles = (profile as Record<string, unknown>).bundles
  return Array.isArray(bundles) && bundles.every(value => typeof value === 'string')
    ? [...bundles] as string[]
    : []
}

function objectRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function fileMutation(path: ProfileFile, snapshot: FileSnapshot, source: string): ProfileFileMutation {
  return { path, snapshot, bytes: Buffer.from(source, 'utf8') }
}

function serializeManifest(manifest: Record<string, unknown>): string {
  return `${JSON.stringify(manifest, undefined, 2)}\n`
}
