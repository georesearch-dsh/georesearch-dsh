import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireProjectMutex,
  canonicalDirectoryIdentity,
  currentWindowsUserSid,
  projectMutexName,
  snapshotFileFromSingleHandle,
} from '../src/index.js'

const windowsDescribe = process.platform === 'win32' ? describe : describe.skip
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

windowsDescribe('Windows project native helper', () => {
  it('creates a user-scoped named mutex and reads canonical directory identity', async () => {
    expect(await currentWindowsUserSid()).toMatch(/^S-\d-(?:\d+-)+\d+$/u)
    const root = await temporaryRoot('georesearch-native-')
    const identity = await canonicalDirectoryIdentity(root)
    expect(identity.canonicalPath.toLowerCase()).toBe(root.toLowerCase())
    const lease = await acquireProjectMutex('native-smoke', 2_000)
    expect(lease.abandoned).toBe(false)
    await lease.release()
  })

  it('copies and hashes a file through one restricted source handle', async () => {
    const root = await temporaryRoot('georesearch-snapshot-')
    const source = join(root, 'source.txt')
    const destination = join(root, 'copy.tmp')
    await writeFile(source, 'same handle')
    const snapshot = await snapshotFileFromSingleHandle(source, destination)
    expect(snapshot.size).toBe(11)
    expect(snapshot.digestHex).toMatch(/^[0-9a-f]{64}$/u)
    expect(await readFile(destination, 'utf8')).toBe('same handle')
  })

  it('observes WAIT_ABANDONED after the owning process exits and then releases normally', async () => {
    const projectId = `abandoned-${process.pid}`
    const koffi = (await import('koffi')).default
    const kernel32 = koffi.load('kernel32.dll')
    const createMutex = kernel32.func('__stdcall', 'CreateMutexW', 'void *', ['void *', 'int', 'str16']) as (
      attributes: null,
      initialOwner: number,
      name: string,
    ) => object | number | bigint | null
    const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int', ['void *']) as (
      handle: object | number | bigint,
    ) => number
    const observer = createMutex(null, 0, projectMutexName(await currentWindowsUserSid(), projectId))
    expect(observer).not.toBeNull()
    const script = [
      "import { acquireProjectMutex } from './packages/project-provider-files/lib/index.js'",
      `await acquireProjectMutex(${JSON.stringify(projectId)}, 2000)`,
      "process.stdout.write('owned\\n')",
      'process.exit(0)',
    ].join(';')
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: join(import.meta.dirname, '..', '..', '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    await once(child, 'exit')
    expect(stdout, stderr).toContain('owned')
    try {
      const abandoned = await acquireProjectMutex(projectId, 2_000)
      expect(abandoned.abandoned).toBe(true)
      await abandoned.release()
      const clean = await acquireProjectMutex(projectId, 2_000)
      expect(clean.abandoned).toBe(false)
      await clean.release()
    } finally {
      closeHandle(observer as object | number | bigint)
    }
  })
})

async function temporaryRoot(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(path)
  return path
}
import { spawn } from 'node:child_process'
import { once } from 'node:events'
