import { spawnSync } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const manifest = (await import('../package.json', { with: { type: 'json' } })).default as {
  readonly packageManager: string
}
const expectedPnpm = /^pnpm@(.+)$/u.exec(manifest.packageManager)?.[1]
if (expectedPnpm === undefined) throw new Error('packageManager must pin an exact pnpm version')

if (process.platform !== 'win32' || process.arch !== 'x64') {
  throw new Error(`GeoResearch release gates require Windows x64, received ${process.platform}-${process.arch}`)
}
if (!supportedNode(process.versions.node)) {
  throw new Error(`unsupported release Node.js version: ${process.version}`)
}

const pnpm = commandVersion('pnpm')
if (pnpm !== expectedPnpm) {
  throw new Error(`release pnpm mismatch: expected ${expectedPnpm}, received ${pnpm}; use pnpm run release:gate`)
}
const npm = commandVersion('npm')
if (Number.parseInt(npm.split('.')[0] ?? '', 10) < 10) {
  throw new Error(`release npm must be version 10 or newer, received ${npm}`)
}

const userProfile = process.env.USERPROFILE?.trim()
if (userProfile === undefined || userProfile.length === 0) {
  throw new Error('USERPROFILE is unavailable; CurrentUser DPAPI cannot be release-qualified')
}
if (!(await stat(userProfile)).isDirectory()) {
  throw new Error(`USERPROFILE is not a directory: ${userProfile}`)
}

process.stdout.write(`${JSON.stringify({
  platform: process.platform,
  architecture: process.arch,
  node: process.version,
  npm,
  pnpm,
  packageManager: manifest.packageManager,
  userProfileLoaded: true,
}, undefined, 2)}\n`)

function commandVersion(command: 'npm' | 'pnpm'): string {
  const executable = process.env.ComSpec ?? 'cmd.exe'
  const result = spawnSync(executable, ['/d', '/c', command, '--version'], {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  })
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} version probe failed: ${result.error?.message ?? result.stderr.trim()}`)
  }
  return result.stdout.trim()
}

function supportedNode(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(value => Number.parseInt(value, 10))
  return major > 24 || major === 24 || (major === 22 && minor >= 19)
}
