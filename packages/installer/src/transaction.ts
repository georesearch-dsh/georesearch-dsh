import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEPENDENCY_LOCK_FILE,
  GENERATION_MARKER_FILE,
  GeoResearchError,
  PRESET_ID,
  PROFILE_INTEGRATIONS_FILE,
  PRODUCT_VERSION,
  PROFILE_ROOT_FILE,
  PROFILE_ID,
  digestFile,
  digestTree,
  nowUtc,
  parseActiveInstallationRecord,
  sha256Bytes,
  type ActiveInstallationRecord,
  type InstallationGenerationMarker,
  type InstallationManifest,
  type InstallerJournal,
  type InstallerJournalStage,
  type ManagedFileRecord,
  type MaintenanceNonceRecord,
  type ProfileIntegrationsRecord,
  type Sha256Digest,
} from '@georesearch/dsh-contracts'
import {
  digestOptionalFile,
  installationPaths,
  readJson,
  readProfileIntegrationsIfPresent,
  validateInstallation,
  type InstallationPaths,
} from '@georesearch/dsh-installation-guard/validation'
import { protectMaintenanceNonce } from '@georesearch/dsh-installation-guard/nonce-protection'
import {
  createOperatorScopeRecord,
  parseOperatorScopeRecord,
  rebindOperatorScopeRecord,
  type OperatorScopeRecord,
} from '@georesearch/dsh-installation-guard/operator-scope'
import { acquireRuntimeLease, type RuntimeLease } from '@georesearch/dsh-runtime-lease'
import { atomicWriteFile, atomicWriteJson, movePathWriteThrough } from './atomic.js'
import {
  RUNTIME_PACKAGE_NAMES,
  loadDistribution,
  type LoadedDistribution,
} from './distribution.js'
import {
  copyDirectory,
  copyProfileDirectoryForProbe,
  copyFileIfPresent,
  pathExists,
  publishDirectory,
  removeTree,
  restoreDirectory,
} from './filesystem.js'
import { acquireInstallerMutex } from './mutex.js'
import { assertManagedDirectoriesReplaceable } from './preflight.js'
import {
  runHarnessDump,
  runHarnessRuntimeProbe,
  runMaintenanceGuardProbe,
  runPresetImportProbe,
  verifyCandidateShape,
  type CandidateProfileRoot,
} from './probe.js'
import {
  assertProfilePlanUnchanged,
  journalProfileIntegrations,
  planProfileIntegrations,
  planProfileRemoval,
  type ProfileIntegrationPlan,
} from './profile-integration.js'

export interface MutationOptions {
  readonly home: string
  readonly distributionDir: string
  readonly harnessRoot?: string
}

export interface VerifyOptions {
  readonly home: string
  readonly harnessRoot?: string
}

export interface InstallerResult {
  readonly operation: 'install' | 'upgrade' | 'verify' | 'uninstall' | 'recover' | 'reconcile-home-patch'
  readonly installationId?: string
  readonly generation?: number
  readonly productVersion?: string
  readonly transactionId?: string
  readonly dumpConfigVerified?: boolean
  readonly runtimeProbeVerified?: boolean
  readonly recoveryAction?: 'rollback-to-previous-generation' | 'complete-committed-generation'
}

type InstallOperation = 'install' | 'upgrade' | 'reconcile-home-patch'

const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

interface HomePatchSnapshot {
  readonly present: boolean
  readonly bytes: Uint8Array
  readonly digest: Sha256Digest
}

interface Candidate {
  readonly stageHome: string
  readonly profileRoot: string
  readonly sharedPackagesRoot: string
  readonly presetRoot: string
  readonly installationRoot: string
  readonly integratedProfiles: readonly CandidateProfileRoot[]
  readonly manifest: InstallationManifest
  readonly active: ActiveInstallationRecord
  readonly operatorScope: OperatorScopeRecord
}

export async function install(options: MutationOptions): Promise<InstallerResult> {
  return mutateInstallation('install', options)
}

export async function upgrade(options: MutationOptions): Promise<InstallerResult> {
  return mutateInstallation('upgrade', options)
}

export async function reconcileHomePatch(options: MutationOptions): Promise<InstallerResult> {
  return mutateInstallation('reconcile-home-patch', options)
}

export async function verify(options: VerifyOptions): Promise<InstallerResult> {
  assertSupportedNode()
  await assertHarnessBaseline(options.harnessRoot)
  const validation = await validateInstallation(options.home)
  await runHarnessProfileProbes(
    options.home,
    validation.integrations?.profiles.map(profile => profile.profileName) ?? [],
    options.harnessRoot,
  )
  if (options.harnessRoot !== undefined) {
    await runHarnessRuntimeProbe({
      home: options.home,
      harnessRoot: options.harnessRoot,
      profileName: PROFILE_ID,
      reportPath: join(validation.paths.installationRoot, 'phase1-runtime-probe.json'),
      workspaceRoot: join(validation.paths.installationRoot, 'phase1-runtime-workspace'),
      expectedInstallationId: validation.active.installationId,
      expectedGeneration: validation.active.generation,
    })
  }
  return {
    operation: 'verify',
    installationId: validation.active.installationId,
    generation: validation.active.generation,
    productVersion: validation.active.productVersion,
    dumpConfigVerified: options.harnessRoot !== undefined,
    runtimeProbeVerified: options.harnessRoot !== undefined,
  }
}

export async function uninstall(options: VerifyOptions): Promise<InstallerResult> {
  assertSupportedNode()
  await assertHarnessBaseline(options.harnessRoot)
  let validation
  try {
    validation = await validateInstallation(options.home, { ignoreHomePatchDrift: true })
  } catch (error) {
    if (error instanceof GeoResearchError
      && error.code === 'GEORESEARCH_INSTALLATION_GENERATION_MISMATCH') {
      throw new GeoResearchError(
        'INSTALLATION_FILE_MODIFIED',
        'a managed package, integrated Profile field, Preset, Skill, marker, manifest, or dependency lock was modified',
        { cause: error },
      )
    }
    throw error
  }
  const paths = validation.paths
  const mutex = await acquireInstallerMutex(options.home)
  let runtimeLease: RuntimeLease | undefined
  let transactionId: string | undefined
  try {
    runtimeLease = await acquireRuntimeLease(options.home)
    await assertManagedDirectoriesReplaceable(paths)
    await assertNoRecoveryRequired(paths)
    const integrationPlan = await planProfileRemoval(
      options.home,
      validation.integrations?.profiles.map(profile => profile.profileName) ?? [],
      validation.active.productVersion,
    )
    const hadSharedPackages = await pathExists(paths.sharedPackagesRoot)
    const hadOperatorScope = await pathExists(paths.operatorScopePath)
    transactionId = randomUUID()
    const transactionRoot = join(paths.transactionsRoot, transactionId)
    await mkdir(transactionRoot, { recursive: true })
    let journal: InstallerJournal = {
      schemaVersion: 1,
      transactionId,
      operation: 'uninstall',
      installationId: validation.active.installationId,
      generation: validation.active.generation + 1,
      stage: 'created',
      startedAt: nowUtc(),
      previousGeneration: validation.active.generation,
      hadProfile: true,
      hadPreset: true,
      hadActiveRecord: true,
      hadSharedPackages,
      hadOperatorScope,
      profileIntegrations: journalProfileIntegrations(integrationPlan),
    }
    await writeJournal(transactionRoot, journal)
    const backupInstallation = join(transactionRoot, 'backup-installation')
    await mkdir(backupInstallation, { recursive: true })
    await copyFileIfPresent(paths.activePath, join(backupInstallation, 'active.json'))
    await copyFileIfPresent(paths.manifestPath, join(backupInstallation, 'manifest.json'))
    await copyFileIfPresent(paths.operatorScopePath, join(backupInstallation, 'operator-scope.json'))

    await assertProfilePlanUnchanged(integrationPlan)
    await backupProfilePlan(integrationPlan, transactionRoot)
    await publishProfilePlan(integrationPlan)
    if (hadSharedPackages) {
      await movePathWriteThrough(paths.sharedPackagesRoot, join(transactionRoot, 'backup-shared-packages'))
    }
    await movePathWriteThrough(paths.profileRoot, join(transactionRoot, 'backup-profile'))
    await movePathWriteThrough(paths.presetRoot, join(transactionRoot, 'backup-preset'))
    journal = await advanceJournal(transactionRoot, journal, 'uninstall-staged')

    await movePathWriteThrough(paths.activePath, join(transactionRoot, 'active.removed.json'))
    await rm(paths.manifestPath, { force: true })
    await rm(paths.operatorScopePath, { force: true })
    journal = await advanceJournal(transactionRoot, journal, 'uninstall-committed')
    await removeTree(transactionRoot)
    return {
      operation: 'uninstall',
      installationId: journal.installationId,
      generation: journal.generation,
      productVersion: PRODUCT_VERSION,
      transactionId,
    }
  } catch (error) {
    if (transactionId !== undefined) {
      throw new GeoResearchError(
        'INSTALLATION_RECOVERY_REQUIRED',
        `uninstall transaction ${transactionId} did not complete; run recover`,
        { cause: error },
      )
    }
    throw error
  } finally {
    try {
      await runtimeLease?.release()
    } finally {
      await mutex.release()
    }
  }
}

export async function recover(options: VerifyOptions): Promise<InstallerResult> {
  const paths = installationPaths(options.home)
  const mutex = await acquireInstallerMutex(options.home)
  let runtimeLease: RuntimeLease | undefined
  try {
    runtimeLease = await acquireRuntimeLease(options.home)
    await assertManagedDirectoriesReplaceable(paths)
    const transactions = await transactionDirectories(paths)
    if (transactions.length === 0) {
      throw new GeoResearchError('INSTALLATION_NOT_FOUND', 'no installer transaction requires recovery')
    }
    if (transactions.length > 1) {
      throw new GeoResearchError(
        'INSTALLATION_RECOVERY_REQUIRED',
        `multiple transactions require operator review: ${transactions.join(', ')}`,
      )
    }
    const transactionId = transactions[0] as string
    const transactionRoot = join(paths.transactionsRoot, transactionId)
    const journal = await readJson(join(transactionRoot, 'journal.json')) as InstallerJournal
    const active = await readActiveIfPresent(paths.activePath)
    const committed = journal.operation === 'uninstall'
      ? active === undefined
      : active?.installationId === journal.installationId && active.generation === journal.generation

    if (committed) {
      if (journal.operation === 'uninstall') {
        await rm(paths.profileRoot, { recursive: true, force: true })
        await rm(paths.sharedPackagesRoot, { recursive: true, force: true })
        await rm(paths.presetRoot, { recursive: true, force: true })
        await rm(paths.manifestPath, { force: true })
        await rm(paths.operatorScopePath, { force: true })
      } else {
        await validateInstallation(options.home, { allowedTransactionId: transactionId })
      }
      await removeTree(transactionRoot)
      return {
        operation: 'recover',
        installationId: journal.installationId,
        generation: journal.generation,
        productVersion: PRODUCT_VERSION,
        transactionId,
        recoveryAction: 'complete-committed-generation',
      }
    }

    await rollbackTransaction(paths, transactionRoot, journal)
    if (journal.hadActiveRecord) {
      await validateInstallation(options.home, { allowedTransactionId: transactionId })
    }
    await removeTree(transactionRoot)
    return {
      operation: 'recover',
      installationId: journal.installationId,
      ...(journal.previousGeneration === undefined ? {} : { generation: journal.previousGeneration }),
      productVersion: PRODUCT_VERSION,
      transactionId,
      recoveryAction: 'rollback-to-previous-generation',
    }
  } finally {
    try {
      await runtimeLease?.release()
    } finally {
      await mutex.release()
    }
  }
}

async function mutateInstallation(operation: InstallOperation, options: MutationOptions): Promise<InstallerResult> {
  assertSupportedNode()
  await assertHarnessBaseline(options.harnessRoot)
  const distribution = await loadDistribution(options.distributionDir)
  const paths = installationPaths(options.home)
  const existing = await readActiveIfPresent(paths.activePath)
  if (operation === 'install' && existing !== undefined) {
    throw new GeoResearchError('INSTALLATION_ALREADY_ACTIVE', 'use upgrade for an existing installation')
  }
  if (operation !== 'install' && existing === undefined) {
    throw new GeoResearchError('INSTALLATION_NOT_FOUND', `${operation} requires an active installation`)
  }

  const mutex = await acquireInstallerMutex(options.home)
  let runtimeLease: RuntimeLease | undefined
  let transactionId: string | undefined
  try {
    runtimeLease = await acquireRuntimeLease(options.home)
    await assertManagedDirectoriesReplaceable(paths)
    await assertNoRecoveryRequired(paths)
    const refreshedActive = await readActiveIfPresent(paths.activePath)
    if (refreshedActive?.generation !== existing?.generation
      || refreshedActive?.installationId !== existing?.installationId) {
      throw new GeoResearchError('INSTALLATION_RECOVERY_REQUIRED', 'active installation changed during preflight')
    }
    const previousIntegrations = existing === undefined
      ? undefined
      : await readProfileIntegrationsIfPresent(paths.profileIntegrationsPath)
    const hadSharedPackages = await pathExists(paths.sharedPackagesRoot)
    if (hadSharedPackages && previousIntegrations === undefined) {
      throw new Error(
        `unmanaged GeoResearch package scope already exists: ${paths.sharedPackagesRoot}`,
      )
    }
    if (!hadSharedPackages && previousIntegrations !== undefined) {
      throw new Error('managed GeoResearch shared package scope is missing')
    }
    const integrationPlan = await planProfileIntegrations(
      options.home,
      previousIntegrations?.profiles.map(profile => profile.profileName) ?? [],
      existing?.productVersion,
    )

    transactionId = randomUUID()
    const transactionRoot = join(paths.transactionsRoot, transactionId)
    await mkdir(transactionRoot, { recursive: true })
    const generation = (existing?.generation ?? 0) + 1
    const installationId = existing?.installationId ?? randomUUID()
    const hadProfile = await pathExists(paths.profileRoot)
    const hadPreset = await pathExists(paths.presetRoot)
    const hadOperatorScope = await pathExists(paths.operatorScopePath)
    let journal: InstallerJournal = {
      schemaVersion: 1,
      transactionId,
      operation,
      installationId,
      generation,
      stage: 'created',
      startedAt: nowUtc(),
      ...(existing === undefined ? {} : { previousGeneration: existing.generation }),
      hadProfile,
      hadPreset,
      hadActiveRecord: existing !== undefined,
      hadSharedPackages,
      hadOperatorScope,
      profileIntegrations: journalProfileIntegrations(integrationPlan),
    }
    await writeJournal(transactionRoot, journal)

    const homePatch = await snapshotHomePatch(paths.homePatchPath)
    const operatorScope = hadOperatorScope
      ? parseOperatorScopeRecord(await readJson(paths.operatorScopePath))
      : await createOperatorScopeRecord(options.home, installationId)
    const candidate = await buildCandidate(
      transactionRoot,
      distribution,
      installationId,
      generation,
      homePatch,
      integrationPlan,
      options.home,
      operatorScope,
    )
    await validateInstallation(candidate.stageHome)
    await verifyCandidateShape(
      candidate.profileRoot,
      candidate.sharedPackagesRoot,
      candidate.presetRoot,
      candidate.integratedProfiles,
      distribution,
    )
    await runHarnessProfileProbes(
      candidate.stageHome,
      candidate.integratedProfiles.map(profile => profile.profileName),
      options.harnessRoot,
      transactionRoot,
      'staged',
    )
    journal = await advanceJournal(transactionRoot, journal, 'candidate-verified')

    await mkdir(join(transactionRoot, 'backup-installation'), { recursive: true })
    await copyFileIfPresent(paths.activePath, join(transactionRoot, 'backup-installation', 'active.json'))
    await copyFileIfPresent(paths.manifestPath, join(transactionRoot, 'backup-installation', 'manifest.json'))
    await copyFileIfPresent(
      paths.operatorScopePath,
      join(transactionRoot, 'backup-installation', 'operator-scope.json'),
    )

    await assertProfilePlanUnchanged(integrationPlan)
    await backupProfilePlan(integrationPlan, transactionRoot)
    await publishDirectory(candidate.profileRoot, paths.profileRoot, join(transactionRoot, 'backup-profile'))
    await publishDirectory(
      candidate.sharedPackagesRoot,
      paths.sharedPackagesRoot,
      join(transactionRoot, 'backup-shared-packages'),
    )
    await publishProfilePlan(integrationPlan)
    journal = await advanceJournal(transactionRoot, journal, 'profile-published')
    await publishDirectory(candidate.presetRoot, paths.presetRoot, join(transactionRoot, 'backup-preset'))
    journal = await advanceJournal(transactionRoot, journal, 'preset-published')

    await atomicWriteFile(paths.manifestPath, await readFile(join(candidate.installationRoot, 'manifest.json')))
    await atomicWriteJson(paths.operatorScopePath, candidate.operatorScope)
    journal = await advanceJournal(transactionRoot, journal, 'manifest-published')

    await assertHomePatchUnchanged(paths.homePatchPath, homePatch)
    await validateInstallation(options.home, {
      activeOverride: candidate.active,
      allowedTransactionId: transactionId,
    })
    await runHarnessProfileProbes(
      options.home,
      candidate.integratedProfiles.map(profile => profile.profileName),
      options.harnessRoot,
      transactionRoot,
      'real',
    )

    const nonce = randomBytes(32).toString('base64url')
    const deadline = new Date(Date.now() + 60_000).toISOString()
    const binding = {
      transactionId,
      generation,
      executable: process.execPath,
      deadline,
    }
    const protectedNonce = await protectMaintenanceNonce(nonce, binding)
    const maintenance: MaintenanceNonceRecord = {
      schemaVersion: 1,
      ...binding,
      nonceDigest: sha256Bytes(Buffer.from(nonce, 'utf8')),
      protection: protectedNonce.protection,
    }
    await atomicWriteJson(join(transactionRoot, 'maintenance.json'), maintenance)
    if (options.harnessRoot === undefined) {
      await runMaintenanceGuardProbe(
        fileURLToPath(new URL('./maintenance-probe.js', import.meta.url)),
        options.home,
        transactionId,
        protectedNonce.value,
      )
    } else {
      await runHarnessRuntimeProbe({
        home: options.home,
        harnessRoot: options.harnessRoot,
        profileName: PROFILE_ID,
        reportPath: join(transactionRoot, 'phase1-runtime-probe.json'),
        workspaceRoot: join(transactionRoot, 'phase1-runtime-workspace'),
        expectedInstallationId: installationId,
        expectedGeneration: generation,
        extraEnv: {
          GEORESEARCH_MAINTENANCE_TRANSACTION: transactionId,
          GEORESEARCH_MAINTENANCE_PROTECTED_NONCE: protectedNonce.value,
        },
      })
    }
    journal = await advanceJournal(transactionRoot, journal, 'activation-probed')

    await assertHomePatchUnchanged(paths.homePatchPath, homePatch)
    const committedActive: ActiveInstallationRecord = { ...candidate.active, activatedAt: nowUtc() }
    await atomicWriteJson(paths.activePath, committedActive)
    journal = await advanceJournal(transactionRoot, journal, 'committed')
    await removeTree(transactionRoot)
    return {
      operation,
      installationId,
      generation,
      productVersion: PRODUCT_VERSION,
      transactionId,
      dumpConfigVerified: options.harnessRoot !== undefined,
      runtimeProbeVerified: options.harnessRoot !== undefined,
    }
  } catch (error) {
    if (transactionId !== undefined) {
      throw new GeoResearchError(
        'INSTALLATION_RECOVERY_REQUIRED',
        `${operation} transaction ${transactionId} did not complete; run recover`,
        { cause: error },
      )
    }
    throw error
  } finally {
    try {
      await runtimeLease?.release()
    } finally {
      await mutex.release()
    }
  }
}

async function buildCandidate(
  transactionRoot: string,
  distribution: LoadedDistribution,
  installationId: string,
  generation: number,
  homePatch: HomePatchSnapshot,
  integrationPlan: ProfileIntegrationPlan,
  targetHome: string,
  operatorScope: OperatorScopeRecord,
): Promise<Candidate> {
  const stageHome = join(transactionRoot, 'staged-home')
  const stagePaths = installationPaths(stageHome)
  await mkdir(stagePaths.profileRoot, { recursive: true })
  await mkdir(dirname(stagePaths.sharedPackagesRoot), { recursive: true })
  await mkdir(dirname(stagePaths.presetRoot), { recursive: true })
  await mkdir(stagePaths.installationRoot, { recursive: true })
  const stageOperatorScope = await rebindOperatorScopeRecord(
    operatorScope,
    targetHome,
    stageHome,
    installationId,
  )
  await atomicWriteJson(stagePaths.operatorScopePath, stageOperatorScope)

  const dependencies = Object.fromEntries(RUNTIME_PACKAGE_NAMES.map(name => [name, PRODUCT_VERSION]))
  await atomicWriteJson(join(stagePaths.profileRoot, 'package.json'), {
    name: 'dsh-profile-georesearch',
    private: true,
    dependencies,
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@georesearch/dsh-bundle'],
      },
    },
  })
  await atomicWriteFile(join(stagePaths.profileRoot, PROFILE_ROOT_FILE), PROFILE_ROOT_CONFIG)
  await atomicWriteFile(join(stagePaths.profileRoot, 'cordis.patch.yml'), '[]\n')
  await atomicWriteFile(
    join(stagePaths.profileRoot, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
  )

  for (const packageName of RUNTIME_PACKAGE_NAMES) {
    const source = distribution.packageDirectories.get(packageName)
    if (source === undefined) throw new Error(`distribution package vanished: ${packageName}`)
    await copyDirectory(source, join(stagePaths.sharedPackagesRoot, packageName.split('/')[1] as string))
  }
  const integratedProfiles: CandidateProfileRoot[] = []
  for (const planned of integrationPlan.profiles) {
    const profileRoot = join(stageHome, 'profiles', planned.profileName)
    if (await pathExists(planned.sourceRoot)) {
      await copyProfileDirectoryForProbe(planned.sourceRoot, profileRoot)
    } else {
      await mkdir(profileRoot, { recursive: true })
    }
    for (const mutation of planned.mutations) {
      await atomicWriteFile(join(profileRoot, mutation.path), mutation.bytes)
    }
    integratedProfiles.push({ profileName: planned.profileName, profileRoot })
  }
  await copyDirectory(distribution.pythonRoot, join(stagePaths.profileRoot, 'python'))
  await copyDirectory(distribution.presetRoot, stagePaths.presetRoot)
  if (homePatch.present) await atomicWriteFile(stagePaths.homePatchPath, homePatch.bytes)

  const lock = {
    schemaVersion: 1,
    productVersion: PRODUCT_VERSION,
    packages: distribution.manifest.packages
      .filter(entry => RUNTIME_PACKAGE_NAMES.includes(entry.name as never))
      .map(entry => ({ name: entry.name, version: entry.version, treeDigest: entry.treeDigest }))
      .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
    pythonTreeDigest: distribution.manifest.pythonTreeDigest,
  }
  await atomicWriteJson(join(stagePaths.profileRoot, DEPENDENCY_LOCK_FILE), lock)
  const sharedPackages = await digestTree(stagePaths.sharedPackagesRoot)
  const integrations: ProfileIntegrationsRecord = {
    schemaVersion: 1,
    productVersion: PRODUCT_VERSION,
    sharedPackagesTreeDigest: sharedPackages.digest,
    profiles: integratedProfiles.map(profile => ({ profileName: profile.profileName })),
  }
  await atomicWriteJson(join(stagePaths.profileRoot, PROFILE_INTEGRATIONS_FILE), integrations)
  const lockDigest = await digestFile(join(stagePaths.profileRoot, DEPENDENCY_LOCK_FILE))
  const profile = await digestTree(stagePaths.profileRoot, {
    exclude: new Set([PROFILE_ROOT_FILE]),
  })
  const preset = await digestTree(stagePaths.presetRoot)
  const skills = await digestTree(stagePaths.skillsRoot)
  const profileMarker: InstallationGenerationMarker = {
    schemaVersion: 1,
    installationId,
    generation,
    productVersion: PRODUCT_VERSION,
    managedTreeDigest: profile.digest,
  }
  const presetMarker: InstallationGenerationMarker = {
    schemaVersion: 1,
    installationId,
    generation,
    productVersion: PRODUCT_VERSION,
    managedTreeDigest: preset.digest,
  }
  await atomicWriteJson(join(stagePaths.profileRoot, GENERATION_MARKER_FILE), profileMarker)
  await atomicWriteJson(join(stagePaths.presetRoot, GENERATION_MARKER_FILE), presetMarker)

  const managedFiles: ManagedFileRecord[] = [
    ...profile.files.map(file => ({ root: 'profile' as const, ...file })),
    ...preset.files.map(file => ({ root: 'preset' as const, ...file })),
  ]
  const manifest: InstallationManifest = {
    schemaVersion: 1,
    installationId,
    generation,
    productVersion: PRODUCT_VERSION,
    profileId: PROFILE_ID,
    presetId: PRESET_ID,
    profileTreeDigest: profile.digest,
    presetTreeDigest: preset.digest,
    skillsTreeDigest: skills.digest,
    profileDependencyLockDigest: lockDigest,
    homePatchDigest: homePatch.digest,
    managedFiles,
    createdAt: nowUtc(),
  }
  await atomicWriteJson(stagePaths.manifestPath, manifest)
  const active: ActiveInstallationRecord = {
    schemaVersion: 1,
    installationId,
    generation,
    productVersion: PRODUCT_VERSION,
    state: 'active',
    profileTreeDigest: profile.digest,
    presetTreeDigest: preset.digest,
    skillsTreeDigest: skills.digest,
    installationManifestDigest: await digestFile(stagePaths.manifestPath),
    profileDependencyLockDigest: lockDigest,
    homePatchDigest: homePatch.digest,
    activatedAt: nowUtc(),
  }
  await atomicWriteJson(stagePaths.activePath, active)
  return {
    stageHome,
    profileRoot: stagePaths.profileRoot,
    sharedPackagesRoot: stagePaths.sharedPackagesRoot,
    presetRoot: stagePaths.presetRoot,
    installationRoot: stagePaths.installationRoot,
    integratedProfiles,
    manifest,
    active,
    operatorScope,
  }
}

async function rollbackTransaction(
  paths: InstallationPaths,
  transactionRoot: string,
  journal: InstallerJournal,
): Promise<void> {
  await restoreDirectory(paths.profileRoot, join(transactionRoot, 'backup-profile'), journal.hadProfile)
  await restoreDirectory(
    paths.sharedPackagesRoot,
    join(transactionRoot, 'backup-shared-packages'),
    journal.hadSharedPackages ?? false,
  )
  await restoreDirectory(paths.presetRoot, join(transactionRoot, 'backup-preset'), journal.hadPreset)
  await restoreJournalProfileFiles(paths.home, transactionRoot, journal)
  const backupInstallation = join(transactionRoot, 'backup-installation')
  await restoreFile(
    paths.activePath,
    join(backupInstallation, 'active.json'),
    journal.hadActiveRecord,
  )
  await restoreFile(
    paths.manifestPath,
    join(backupInstallation, 'manifest.json'),
    journal.hadActiveRecord,
  )
  await restoreFile(
    paths.operatorScopePath,
    join(backupInstallation, 'operator-scope.json'),
    journal.hadOperatorScope ?? false,
  )
}

async function backupProfilePlan(plan: ProfileIntegrationPlan, transactionRoot: string): Promise<void> {
  for (const profile of plan.profiles) {
    for (const mutation of profile.mutations) {
      if (!mutation.snapshot.present) continue
      await atomicWriteFile(
        join(transactionRoot, 'backup-integrations', profile.profileName, mutation.path),
        mutation.snapshot.bytes,
      )
    }
  }
}

async function publishProfilePlan(plan: ProfileIntegrationPlan): Promise<void> {
  await assertProfilePlanUnchanged(plan)
  for (const profile of plan.profiles) {
    for (const mutation of profile.mutations) {
      await atomicWriteFile(join(profile.sourceRoot, mutation.path), mutation.bytes)
    }
  }
}

async function restoreJournalProfileFiles(
  home: string,
  transactionRoot: string,
  journal: InstallerJournal,
): Promise<void> {
  for (const integration of journal.profileIntegrations ?? []) {
    assertProfileName(integration.profileName)
    for (const file of integration.files) {
      assertProfileMutationPath(file.path)
      await restoreFile(
        join(home, 'profiles', integration.profileName, file.path),
        join(transactionRoot, 'backup-integrations', integration.profileName, file.path),
        file.existedBefore,
      )
    }
  }
}

async function runHarnessProfileProbes(
  home: string,
  integratedProfileNames: readonly string[],
  harnessRoot: string | undefined,
  outputRoot?: string,
  outputPrefix?: string,
): Promise<void> {
  if (harnessRoot === undefined) return
  const profileNames = [PROFILE_ID, ...integratedProfileNames]
  for (const profileName of profileNames) {
    assertProfileName(profileName)
    await runHarnessDump({
      home,
      harnessRoot,
      profileName,
      ...(outputRoot === undefined || outputPrefix === undefined ? {} : {
        outputPath: join(outputRoot, `${outputPrefix}-${profileName}-dump-config.yml`),
      }),
    })
    await runPresetImportProbe(join(home, 'profiles', profileName))
  }
}

function assertProfileName(profileName: string): void {
  if (profileName.length === 0 || profileName === '.' || profileName === '..' || profileName === 'node_modules'
    || profileName.includes('/') || profileName.includes('\\')) {
    throw new Error(`invalid Profile name in installer transaction: ${profileName}`)
  }
}

function assertProfileMutationPath(path: string): void {
  if (path !== 'package.json' && path !== 'cordis.patch.yml' && path !== 'pnpm-workspace.yaml') {
    throw new Error(`invalid Profile file in installer transaction: ${path}`)
  }
}

async function restoreFile(target: string, backup: string, existedBefore: boolean): Promise<void> {
  if (await pathExists(backup)) {
    await atomicWriteFile(target, await readFile(backup))
    return
  }
  if (!existedBefore) {
    await rm(target, { force: true })
    return
  }
  if (!await pathExists(target)) throw new Error(`recovery backup and original are both missing: ${target}`)
}

async function snapshotHomePatch(path: string): Promise<HomePatchSnapshot> {
  let handle
  try {
    handle = await open(path, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const bytes = new Uint8Array()
      return { present: false, bytes, digest: sha256Bytes(bytes) }
    }
    throw error
  }
  try {
    const bytes = await handle.readFile()
    return { present: true, bytes, digest: sha256Bytes(bytes) }
  } finally {
    await handle.close()
  }
}

async function assertHomePatchUnchanged(path: string, snapshot: HomePatchSnapshot): Promise<void> {
  const current = await digestOptionalFile(path)
  if (current !== snapshot.digest) {
    throw new GeoResearchError(
      'GEORESEARCH_HOME_PATCH_DRIFT',
      `home patch changed during transaction: ${snapshot.digest} -> ${current}`,
    )
  }
}

async function writeJournal(transactionRoot: string, journal: InstallerJournal): Promise<void> {
  await atomicWriteJson(join(transactionRoot, 'journal.json'), journal)
}

async function advanceJournal(
  transactionRoot: string,
  journal: InstallerJournal,
  stage: InstallerJournalStage,
): Promise<InstallerJournal> {
  const advanced = { ...journal, stage }
  await writeJournal(transactionRoot, advanced)
  if (process.env.NODE_ENV === 'test'
    && process.env.GEORESEARCH_INSTALLER_TEST_FAIL_AFTER === stage) {
    throw new Error(`GEORESEARCH_INSTALLER_TEST_FAILURE_AFTER:${stage}`)
  }
  return advanced
}

async function assertNoRecoveryRequired(paths: InstallationPaths): Promise<void> {
  const transactions = await transactionDirectories(paths)
  if (transactions.length > 0) {
    throw new GeoResearchError(
      'INSTALLATION_RECOVERY_REQUIRED',
      `transaction recovery is required before mutation: ${transactions.join(', ')}`,
    )
  }
}

async function transactionDirectories(paths: InstallationPaths): Promise<string[]> {
  let entries
  try {
    entries = await readdir(paths.transactionsRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  return entries.filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}

async function readActiveIfPresent(path: string): Promise<ActiveInstallationRecord | undefined> {
  try {
    return parseActiveInstallationRecord(await readJson(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    const cause = error as { cause?: NodeJS.ErrnoException }
    if (cause.cause?.code === 'ENOENT') return undefined
    throw error
  }
}

function assertSupportedNode(): void {
  const [majorText, minorText] = process.versions.node.split('.')
  const major = Number(majorText)
  const minor = Number(minorText)
  if (!Number.isSafeInteger(major) || !Number.isSafeInteger(minor)
    || major < 22 || (major === 22 && minor < 19) || major === 23) {
    throw new Error(`GeoResearch requires Node ^22.19.0 or >=24.0.0; found ${process.version}`)
  }
}

async function assertHarnessBaseline(harnessRoot: string | undefined): Promise<void> {
  if (harnessRoot === undefined) return
  const manifest = JSON.parse(await readFile(join(harnessRoot, 'package.json'), 'utf8')) as Record<string, unknown>
  if (manifest.version !== '0.1.0-rc.5') {
    throw new Error(`Harness version must be 0.1.0-rc.5; found ${String(manifest.version)}`)
  }
}
