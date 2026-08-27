import { mkdir, rm } from 'node:fs/promises'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@georesearch/dsh-compat-rc5'
import type {} from '@georesearch/dsh-installation-guard'
import { GeoResearchError, sha256Bytes } from '@georesearch/dsh-contracts'

export const name = 'georesearch-runtime-lease'
export const inject = ['geoResearchInstallation']

export interface Config {
  readonly home?: string
}

export interface RuntimeLease {
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

export async function acquireRuntimeLease(home: string): Promise<RuntimeLease> {
  const absoluteHome = resolve(home)
  return process.platform === 'win32'
    ? acquireWindowsLease(absoluteHome)
    : acquireSocketLease(absoluteHome)
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  if (ctx.geoResearchInstallation.maintenanceTransactionId !== undefined) return
  const lease = await acquireRuntimeLease(resolveDshHome(config.home))
  ctx.effect(() => async () => lease.release(), 'geoResearchRuntimeLease.release()')
}

async function acquireWindowsLease(home: string): Promise<RuntimeLease> {
  const koffi = (await import('koffi')).default
  const kernel32 = koffi.load('kernel32.dll')
  const createMutex = kernel32.func('__stdcall', 'CreateMutexW', 'void *', ['void *', 'int', 'str16']) as CreateMutexW
  const waitForSingleObject = kernel32.func('__stdcall', 'WaitForSingleObject', 'uint', ['void *', 'uint']) as WaitForSingleObject
  const releaseMutex = kernel32.func('__stdcall', 'ReleaseMutex', 'int', ['void *']) as ReleaseMutex
  const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int', ['void *']) as CloseHandle
  const getLastError = kernel32.func('__stdcall', 'GetLastError', 'uint', []) as GetLastError
  const handle = createMutex(null, 0, runtimeLeaseName(home))
  if (handle === null) throw new Error(`CreateMutexW failed with Win32 code ${getLastError()}`)
  const wait = waitForSingleObject(handle, 0)
  if (wait === WAIT_TIMEOUT) {
    closeHandle(handle)
    throw busyLeaseError()
  }
  if (wait === WAIT_FAILED || (wait !== WAIT_OBJECT_0 && wait !== WAIT_ABANDONED)) {
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
        if (releaseMutex(handle) === 0) {
          throw new Error(`ReleaseMutex failed with Win32 code ${getLastError()}`)
        }
      } finally {
        closeHandle(handle)
      }
    },
  }
}

async function acquireSocketLease(home: string): Promise<RuntimeLease> {
  const identity = leaseIdentity(home)
  const socketPath = join(tmpdir(), `georesearch-dsh-runtime-${identity}.sock`)
  await mkdir(tmpdir(), { recursive: true })
  let server: Server
  try {
    server = await listenSocket(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    if (await socketIsLive(socketPath)) throw busyLeaseError()
    await rm(socketPath, { force: true })
    try {
      server = await listenSocket(socketPath)
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === 'EADDRINUSE') throw busyLeaseError()
      throw retryError
    }
  }
  server.unref()
  let released = false
  return {
    async release() {
      if (released) return
      released = true
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close(error => error === undefined ? resolveClose() : rejectClose(error))
      })
      await rm(socketPath, { force: true })
    },
  }
}

async function listenSocket(path: string): Promise<Server> {
  const server = createServer(socket => socket.end())
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      rejectListen(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(path)
  })
  return server
}

async function socketIsLive(path: string): Promise<boolean> {
  return await new Promise<boolean>(resolveLive => {
    const socket = createConnection(path)
    let settled = false
    const settle = (value: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveLive(value)
    }
    socket.once('connect', () => settle(true))
    socket.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      settle(code !== 'ECONNREFUSED' && code !== 'ENOENT')
    })
    socket.setTimeout(500, () => settle(true))
  })
}

function runtimeLeaseName(home: string): string {
  return `Local\\GeoResearch.DSH.Runtime.${leaseIdentity(home)}`
}

function leaseIdentity(home: string): string {
  return sha256Bytes(Buffer.from(home.toLowerCase(), 'utf8'))
    .slice('sha256:'.length, 'sha256:'.length + 32)
}

function busyLeaseError(): GeoResearchError {
  return new GeoResearchError(
    'INSTALLATION_TRANSACTION_PENDING',
    'a GeoResearch runtime is active; stop the profile before changing its installation',
  )
}
