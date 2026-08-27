import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  DEPENDENCY_LOCK_FILE,
  GENERATION_MARKER_FILE,
  digestFile,
  digestTree,
  nowUtc,
  type ActiveInstallationRecord,
  type InstallationGenerationMarker,
  type InstallationManifest,
  type InstallerJournal,
} from '@georesearch/dsh-contracts'
import { installationPaths, validateInstallation } from '../src/validation.js'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'georesearch-guard-'))
  await createValidInstallation(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('installation validation', () => {
  it('accepts a coherent active generation', async () => {
    const validation = await validateInstallation(root)
    expect(validation.active.generation).toBe(1)
    expect(validation.skillFileCount).toBe(1)
  })

  it('fails closed on Home Patch drift', async () => {
    await writeFile(installationPaths(root).homePatchPath, '- id: changed\n')
    await expect(validateInstallation(root)).rejects.toMatchObject({
      code: 'GEORESEARCH_HOME_PATCH_DRIFT',
    })
    await expect(validateInstallation(root, { ignoreHomePatchDrift: true })).resolves.toBeDefined()
  })

  it('fails closed on managed tree drift', async () => {
    await writeFile(join(installationPaths(root).profileRoot, 'unexpected.txt'), 'drift')
    await expect(validateInstallation(root)).rejects.toMatchObject({
      code: 'GEORESEARCH_INSTALLATION_GENERATION_MISMATCH',
    })
  })

  it('blocks incomplete transactions unless the maintenance transaction is explicitly allowed', async () => {
    const paths = installationPaths(root)
    const transactionId = 'transaction-1'
    const transactionRoot = join(paths.transactionsRoot, transactionId)
    await mkdir(transactionRoot, { recursive: true })
    const journal: InstallerJournal = {
      schemaVersion: 1,
      transactionId,
      operation: 'upgrade',
      installationId: 'installation-1',
      generation: 2,
      stage: 'manifest-published',
      startedAt: nowUtc(),
      previousGeneration: 1,
      hadProfile: true,
      hadPreset: true,
      hadActiveRecord: true,
    }
    await writeJson(join(transactionRoot, 'journal.json'), journal)
    await expect(validateInstallation(root)).rejects.toMatchObject({
      code: 'INSTALLATION_TRANSACTION_PENDING',
    })
    await expect(validateInstallation(root, { allowedTransactionId: transactionId })).resolves.toBeDefined()
  })
})

async function createValidInstallation(home: string): Promise<void> {
  const paths = installationPaths(home)
  await mkdir(paths.profileRoot, { recursive: true })
  await mkdir(paths.skillsRoot, { recursive: true })
  await mkdir(paths.installationRoot, { recursive: true })
  await writeFile(join(paths.profileRoot, 'package.json'), '{"name":"profile"}\n')
  await writeJson(paths.dependencyLockPath, { schemaVersion: 1, packages: [] })
  await writeFile(join(paths.presetRoot, 'preset.yml'), 'name: GeoResearch\n')
  await writeFile(join(paths.skillsRoot, 'SKILL.md'), '# Skill\n')
  await writeFile(paths.homePatchPath, '[]\n')

  const profile = await digestTree(paths.profileRoot)
  const preset = await digestTree(paths.presetRoot)
  const skills = await digestTree(paths.skillsRoot)
  const markerBase = {
    schemaVersion: 1 as const,
    installationId: 'installation-1',
    generation: 1,
    productVersion: '0.1.0',
  }
  const profileMarker: InstallationGenerationMarker = { ...markerBase, managedTreeDigest: profile.digest }
  const presetMarker: InstallationGenerationMarker = { ...markerBase, managedTreeDigest: preset.digest }
  await writeJson(join(paths.profileRoot, GENERATION_MARKER_FILE), profileMarker)
  await writeJson(join(paths.presetRoot, GENERATION_MARKER_FILE), presetMarker)

  const manifest: InstallationManifest = {
    ...markerBase,
    profileId: 'georesearch',
    presetId: 'georesearch',
    profileTreeDigest: profile.digest,
    presetTreeDigest: preset.digest,
    skillsTreeDigest: skills.digest,
    profileDependencyLockDigest: await digestFile(join(paths.profileRoot, DEPENDENCY_LOCK_FILE)),
    homePatchDigest: await digestFile(paths.homePatchPath),
    managedFiles: [
      ...profile.files.map(file => ({ root: 'profile' as const, ...file })),
      ...preset.files.map(file => ({ root: 'preset' as const, ...file })),
    ],
    createdAt: nowUtc(),
  }
  await writeJson(paths.manifestPath, manifest)
  const active: ActiveInstallationRecord = {
    ...markerBase,
    state: 'active',
    profileTreeDigest: manifest.profileTreeDigest,
    presetTreeDigest: manifest.presetTreeDigest,
    skillsTreeDigest: manifest.skillsTreeDigest,
    installationManifestDigest: await digestFile(paths.manifestPath),
    profileDependencyLockDigest: manifest.profileDependencyLockDigest,
    homePatchDigest: manifest.homePatchDigest,
    activatedAt: nowUtc(),
  }
  await writeJson(paths.activePath, active)
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, undefined, 2)}\n`)
}
