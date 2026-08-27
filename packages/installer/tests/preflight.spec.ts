import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installationPaths } from '@georesearch/dsh-installation-guard/validation'
import { assertManagedDirectoriesReplaceable } from '../src/preflight.js'

const windowsDescribe = process.platform === 'win32' ? describe : describe.skip
const temporaryRoots: string[] = []
const children: ChildProcessWithoutNullStreams[] = []

afterEach(async () => {
  for (const child of children.splice(0)) await stopChild(child)
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

windowsDescribe('Windows directory publish preflight', () => {
  it('rejects a Preset directory handle that does not share delete access', async () => {
    const home = await mkdtemp(join(tmpdir(), 'georesearch-preflight-'))
    temporaryRoots.push(home)
    const paths = installationPaths(home)
    await mkdir(paths.profileRoot, { recursive: true })
    await mkdir(paths.presetRoot, { recursive: true })
    const holder = await startDirectoryHolder(paths.presetRoot)
    children.push(holder)

    await expect(assertManagedDirectoriesReplaceable(paths)).rejects.toMatchObject({
      code: 'INSTALLATION_TRANSACTION_PENDING',
    })

    await stopChild(holder)
    children.splice(children.indexOf(holder), 1)
    await expect(assertManagedDirectoriesReplaceable(paths)).resolves.toBeUndefined()
  })
})

async function startDirectoryHolder(path: string): Promise<ChildProcessWithoutNullStreams> {
  const script = [
    "import koffi from 'koffi'",
    "const kernel32 = koffi.load('kernel32.dll')",
    "const createFile = kernel32.func('__stdcall', 'CreateFileW', 'void *', ['str16', 'uint', 'uint', 'void *', 'uint', 'uint', 'void *'])",
    "const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int', ['void *'])",
    'const handle = createFile(process.argv[1], 0x80000000, 3, null, 3, 0x02000000, null)',
    "const invalid = BigInt.asUintN(process.arch === 'ia32' ? 32 : 64, -1n)",
    "if (handle === null || koffi.address(handle) === invalid) throw new Error('CreateFileW failed')",
    "process.stdout.write('ready\\n')",
    "process.on('SIGTERM', () => { closeHandle(handle); process.exit(0) })",
    'setInterval(() => {}, 1000)',
  ].join(';')
  const child = spawn(process.execPath, ['--input-type=module', '--eval', script, path], {
    cwd: join(import.meta.dirname, '..', '..', '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  await new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => rejectReady(new Error(`directory holder timed out: ${stderr}`)), 5000)
    child.stdout.setEncoding('utf8')
    child.stdout.once('data', chunk => {
      clearTimeout(timer)
      String(chunk).includes('ready')
        ? resolveReady()
        : rejectReady(new Error(`unexpected directory holder output: ${String(chunk)}`))
    })
    child.once('exit', code => {
      clearTimeout(timer)
      rejectReady(new Error(`directory holder exited ${String(code)}: ${stderr}`))
    })
  })
  return child
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    once(child, 'exit'),
    new Promise((_, rejectWait) => setTimeout(() => rejectWait(new Error('directory holder did not exit')), 5000)),
  ])
}
