import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  DEPENDENCY_LOCK_FILE,
  GENERATION_MARKER_FILE,
  GEORESEARCH_BUNDLE_PACKAGE,
  GeoResearchError,
  PRESET_ID,
  PROFILE_INTEGRATIONS_FILE,
  PROFILE_ROOT_FILE,
  PROFILE_ID,
  WEB_APP_BUNDLE_PACKAGE,
  digestFile,
  digestTree,
  parseActiveInstallationRecord,
  parseGenerationMarker,
  parseInstallationManifest,
  parseProfileIntegrationsRecord,
  sha256Bytes,
  type ActiveInstallationRecord,
  type InstallationManifest,
  type InstallerJournal,
  type ProfileIntegrationsRecord,
  type Sha256Digest,
} from '@georesearch/dsh-contracts'
import { OPERATOR_SCOPE_FILE } from './operator-scope.js'

export interface InstallationPaths {
  readonly home: string
  readonly profileRoot: string
  readonly sharedPackagesRoot: string
  readonly presetRoot: string
  readonly skillsRoot: string
  readonly installationRoot: string
  readonly transactionsRoot: string
  readonly activePath: string
  readonly manifestPath: string
  readonly profileMarkerPath: string
  readonly presetMarkerPath: string
  readonly dependencyLockPath: string
  readonly profileIntegrationsPath: string
  readonly homePatchPath: string
  readonly operatorScopePath: string
}

export interface InstallationValidation {
  readonly paths: InstallationPaths
  readonly active: ActiveInstallationRecord
  readonly manifest: InstallationManifest
  readonly integrations?: ProfileIntegrationsRecord
  readonly profileFileCount: number
  readonly presetFileCount: number
  readonly skillFileCount: number
}

export interface ValidationOptions {
  readonly activeOverride?: ActiveInstallationRecord
  readonly allowedTransactionId?: string
  readonly ignoreHomePatchDrift?: boolean
}

export function installationPaths(home: string): InstallationPaths {
  const absoluteHome = resolve(home)
  const profileRoot = join(absoluteHome, 'profiles', PROFILE_ID)
  const presetRoot = join(absoluteHome, '.agent-presets', PRESET_ID)
  const installationRoot = join(absoluteHome, 'georesearch', 'installations', PROFILE_ID)
  return {
    home: absoluteHome,
    profileRoot,
    sharedPackagesRoot: join(absoluteHome, 'profiles', 'node_modules', '@georesearch'),
    presetRoot,
    skillsRoot: join(presetRoot, 'skills'),
    installationRoot,
    transactionsRoot: join(installationRoot, 'transactions'),
    activePath: join(installationRoot, 'active.json'),
    manifestPath: join(installationRoot, 'manifest.json'),
    profileMarkerPath: join(profileRoot, GENERATION_MARKER_FILE),
    presetMarkerPath: join(presetRoot, GENERATION_MARKER_FILE),
    dependencyLockPath: join(profileRoot, DEPENDENCY_LOCK_FILE),
    profileIntegrationsPath: join(profileRoot, PROFILE_INTEGRATIONS_FILE),
    homePatchPath: join(absoluteHome, 'cordis.patch.yml'),
    operatorScopePath: join(installationRoot, OPERATOR_SCOPE_FILE),
  }
}

export async function validateInstallation(
  home: string,
  options: ValidationOptions = {},
): Promise<InstallationValidation> {
  const paths = installationPaths(home)
  try {
    const active = options.activeOverride ?? parseActiveInstallationRecord(await readJson(paths.activePath))
    const manifestBytes = await readFile(paths.manifestPath)
    const manifest = parseInstallationManifest(JSON.parse(manifestBytes.toString('utf8')))
    const profileMarker = parseGenerationMarker(await readJson(paths.profileMarkerPath))
    const presetMarker = parseGenerationMarker(await readJson(paths.presetMarkerPath))

    assertIdentity(active, manifest.installationId, manifest.generation, 'installation manifest')
    assertIdentity(active, profileMarker.installationId, profileMarker.generation, 'profile generation marker')
    assertIdentity(active, presetMarker.installationId, presetMarker.generation, 'preset generation marker')

    const profileExcludes = new Set([GENERATION_MARKER_FILE])
    const legacyManagedRoot = manifest.managedFiles.some(file =>
      file.root === 'profile' && file.path === PROFILE_ROOT_FILE)
    if (!legacyManagedRoot) profileExcludes.add(PROFILE_ROOT_FILE)
    const profile = await digestTree(paths.profileRoot, { exclude: profileExcludes })
    const preset = await digestTree(paths.presetRoot, {
      exclude: new Set([GENERATION_MARKER_FILE]),
    })
    const skills = await digestTree(paths.skillsRoot)
    const manifestDigest = sha256Bytes(manifestBytes)
    const lockDigest = await digestFile(paths.dependencyLockPath)
    const homePatchDigest = await digestOptionalFile(paths.homePatchPath)
    const integrations = await readProfileIntegrationsIfPresent(paths.profileIntegrationsPath)

    assertDigest(active.profileTreeDigest, profile.digest, 'profile tree')
    assertDigest(active.presetTreeDigest, preset.digest, 'preset tree')
    assertDigest(active.skillsTreeDigest, skills.digest, 'skills tree')
    assertDigest(active.installationManifestDigest, manifestDigest, 'installation manifest')
    assertDigest(active.profileDependencyLockDigest, lockDigest, 'profile dependency lock')
    if (!options.ignoreHomePatchDrift && active.homePatchDigest !== homePatchDigest) {
      throw new GeoResearchError(
        'GEORESEARCH_HOME_PATCH_DRIFT',
        `home patch digest ${homePatchDigest} does not match activated ${active.homePatchDigest}`,
      )
    }

    assertDigest(manifest.profileTreeDigest, profile.digest, 'manifest profile tree')
    assertDigest(manifest.presetTreeDigest, preset.digest, 'manifest preset tree')
    assertDigest(manifest.skillsTreeDigest, skills.digest, 'manifest skills tree')
    assertDigest(manifest.profileDependencyLockDigest, lockDigest, 'manifest dependency lock')
    if (!options.ignoreHomePatchDrift) {
      assertDigest(manifest.homePatchDigest, homePatchDigest, 'manifest home patch')
    }
    assertDigest(profileMarker.managedTreeDigest, profile.digest, 'profile generation marker tree')
    assertDigest(presetMarker.managedTreeDigest, preset.digest, 'preset generation marker tree')

    if (integrations !== undefined) {
      if (integrations.productVersion !== active.productVersion) {
        throw new Error(
          `profile integrations version ${integrations.productVersion} does not match active ${active.productVersion}`,
        )
      }
      const sharedPackages = await digestTree(paths.sharedPackagesRoot)
      assertDigest(
        integrations.sharedPackagesTreeDigest,
        sharedPackages.digest,
        'shared GeoResearch package tree',
      )
      const dependencyVersions = await dependencyVersionsFromLock(paths.dependencyLockPath)
      await validateIntegratedProfiles(paths, integrations, dependencyVersions)
    }

    await validateManagedFiles(paths, manifest)
    await assertNoIncompleteTransactions(paths, options.allowedTransactionId)

    return {
      paths,
      active,
      manifest,
      ...(integrations === undefined ? {} : { integrations }),
      profileFileCount: profile.files.length,
      presetFileCount: preset.files.length,
      skillFileCount: skills.files.length,
    }
  } catch (error) {
    if (error instanceof GeoResearchError) throw error
    throw new GeoResearchError(
      'GEORESEARCH_INSTALLATION_INCOMPLETE',
      `managed installation validation failed: ${errorMessage(error)}`,
      { cause: error },
    )
  }
}

export async function digestOptionalFile(path: string): Promise<Sha256Digest> {
  try {
    return sha256Bytes(await readFile(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return sha256Bytes(new Uint8Array())
    throw error
  }
}

export async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

export async function readProfileIntegrationsIfPresent(
  path: string,
): Promise<ProfileIntegrationsRecord | undefined> {
  try {
    return parseProfileIntegrationsRecord(await readJson(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function assertNoIncompleteTransactions(
  paths: InstallationPaths,
  allowedTransactionId?: string,
): Promise<void> {
  let entries
  try {
    entries = await readdir(paths.transactionsRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === allowedTransactionId) continue
    const journalPath = join(paths.transactionsRoot, entry.name, 'journal.json')
    let journal: InstallerJournal
    try {
      journal = await readJson(journalPath) as InstallerJournal
    } catch (error) {
      throw new GeoResearchError(
        'INSTALLATION_TRANSACTION_PENDING',
        `transaction ${entry.name} has no readable journal: ${errorMessage(error)}`,
      )
    }
    if (journal.stage !== 'committed' && journal.stage !== 'uninstall-committed') {
      throw new GeoResearchError(
        'INSTALLATION_TRANSACTION_PENDING',
        `transaction ${entry.name} remains at stage ${String(journal.stage)}`,
      )
    }
  }
}

async function validateManagedFiles(paths: InstallationPaths, manifest: InstallationManifest): Promise<void> {
  for (const file of manifest.managedFiles) {
    const root = file.root === 'profile'
      ? paths.profileRoot
      : file.root === 'preset'
        ? paths.presetRoot
        : paths.installationRoot
    const path = resolve(root, file.path)
    const rootPrefix = `${resolve(root)}\\`.toLowerCase()
    if (path.toLowerCase() !== resolve(root).toLowerCase() && !path.toLowerCase().startsWith(rootPrefix)) {
      throw new Error(`managed file escapes ${file.root} root: ${file.path}`)
    }
    const info = await stat(path)
    if (!info.isFile() || info.size !== file.size) {
      throw new Error(`managed file size/type mismatch: ${file.root}/${file.path}`)
    }
    assertDigest(file.digest, await digestFile(path), `managed file ${file.root}/${file.path}`)
  }
}

async function dependencyVersionsFromLock(path: string): Promise<ReadonlyMap<string, string>> {
  const value = await readJson(path)
  const record = objectRecord(value, 'dependency lock')
  if (!Array.isArray(record.packages)) throw new TypeError('dependency lock packages must be an array')
  const versions = new Map<string, string>()
  for (const [index, value] of record.packages.entries()) {
    const entry = objectRecord(value, `dependency lock packages[${index}]`)
    if (typeof entry.name !== 'string' || !entry.name.startsWith('@georesearch/')
      || typeof entry.version !== 'string') {
      throw new TypeError(`dependency lock packages[${index}] is invalid`)
    }
    if (versions.has(entry.name)) throw new TypeError(`dependency lock package is duplicated: ${entry.name}`)
    versions.set(entry.name, entry.version)
  }
  if (versions.size === 0) throw new TypeError('dependency lock contains no GeoResearch packages')
  return versions
}

async function validateIntegratedProfiles(
  paths: InstallationPaths,
  integrations: ProfileIntegrationsRecord,
  dependencyVersions: ReadonlyMap<string, string>,
): Promise<void> {
  for (const integration of integrations.profiles) {
    const packagePath = join(paths.home, 'profiles', integration.profileName, 'package.json')
    const manifest = objectRecord(await readJson(packagePath), `${integration.profileName} package.json`)
    const dependencies = objectRecord(manifest.dependencies, `${integration.profileName} dependencies`)
    for (const [packageName, version] of dependencyVersions) {
      if (dependencies[packageName] !== version) {
        throw new Error(`integrated Profile dependency mismatch: ${integration.profileName}/${packageName}`)
      }
    }
    const dsh = objectRecord(manifest.dsh, `${integration.profileName} dsh`)
    const profile = objectRecord(dsh.profile, `${integration.profileName} dsh.profile`)
    if (!Array.isArray(profile.bundles) || !profile.bundles.every(value => typeof value === 'string')) {
      throw new TypeError(`${integration.profileName} dsh.profile.bundles must be a string array`)
    }
    const bundles = profile.bundles as string[]
    const webIndex = bundles.indexOf(WEB_APP_BUNDLE_PACKAGE)
    const georesearchIndexes = bundles
      .map((name, index) => name === GEORESEARCH_BUNDLE_PACKAGE ? index : -1)
      .filter(index => index >= 0)
    if (webIndex < 0 || georesearchIndexes.length !== 1 || georesearchIndexes[0]! <= webIndex) {
      throw new Error(`integrated Profile bundle order is invalid: ${integration.profileName}`)
    }
  }
}

function objectRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function assertIdentity(
  active: ActiveInstallationRecord,
  installationId: string,
  generation: number,
  source: string,
): void {
  if (active.installationId !== installationId || active.generation !== generation) {
    throw new GeoResearchError(
      'GEORESEARCH_INSTALLATION_GENERATION_MISMATCH',
      `${source} is ${installationId}/${generation}, active is ${active.installationId}/${active.generation}`,
    )
  }
}

function assertDigest(expected: Sha256Digest, actual: Sha256Digest, source: string): void {
  if (expected !== actual) {
    throw new GeoResearchError(
      'GEORESEARCH_INSTALLATION_GENERATION_MISMATCH',
      `${source} digest ${actual} does not match expected ${expected}`,
    )
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
