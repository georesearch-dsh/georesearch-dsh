import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { digestJson } from '@georesearch/dsh-contracts'
import {
  ProjectFileStore,
  inspectWorkspace,
  projectPaths,
  workspaceBinding,
} from '@georesearch/dsh-project-provider-files'
import { RUNTIME_PACKAGE_NAMES } from '../src/distribution.js'

const workspaceRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const harnessRoot = resolve(workspaceRoot, '..', 'deepseek-harness-master')
const distributionRoot = join(workspaceRoot, 'dist', 'distribution')
const cliPath = join(workspaceRoot, 'packages', 'installer', 'lib', 'cli.js')
const runtimeLeaseModuleUrl = pathToFileURL(
  join(workspaceRoot, 'packages', 'runtime-lease', 'lib', 'index.js'),
).href
const available = existsSync(join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js'))
  && existsSync(join(distributionRoot, 'distribution-manifest.json'))
  && existsSync(cliPath)
const installerDescribe = available ? describe : describe.skip
const testNonceKey = Buffer.alloc(32, 0x42).toString('base64url')

let home = ''

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'georesearch-installer-'))
  const webProfile = join(home, 'profiles', 'web')
  mkdirSync(webProfile, { recursive: true })
  writeFileSync(join(webProfile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { 'user-owned-package': '1.2.3' },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      },
    },
    userOwned: { preserved: true },
  }, undefined, 2) + '\n')
  writeFileSync(join(webProfile, 'cordis.patch.yml'), '[]\n')
  writeFileSync(
    join(webProfile, 'pnpm-workspace.yaml'),
    'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
  )
})

afterAll(async () => {
  if (home !== '') await rm(home, { recursive: true, force: true })
})

installerDescribe('installer lifecycle', () => {
  it('installs, excludes active runtimes, recovers crash stages, and uninstalls', async () => {
    expect(runCli('install').json).toMatchObject({ operation: 'install', generation: 1 })
    expectIntegratedWebProfile()
    expect(runCli('verify').json).toMatchObject({ operation: 'verify', generation: 1 })

    const benignHomePatch = '# benign user-owned home patch\n[]\n'
    writeFileSync(join(home, 'cordis.patch.yml'), benignHomePatch)
    const driftedHomePatch = runCli('verify', {}, false)
    expect(driftedHomePatch.status).toBe(1)
    expect(driftedHomePatch.stderr).toContain('GEORESEARCH_HOME_PATCH_DRIFT')
    expect(runCli('verify', {}, true, ['--reconcile-home-patch']).json).toMatchObject({
      operation: 'reconcile-home-patch',
      generation: 2,
    })
    expect(runCli('verify').json).toMatchObject({ operation: 'verify', generation: 2 })

    writeFileSync(
      join(home, 'cordis.patch.yml'),
      '- id: session-telemetry-otel\n  disabled: false\n',
    )
    const unsafeTelemetry = runCli('verify', {}, false, ['--reconcile-home-patch'])
    expect(unsafeTelemetry.status).toBe(1)
    expect(unsafeTelemetry.stderr).toContain('re-enabled session-telemetry-otel')
    writeFileSync(join(home, 'cordis.patch.yml'), benignHomePatch)
    expect(runCli('recover').json).toMatchObject({
      operation: 'recover',
      generation: 2,
      recoveryAction: 'rollback-to-previous-generation',
    })
    expect(runCli('verify').json).toMatchObject({ operation: 'verify', generation: 2 })

    const leaseHolder = await startRuntimeLeaseHolder()
    try {
      const blockedUpgrade = runCli('upgrade', {}, false)
      expect(blockedUpgrade.status).toBe(1)
      expect(blockedUpgrade.stderr).toContain('a GeoResearch runtime is active')
      expect(transactionNames()).toEqual([])
    } finally {
      await stopRuntimeLeaseHolder(leaseHolder)
    }

    writeFileSync(
      join(home, 'profiles', 'georesearch', 'cordis.yml'),
      '- id: loader-writeback\n  name: harness-owned-runtime-tree\n',
    )
    expect(runCli('verify').json).toMatchObject({ operation: 'verify', generation: 2 })

    for (const stage of [
      'candidate-verified',
      'profile-published',
      'preset-published',
      'manifest-published',
      'activation-probed',
    ]) {
      const failed = runCli('upgrade', { GEORESEARCH_INSTALLER_TEST_FAIL_AFTER: stage }, false)
      expect(failed.status).toBe(1)
      expect(failed.stderr).toContain(`GEORESEARCH_INSTALLER_TEST_FAILURE_AFTER:${stage}`)

      if (stage === 'profile-published') {
        const transactionRoot = currentTransactionRoot()
        writeFileSync(
          join(transactionRoot, 'backup-profile', 'cordis.patch.yml'),
          '- id: corrupted-backup\n  disabled: true\n',
        )
        const rejectedRecovery = runCli('recover', {}, false)
        expect(rejectedRecovery.status).toBe(1)
        expect(rejectedRecovery.stderr).toContain('GEORESEARCH_INSTALLATION_GENERATION_MISMATCH')
        expect(existsSync(transactionRoot)).toBe(true)
        writeFileSync(join(home, 'profiles', 'georesearch', 'cordis.patch.yml'), '[]\n')
      }

      expect(runCli('recover').json).toMatchObject({
        operation: 'recover',
        generation: 2,
        recoveryAction: 'rollback-to-previous-generation',
      })
      expectIntegratedWebProfile()
      expect(runCli('verify').json).toMatchObject({ generation: 2 })
    }

    const committedFailure = runCli(
      'upgrade',
      { GEORESEARCH_INSTALLER_TEST_FAIL_AFTER: 'committed' },
      false,
    )
    expect(committedFailure.status).toBe(1)
    expect(runCli('recover').json).toMatchObject({
      operation: 'recover',
      generation: 3,
      recoveryAction: 'complete-committed-generation',
    })
    expectIntegratedWebProfile()
    expect(runCli('verify').json).toMatchObject({ generation: 3 })

    const stagedUninstall = runCli(
      'uninstall',
      { GEORESEARCH_INSTALLER_TEST_FAIL_AFTER: 'uninstall-staged' },
      false,
    )
    expect(stagedUninstall.status).toBe(1)
    expect(stagedUninstall.stderr).toContain('GEORESEARCH_INSTALLER_TEST_FAILURE_AFTER:uninstall-staged')
    expect(runCli('recover').json).toMatchObject({
      operation: 'recover',
      generation: 3,
      recoveryAction: 'rollback-to-previous-generation',
    })
    expectIntegratedWebProfile()
    expect(runCli('verify').json).toMatchObject({ generation: 3 })

    writeFileSync(join(home, 'cordis.patch.yml'), '- id: local-user-patch\n  disabled: true\n')
    addPostInstallProfileState()
    expect(runCli('uninstall').json).toMatchObject({ operation: 'uninstall', generation: 4 })
    expectUnintegratedWebProfile()
  }, 420_000)

  it('protects modified Skills and completes a committed uninstall after recovery', async () => {
    const isolatedHome = await mkdtemp(join(tmpdir(), 'georesearch-uninstall-recovery-'))
    try {
      expect(runCliAt(isolatedHome, 'install', { harness: false }).json).toMatchObject({
        operation: 'install',
        generation: 1,
      })
      const skillPath = join(
        isolatedHome,
        '.agent-presets',
        'georesearch',
        'skills',
        'literature-review',
        'SKILL.md',
      )
      const originalSkill = readFileSync(skillPath)
      writeFileSync(skillPath, Buffer.concat([originalSkill, Buffer.from('\nlocal edit\n')]))
      const modified = runCliAt(isolatedHome, 'uninstall', {
        harness: false,
        expectSuccess: false,
      })
      expect(modified.status).toBe(1)
      expect(modified.stderr).toContain('INSTALLATION_FILE_MODIFIED')
      expect(transactionNamesAt(isolatedHome)).toEqual([])

      writeFileSync(skillPath, originalSkill)
      const committed = runCliAt(isolatedHome, 'uninstall', {
        harness: false,
        expectSuccess: false,
        extraEnv: { GEORESEARCH_INSTALLER_TEST_FAIL_AFTER: 'uninstall-committed' },
      })
      expect(committed.status).toBe(1)
      expect(committed.stderr).toContain('GEORESEARCH_INSTALLER_TEST_FAILURE_AFTER:uninstall-committed')
      expect(runCliAt(isolatedHome, 'recover', { harness: false }).json).toMatchObject({
        operation: 'recover',
        generation: 2,
        recoveryAction: 'complete-committed-generation',
      })
      expect(existsSync(join(isolatedHome, 'profiles', 'georesearch'))).toBe(false)
      expect(existsSync(join(isolatedHome, '.agent-presets', 'georesearch'))).toBe(false)
      expect(transactionNamesAt(isolatedHome)).toEqual([])
    } finally {
      await rm(isolatedHome, { recursive: true, force: true })
    }
  }, 60_000)

  it('performs a full install from an empty DSH_HOME environment', async () => {
    const blankHome = await mkdtemp(join(tmpdir(), 'georesearch-blank-home-'))
    try {
      expect(runCliAt(blankHome, 'install', { homeFromEnvironment: true }).json).toMatchObject({
        operation: 'install',
        generation: 1,
        dumpConfigVerified: true,
        runtimeProbeVerified: true,
      })
      expect(runCliAt(blankHome, 'verify', { homeFromEnvironment: true }).json).toMatchObject({
        operation: 'verify',
        generation: 1,
      })
      expect(runCliAt(blankHome, 'uninstall', { homeFromEnvironment: true }).json).toMatchObject({
        operation: 'uninstall',
        generation: 2,
      })
    } finally {
      await rm(blankHome, { recursive: true, force: true })
    }
  }, 120_000)

  it('keeps user Project snapshots unchanged during pre-activation runtime probes', async () => {
    const isolatedHome = await mkdtemp(join(tmpdir(), 'georesearch-project-rollback-'))
    try {
      expect(runCliAt(isolatedHome, 'install').json).toMatchObject({ operation: 'install', generation: 1 })
      const legacy = await createLegacyProjectSnapshot(isolatedHome)

      const failed = runCliAt(isolatedHome, 'upgrade', {
        expectSuccess: false,
        extraEnv: { GEORESEARCH_INSTALLER_TEST_FAIL_AFTER: 'activation-probed' },
      })
      expect(failed.status).toBe(1)
      expect(failed.stderr).toContain('GEORESEARCH_INSTALLER_TEST_FAILURE_AFTER:activation-probed')
      expect(readFileSync(legacy.path)).toEqual(legacy.bytes)

      expect(runCliAt(isolatedHome, 'recover').json).toMatchObject({
        operation: 'recover',
        generation: 1,
        recoveryAction: 'rollback-to-previous-generation',
      })
      expect(readFileSync(legacy.path)).toEqual(legacy.bytes)
    } finally {
      await rm(isolatedHome, { recursive: true, force: true })
    }
  }, 120_000)
})

async function createLegacyProjectSnapshot(targetHome: string): Promise<{
  readonly path: string
  readonly bytes: Buffer
}> {
  const projectId = 'project-maintenance-rollback-probe'
  const now = '2026-08-19T00:00:00.000Z'
  const inspected = await inspectWorkspace(targetHome)
  const binding = workspaceBinding(projectId, inspected, 1, now)
  const store = new ProjectFileStore({ home: targetHome, now: () => now })
  await store.createProject(
    projectId,
    binding,
    digestJson({ operation: 'maintenance-rollback-probe' }),
    digestJson({ request: 'maintenance-rollback-probe' }),
  )
  const path = projectPaths(targetHome, projectId).state
  const current = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const state = { ...(current.state as Record<string, unknown>) }
  for (const key of [
    'geodataReports',
    'datasetManifests',
    'experimentSpecs',
    'experimentAmendments',
    'results',
    'validationPlans',
    'validationReports',
    'reviewRecords',
    'claims',
    'writingPackets',
    'manuscripts',
    'manuscriptAudits',
  ]) delete state[key]
  const body = {
    schemaVersion: current.schemaVersion,
    projectId: current.projectId,
    generation: current.generation,
    lastEventSeq: current.lastEventSeq,
    lastEventHash: current.lastEventHash,
    state,
  }
  const bytes = Buffer.from(`${JSON.stringify({ ...body, digest: digestJson(body) }, undefined, 2)}\n`)
  writeFileSync(path, bytes)
  return { path, bytes }
}

function expectIntegratedWebProfile(): void {
  const webRoot = join(home, 'profiles', 'web')
  const manifest = JSON.parse(readFileSync(join(webRoot, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] } }
    userOwned: { preserved: boolean }
  }
  expect(manifest.userOwned).toEqual({ preserved: true })
  expect(manifest.dependencies['user-owned-package']).toBe('1.2.3')
  for (const packageName of RUNTIME_PACKAGE_NAMES) {
    expect(manifest.dependencies[packageName]).toBe('0.1.0')
  }
  expect(manifest.dsh.profile.bundles).toEqual([
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    '@georesearch/dsh-bundle',
  ])
  const resolution = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', "console.log(import.meta.resolve('@georesearch/dsh-prompt'))"],
    { cwd: webRoot, encoding: 'utf8', shell: false },
  )
  expect(resolution.stderr).toBe('')
  expect(resolution.status).toBe(0)
}

function addPostInstallProfileState(): void {
  const packagePath = join(home, 'profiles', 'web', 'package.json')
  const manifest = JSON.parse(readFileSync(packagePath, 'utf8')) as {
    dependencies: Record<string, string>
    userOwned: { preserved: boolean; addedAfterInstall?: boolean }
  }
  manifest.dependencies['post-install-package'] = '4.5.6'
  manifest.userOwned.addedAfterInstall = true
  writeFileSync(packagePath, `${JSON.stringify(manifest, undefined, 2)}\n`)
}

function expectUnintegratedWebProfile(): void {
  const webRoot = join(home, 'profiles', 'web')
  const manifest = JSON.parse(readFileSync(join(webRoot, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] } }
    userOwned: { preserved: boolean; addedAfterInstall?: boolean }
  }
  expect(manifest.userOwned).toEqual({ preserved: true, addedAfterInstall: true })
  expect(manifest.dependencies).toMatchObject({
    'user-owned-package': '1.2.3',
    'post-install-package': '4.5.6',
  })
  for (const packageName of RUNTIME_PACKAGE_NAMES) {
    expect(manifest.dependencies[packageName]).toBeUndefined()
  }
  expect(manifest.dsh.profile.bundles).toEqual([
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
  ])
  expect(existsSync(join(home, 'profiles', 'node_modules', '@georesearch'))).toBe(false)
}

function currentTransactionRoot(): string {
  const root = join(home, 'georesearch', 'installations', 'georesearch', 'transactions')
  const transactions = transactionNames()
  expect(transactions).toHaveLength(1)
  return join(root, transactions[0]!)
}

function transactionNames(): string[] {
  return transactionNamesAt(home)
}

function transactionNamesAt(targetHome: string): string[] {
  const root = join(targetHome, 'georesearch', 'installations', 'georesearch', 'transactions')
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
}

async function startRuntimeLeaseHolder(): Promise<ChildProcessWithoutNullStreams> {
  const script = [
    `import { acquireRuntimeLease } from ${JSON.stringify(runtimeLeaseModuleUrl)}`,
    'const lease = await acquireRuntimeLease(process.argv[1])',
    "process.stdout.write('ready\\n')",
    "process.on('SIGTERM', async () => { await lease.release(); process.exit(0) })",
    'setInterval(() => {}, 1000)',
  ].join(';')
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, home], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  await new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`runtime lease holder timed out: ${stderr}`)), 5000)
    child.stdout.setEncoding('utf8')
    child.stdout.once('data', chunk => {
      clearTimeout(timer)
      String(chunk).includes('ready')
        ? resolveReady()
        : rejectReady(new Error(`unexpected runtime lease holder output: ${String(chunk)}`))
    })
    child.once('exit', code => {
      clearTimeout(timer)
      rejectReady(new Error(`runtime lease holder exited ${String(code)}: ${stderr}`))
    })
  })
  return child
}

async function stopRuntimeLeaseHolder(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    once(child, 'exit'),
    new Promise((_, rejectWait) => setTimeout(() => rejectWait(new Error('runtime lease holder did not exit')), 5000)),
  ])
}

function runCli(
  command: 'install' | 'upgrade' | 'verify' | 'uninstall' | 'recover',
  extraEnv: Readonly<Record<string, string>> = {},
  expectSuccess = true,
  extraArgs: readonly string[] = [],
): { readonly status: number; readonly stdout: string; readonly stderr: string; readonly json?: any } {
  return runCliAt(home, command, { extraEnv, expectSuccess, extraArgs })
}

interface CliRunOptions {
  readonly extraEnv?: Readonly<Record<string, string>>
  readonly expectSuccess?: boolean
  readonly extraArgs?: readonly string[]
  readonly harness?: boolean
  readonly homeFromEnvironment?: boolean
}

function runCliAt(
  targetHome: string,
  command: 'install' | 'upgrade' | 'verify' | 'uninstall' | 'recover',
  options: CliRunOptions = {},
): { readonly status: number; readonly stdout: string; readonly stderr: string; readonly json?: any } {
  const args = [cliPath, command]
  if (options.homeFromEnvironment !== true) args.push('--dsh-home', targetHome)
  if (options.harness !== false) args.push('--harness-root', harnessRoot)
  const extraArgs = options.extraArgs ?? []
  if (command === 'install' || command === 'upgrade' || extraArgs.includes('--reconcile-home-patch')) {
    args.push('--distribution-dir', distributionRoot)
  }
  args.push(...extraArgs)
  const result = spawnSync(process.execPath, args, {
    cwd: options.harness === false ? targetHome : workspaceRoot,
    encoding: 'utf8',
    shell: false,
    env: {
      ...process.env,
      ...(options.homeFromEnvironment === true ? { DSH_HOME: targetHome } : {}),
      NODE_ENV: 'test',
      GEORESEARCH_TEST_NONCE_KEY: testNonceKey,
      GEORESEARCH_TEST_ALLOW_SANDBOX_FAIL_CLOSED: '1',
      ...options.extraEnv,
    },
  })
  const status = result.status ?? 1
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (options.expectSuccess !== false) {
    expect(status, `${command} exit status: ${stderr}`).toBe(0)
    expect(stderr, `${command} stderr`).toBe('')
  }
  return {
    status,
    stdout,
    stderr,
    ...(status === 0 ? { json: JSON.parse(stdout) } : {}),
  }
}
