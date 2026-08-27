import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireRuntimeLease } from '../src/index.js'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const builtModuleUrl = pathToFileURL(join(packageRoot, 'lib', 'index.js')).href
const temporaryRoots: string[] = []
const children: ChildProcessWithoutNullStreams[] = []

afterEach(async () => {
  for (const child of children.splice(0)) await stopChild(child)
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('runtime lease', () => {
  it('rejects a second process and becomes available after owner exit', async () => {
    const home = await mkdtemp(join(tmpdir(), 'georesearch-runtime-lease-'))
    temporaryRoots.push(home)
    const holder = await startHolder(home)
    children.push(holder)

    await expect(acquireRuntimeLease(home)).rejects.toMatchObject({
      code: 'INSTALLATION_TRANSACTION_PENDING',
    })

    await stopChild(holder)
    children.splice(children.indexOf(holder), 1)
    const lease = await acquireRuntimeLease(home)
    await lease.release()
  })
})

async function startHolder(home: string): Promise<ChildProcessWithoutNullStreams> {
  const script = [
    `import { acquireRuntimeLease } from ${JSON.stringify(builtModuleUrl)}`,
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

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    once(child, 'exit'),
    new Promise((_, rejectWait) => setTimeout(() => rejectWait(new Error('runtime lease holder did not exit')), 5000)),
  ])
}
