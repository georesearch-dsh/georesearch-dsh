import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const workspaceRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const harnessRoot = resolve(workspaceRoot, '..', 'deepseek-harness-master')
const harnessModulesRoot = resolve(workspaceRoot, '..', '.dsh', 'profiles', 'node_modules')
const tarballRoot = join(workspaceRoot, 'dist', 'tarballs')
const installerTarball = join(tarballRoot, 'georesearch-dsh-installer-0.1.0.tgz')
const available = existsSync(installerTarball)
  && existsSync(join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js'))
const installerDescribe = available ? describe : describe.skip
const roots: string[] = []
const testNonceKey = Buffer.alloc(32, 0x52).toString('base64url')

afterAll(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

installerDescribe('self-contained installer tarball', () => {
  it('installs, verifies, and uninstalls a blank DSH_HOME without --distribution-dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'georesearch-tarball-clean-home-'))
    roots.push(root)
    const modulesRoot = join(root, 'node_modules')
    const home = join(root, 'home')
    await mkdir(modulesRoot, { recursive: true })

    for (const packageName of [
      '@georesearch/dsh-installer',
      '@georesearch/dsh-contracts',
      '@georesearch/dsh-compat-rc5',
      '@georesearch/dsh-installation-guard',
      '@georesearch/dsh-runtime-lease',
    ]) {
      await extractPackage(packageName, modulesRoot, root)
    }
    for (const dependencyName of ['js-yaml', 'koffi', 'tar-stream']) {
      await linkDirectory(
        join(workspaceRoot, 'node_modules', dependencyName),
        join(modulesRoot, dependencyName),
      )
    }
    const compatibilityManifest = JSON.parse(await readFile(
      join(modulesRoot, '@georesearch', 'dsh-compat-rc5', 'package.json'),
      'utf8',
    )) as { readonly peerDependencies?: Record<string, string> }
    for (const peerName of Object.keys(compatibilityManifest.peerDependencies ?? {})) {
      await linkDirectory(
        join(harnessModulesRoot, ...peerName.split('/')),
        join(modulesRoot, ...peerName.split('/')),
      )
    }

    const installerRoot = join(modulesRoot, '@georesearch', 'dsh-installer')
    expect(existsSync(join(installerRoot, 'distribution.tar'))).toBe(true)

    const cli = join(installerRoot, 'lib', 'cli.js')
    expect(runCli(cli, root, home, 'install')).toMatchObject({
      operation: 'install', generation: 1, dumpConfigVerified: true, runtimeProbeVerified: true,
    })
    expect(runCli(cli, root, home, 'verify')).toMatchObject({ operation: 'verify', generation: 1 })
    expect(runCli(cli, root, home, 'uninstall')).toMatchObject({ operation: 'uninstall', generation: 2 })
  }, 180_000)
})

async function extractPackage(packageName: string, modulesRoot: string, temporaryRoot: string): Promise<void> {
  const baseName = packageName.split('/')[1] as string
  const tarball = join(tarballRoot, `georesearch-${baseName}-0.1.0.tgz`)
  const extractionRoot = join(temporaryRoot, '.extract', baseName)
  await mkdir(extractionRoot, { recursive: true })
  const result = spawnSync('tar', ['-xf', tarball, '-C', extractionRoot], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    shell: false,
  })
  expect(result.status, result.stderr).toBe(0)
  const destination = join(modulesRoot, ...packageName.split('/'))
  await mkdir(dirname(destination), { recursive: true })
  await rename(join(extractionRoot, 'package'), destination)
}

async function linkDirectory(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true })
  await symlink(await realpath(source), destination, process.platform === 'win32' ? 'junction' : 'dir')
}

function runCli(
  cli: string,
  cwd: string,
  home: string,
  command: 'install' | 'verify' | 'uninstall',
): Record<string, unknown> {
  const result = spawnSync(process.execPath, [
    cli,
    command,
    '--dsh-home', home,
    '--harness-root', harnessRoot,
  ], {
    cwd,
    encoding: 'utf8',
    shell: false,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      GEORESEARCH_TEST_NONCE_KEY: testNonceKey,
      GEORESEARCH_TEST_ALLOW_SANDBOX_FAIL_CLOSED: '1',
    },
  })
  expect(result.status, result.stderr).toBe(0)
  expect(result.stderr).toBe('')
  return JSON.parse(result.stdout) as Record<string, unknown>
}
