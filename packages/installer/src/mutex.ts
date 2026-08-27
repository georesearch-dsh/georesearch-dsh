import { mkdir, open, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { GeoResearchError, sha256Bytes } from '@georesearch/dsh-contracts'
import { installationPaths } from '@georesearch/dsh-installation-guard/validation'

export interface InstallerMutex {
  release(): Promise<void>
}

type NativeHandle = object | number | bigint
type CreateMutexW = (attributes: null, initialOwner: number, name: string) => NativeHandle | null
type WaitForSingleObject = (handle: NativeHandle, milliseconds: number) => number
type ReleaseMutex = (handle: NativeHandle) => number
type CloseHandle = (handle: NativeHandle) => number
type GetLastError = () => number

const WAIT_OBJECT_0 = 0x00000000
const WAIT_ABANDONED = 0x00000080
const WAIT_TIMEOUT = 0x00000102
const WAIT_FAILED = 0xffffffff

export async function acquireInstallerMutex(home: string, timeoutMs = 30_000): Promise<InstallerMutex> {
  if (process.platform === 'win32') return acquireWindowsMutex(home, timeoutMs)
  return acquireFileMutex(home)
}

async function acquireWindowsMutex(home: string, timeoutMs: number): Promise<InstallerMutex> {
  const koffi = (await import('koffi')).default
  const kernel32 = koffi.load('kernel32.dll')
  const createMutex = kernel32.func('__stdcall', 'CreateMutexW', 'void *', ['void *', 'int', 'str16']) as CreateMutexW
  const waitForSingleObject = kernel32.func('__stdcall', 'WaitForSingleObject', 'uint', ['void *', 'uint']) as WaitForSingleObject
  const releaseMutex = kernel32.func('__stdcall', 'ReleaseMutex', 'int', ['void *']) as ReleaseMutex
  const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int', ['void *']) as CloseHandle
  const getLastError = kernel32.func('__stdcall', 'GetLastError', 'uint', []) as GetLastError
  const identity = sha256Bytes(Buffer.from(home.toLowerCase(), 'utf8')).slice('sha256:'.length, 'sha256:'.length + 32)
  const handle = createMutex(null, 0, `Local\\GeoResearch.DSH.${identity}`)
  if (handle === null) throw new Error(`CreateMutexW failed with Win32 code ${getLastError()}`)
  const wait = waitForSingleObject(handle, timeoutMs)
  if (wait === WAIT_ABANDONED) {
    releaseMutex(handle)
    closeHandle(handle)
    throw new GeoResearchError(
      'INSTALLATION_RECOVERY_REQUIRED',
      'the installer mutex was abandoned; run georesearch-dsh recover before another mutation',
    )
  }
  if (wait === WAIT_TIMEOUT) {
    closeHandle(handle)
    throw new GeoResearchError('INSTALLATION_TRANSACTION_PENDING', 'another installer process still owns the mutex')
  }
  if (wait === WAIT_FAILED || wait !== WAIT_OBJECT_0) {
    const code = getLastError()
    closeHandle(handle)
    throw new Error(`WaitForSingleObject failed with Win32 code ${code}`)
  }
  let released = false
  return {
    async release() {
      if (released) return
      released = true
      try {
        if (releaseMutex(handle) === 0) throw new Error(`ReleaseMutex failed with Win32 code ${getLastError()}`)
      } finally {
        closeHandle(handle)
      }
    },
  }
}

async function acquireFileMutex(home: string): Promise<InstallerMutex> {
  const paths = installationPaths(home)
  await mkdir(paths.installationRoot, { recursive: true })
  const path = join(paths.installationRoot, 'installer.lock')
  let handle: FileHandle
  try {
    handle = await open(path, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new GeoResearchError('INSTALLATION_TRANSACTION_PENDING', 'another installer process owns installer.lock')
    }
    throw error
  }
  await handle.writeFile(`${process.pid}\n`)
  await handle.sync()
  let released = false
  return {
    async release() {
      if (released) return
      released = true
      await handle.close()
      await rm(path, { force: true })
    },
  }
}
