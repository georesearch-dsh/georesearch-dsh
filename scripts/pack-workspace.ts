import { spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WORKSPACE_PACKAGES } from './workspace-packages.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const distributionRoot = join(root, 'dist', 'distribution', 'packages')
const installerStagingRoot = join(root, 'dist', '.installer-pack-staging')
const destination = join(root, 'dist', 'tarballs')

await rm(destination, { recursive: true, force: true })
await rm(installerStagingRoot, { recursive: true, force: true })
await mkdir(destination, { recursive: true })
try {
  for (const { name: packageName } of WORKSPACE_PACKAGES) {
    const distributionPackageRoot = join(distributionRoot, packageName.split('/')[1] as string)
    const manifest = JSON.parse(await readFile(join(distributionPackageRoot, 'package.json'), 'utf8')) as Record<string, unknown>
    if (manifest.name !== packageName) {
      throw new Error(`distribution package identity mismatch for ${packageName}`)
    }
    const packageRoot = packageName === '@georesearch/dsh-installer'
      ? await stageSelfContainedInstaller(distributionPackageRoot)
      : distributionPackageRoot
    const windows = process.platform === 'win32'
    const executable = windows ? (process.env.ComSpec ?? 'cmd.exe') : 'npm'
    const npmArgs = ['pack', '--silent', '--ignore-scripts', '--pack-destination', destination]
    const result = spawnSync(
      executable,
      windows ? ['/d', '/c', 'npm', ...npmArgs] : npmArgs,
      {
        cwd: packageRoot,
        stdio: 'inherit',
        shell: false,
        env: {
          ...process.env,
          CI: '1',
          npm_config_cache: join(root, '.tmp', 'npm-cache'),
          npm_config_update_notifier: 'false',
        },
      },
    )
    if ((result.status ?? 1) !== 0) {
      throw new Error(`npm pack failed for ${packageName}: ${result.error?.message ?? `exit ${String(result.status)}`}`)
    }
  }
} finally {
  await rm(installerStagingRoot, { recursive: true, force: true })
}
process.stdout.write(`${JSON.stringify({ destination, packages: WORKSPACE_PACKAGES.length }, undefined, 2)}\n`)

async function stageSelfContainedInstaller(source: string): Promise<string> {
  await rm(installerStagingRoot, { recursive: true, force: true })
  await cp(source, installerStagingRoot, { recursive: true })
  const archivePath = join(installerStagingRoot, 'distribution.tar')
  const result = spawnSync('tar', [
    '-cf', archivePath,
    '-C', join(root, 'dist'),
    'distribution',
  ], { cwd: root, encoding: 'utf8', shell: false })
  if ((result.status ?? 1) !== 0) {
    throw new Error(`distribution archive creation failed: ${result.stderr || result.error?.message || result.status}`)
  }
  return installerStagingRoot
}
