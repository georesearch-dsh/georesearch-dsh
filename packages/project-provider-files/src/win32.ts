import { createHash } from 'node:crypto'
import { mkdir, open, realpath, rm, stat } from 'node:fs/promises'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep, toNamespacedPath } from 'node:path'
import { GeoResearchError, type CanonicalPathIdentity } from '@georesearch/dsh-contracts'

export interface ProjectMutexLease {
  readonly abandoned: boolean
  release(): Promise<void>
}

export interface NativeFileSnapshot {
  readonly identity: CanonicalPathIdentity
  readonly size: number
  readonly digestHex: string
}

export interface SnapshotNativeOptions {
  readonly onSourceOpened?: (identity: CanonicalPathIdentity) => void | Promise<void>
}

type NativeHandle = object | number | bigint
type CreateMutexW = (attributes: unknown, initialOwner: number, name: string) => NativeHandle | null
type WaitForSingleObject = (handle: NativeHandle, milliseconds: number) => number
type ReleaseMutex = (handle: NativeHandle) => number
type CloseHandle = (handle: NativeHandle) => number
type GetLastError = () => number
type CreateFileW = (
  path: string,
  desiredAccess: number,
  shareMode: number,
  attributes: null,
  creationDisposition: number,
  flagsAndAttributes: number,
  template: null,
) => NativeHandle | null
type GetFileInformationByHandleEx = (
  handle: NativeHandle,
  infoClass: number,
  info: Buffer,
  size: number,
) => number
type GetFileType = (handle: NativeHandle) => number
type GetFinalPathNameByHandleW = (
  handle: NativeHandle,
  buffer: Buffer,
  size: number,
  flags: number,
) => number
type ReadFile = (
  handle: NativeHandle,
  buffer: Buffer,
  bytesToRead: number,
  bytesRead: [number],
  overlapped: null,
) => number

const WAIT_OBJECT_0 = 0x00000000
const WAIT_ABANDONED = 0x00000080
const WAIT_TIMEOUT = 0x00000102
const WAIT_FAILED = 0xffffffff
const GENERIC_READ = 0x80000000
const FILE_SHARE_READ = 0x00000001
const FILE_SHARE_WRITE = 0x00000002
const FILE_SHARE_DELETE = 0x00000004
const OPEN_EXISTING = 3
const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
const FILE_FLAG_SEQUENTIAL_SCAN = 0x08000000
const FILE_TYPE_DISK = 0x0001
const FILE_ATTRIBUTE_TAG_INFO = 9
const FILE_ID_INFO = 18
const TOKEN_QUERY = 0x0008
const TOKEN_USER = 1
const SDDL_REVISION_1 = 1
const ERROR_INSUFFICIENT_BUFFER = 122
const READ_BUFFER_BYTES = 1024 * 1024

let userSidResult: Promise<string> | undefined

export function projectMutexName(userSid: string, projectId: string): string {
  const sidHash = shortHash(userSid)
  const projectHash = shortHash(projectId)
  return `Local\\GeoResearch.Project.v1.${sidHash}.${projectHash}`
}

export async function currentWindowsUserSid(): Promise<string> {
  if (process.platform !== 'win32') return `posix:${process.getuid?.() ?? 'unknown'}`
  userSidResult ??= readCurrentWindowsUserSid()
  return userSidResult
}

export async function acquireProjectMutex(
  projectId: string,
  timeoutMs = 2_000,
): Promise<ProjectMutexLease> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new TypeError('timeoutMs must be a non-negative integer')
  if (process.platform !== 'win32') return acquireSocketMutex(projectId)
  const koffi = (await import('koffi')).default
  const PVOID = koffi.pointer('void')
  const SecurityAttributes = koffi.struct({
    nLength: 'uint32',
    lpSecurityDescriptor: PVOID,
    bInheritHandle: 'int',
  })
  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')
  const createMutex = kernel32.func(
    '__stdcall',
    'CreateMutexW',
    'void *',
    [koffi.pointer(SecurityAttributes), 'int', 'str16'],
  ) as CreateMutexW
  const waitForSingleObject = kernel32.func('__stdcall', 'WaitForSingleObject', 'uint', ['void *', 'uint']) as WaitForSingleObject
  const releaseMutex = kernel32.func('__stdcall', 'ReleaseMutex', 'int', ['void *']) as ReleaseMutex
  const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int', ['void *']) as CloseHandle
  const getLastError = kernel32.func('__stdcall', 'GetLastError', 'uint', []) as GetLastError
  const convertSddl = advapi32.func(
    '__stdcall',
    'ConvertStringSecurityDescriptorToSecurityDescriptorW',
    'int',
    ['str16', 'uint', koffi.pointer(PVOID), koffi.pointer('uint32')],
  ) as (sddl: string, revision: number, descriptor: unknown, size: unknown) => number
  const localFree = kernel32.func('__stdcall', 'LocalFree', 'void *', ['void *']) as (value: NativeHandle) => NativeHandle | null
  const descriptorSlot = koffi.alloc(PVOID, 1)
  const descriptorSize = koffi.alloc('uint32', 1)
  const sid = await currentWindowsUserSid()
  const sddl = `D:P(A;;GA;;;SY)(A;;GA;;;${sid})`
  if (convertSddl(sddl, SDDL_REVISION_1, descriptorSlot, descriptorSize) === 0) {
    throw new Error(`ConvertStringSecurityDescriptorToSecurityDescriptorW failed with Win32 code ${getLastError()}`)
  }
  const descriptor = koffi.decode(descriptorSlot, PVOID) as NativeHandle | null
  if (descriptor === null) throw new Error('ConvertStringSecurityDescriptorToSecurityDescriptorW returned a null descriptor')
  let handle: NativeHandle | null
  try {
    handle = createMutex({
      nLength: SecurityAttributes.size,
      lpSecurityDescriptor: descriptor,
      bInheritHandle: 0,
    }, 0, projectMutexName(sid, projectId))
  } finally {
    const remainder = localFree(descriptor)
    if (!nullPointer(remainder)) throw new Error('LocalFree failed for the project mutex security descriptor')
  }
  if (handle === null) throw new Error(`CreateMutexW failed with Win32 code ${getLastError()}`)
  const wait = waitForSingleObject(handle, timeoutMs)
  if (wait === WAIT_TIMEOUT) {
    closeHandle(handle)
    throw new GeoResearchError('PROJECT_WRITE_LOCK_TIMEOUT', `project ${projectId} remained locked for ${timeoutMs} ms`)
  }
  if (wait === WAIT_FAILED || (wait !== WAIT_OBJECT_0 && wait !== WAIT_ABANDONED)) {
    const code = getLastError()
    closeHandle(handle)
    throw new Error(`WaitForSingleObject failed with Win32 code ${code}`)
  }
  let released = false
  return {
    abandoned: wait === WAIT_ABANDONED,
    async release() {
      if (released) return
      released = true
      try {
        if (releaseMutex(handle as NativeHandle) === 0) {
          throw new Error(`ReleaseMutex failed with Win32 code ${getLastError()}`)
        }
      } finally {
        closeHandle(handle as NativeHandle)
      }
    },
  }
}

export async function canonicalDirectoryIdentity(path: string): Promise<CanonicalPathIdentity> {
  if (process.platform !== 'win32') {
    const canonicalPath = await realpath(resolve(path))
    const info = await stat(canonicalPath)
    if (!info.isDirectory()) throw new TypeError(`path is not a directory: ${canonicalPath}`)
    return {
      canonicalPath,
      volumeIdentity: `dev:${String(info.dev)}`,
      fileIdentity: `ino:${String(info.ino)}`,
    }
  }
  const opened = await openWindowsPath(path, true, 'identity')
  try {
    return opened.identity
  } finally {
    opened.close()
  }
}

export async function snapshotFileFromSingleHandle(
  source: string,
  temporary: string,
  options: SnapshotNativeOptions = {},
): Promise<NativeFileSnapshot> {
  if (process.platform !== 'win32') return snapshotPortable(source, temporary, options)
  const opened = await openWindowsPath(source, false, 'source')
  let destination
  try {
    await options.onSourceOpened?.(opened.identity)
    await mkdir(resolve(temporary, '..'), { recursive: true })
    destination = await open(temporary, 'wx', 0o600)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES)
    let copied = 0
    while (true) {
      const bytesRead: [number] = [0]
      if (opened.read(buffer, bytesRead) === 0) {
        throw new Error(`ReadFile failed with Win32 code ${opened.lastError()}: ${source}`)
      }
      if (bytesRead[0] === 0) break
      const chunk = buffer.subarray(0, bytesRead[0])
      await destination.writeFile(chunk)
      hash.update(chunk)
      copied += chunk.byteLength
    }
    await destination.sync()
    const final = opened.refreshIdentity()
    if (final.canonicalPath !== opened.identity.canonicalPath
      || final.volumeIdentity !== opened.identity.volumeIdentity
      || final.fileIdentity !== opened.identity.fileIdentity
      || final.size !== opened.size
      || copied !== opened.size) {
      throw new GeoResearchError('ARTIFACT_SOURCE_CHANGED', 'artifact source identity or length changed while it was copied')
    }
    return {
      identity: opened.identity,
      size: copied,
      digestHex: hash.digest('hex'),
    }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  } finally {
    await destination?.close().catch(() => undefined)
    opened.close()
  }
}

export async function snapshotWorkspaceFileFromSingleHandle(
  workspaceRoot: string,
  source: string,
  temporary: string,
  options: SnapshotNativeOptions = {},
): Promise<NativeFileSnapshot> {
  const absoluteRoot = resolve(workspaceRoot)
  const absoluteSource = resolve(source)
  const relativeSource = relative(absoluteRoot, absoluteSource)
  if (relativeSource === '..' || relativeSource.startsWith(`..${sep}`) || relativeSource === '' || relativeSource.startsWith(sep)) {
    throw new GeoResearchError('ARTIFACT_PATH_OUTSIDE_WORKSPACE', 'artifact path escapes the bound workspace')
  }
  if (process.platform !== 'win32') {
    await assertPortableParentsSafe(absoluteRoot, dirname(absoluteSource))
    return snapshotPortable(absoluteSource, temporary, options)
  }
  const held: OpenedWindowsPath[] = []
  try {
    const parts = relative(absoluteRoot, dirname(absoluteSource)).split(sep).filter(Boolean)
    let current = absoluteRoot
    held.push(await openWindowsPath(current, true, 'parent'))
    for (const part of parts) {
      current = join(current, part)
      held.push(await openWindowsPath(current, true, 'parent'))
    }
    return await snapshotFileFromSingleHandle(absoluteSource, temporary, options)
  } finally {
    for (const handle of held.reverse()) handle.close()
  }
}

export async function withSafeWorkspaceParentChain<T>(
  workspaceRoot: string,
  targetParent: string,
  use: () => T | Promise<T>,
): Promise<T> {
  const absoluteRoot = resolve(workspaceRoot)
  const absoluteParent = resolve(targetParent)
  const relativeParent = relative(absoluteRoot, absoluteParent)
  if (isAbsolute(relativeParent) || relativeParent === '..' || relativeParent.startsWith(`..${sep}`)) {
    throw new GeoResearchError('ARTIFACT_PATH_OUTSIDE_WORKSPACE', 'workspace output path escapes the bound workspace')
  }
  const parts = relativeParent.split(sep).filter(Boolean)
  if (process.platform === 'win32') {
    const held: OpenedWindowsPath[] = []
    try {
      let current = absoluteRoot
      held.push(await openWindowsPath(current, true, 'parent'))
      for (const part of parts) {
        current = join(current, part)
        await ensureDirectory(current)
        held.push(await openWindowsPath(current, true, 'parent'))
      }
      return await use()
    } finally {
      for (const handle of held.reverse()) handle.close()
    }
  }

  const held = []
  try {
    const canonicalRoot = await realpath(absoluteRoot)
    let current = absoluteRoot
    held.push(await open(current, 'r'))
    for (const part of parts) {
      current = join(current, part)
      await ensureDirectory(current)
      const linkInfo = await lstatPortable(current)
      if (linkInfo.symbolic) {
        throw new GeoResearchError('ARTIFACT_UNSAFE_FILE_TYPE', 'symbolic links are not accepted in workspace output paths')
      }
      const info = await stat(current)
      if (!info.isDirectory()) throw new GeoResearchError('ARTIFACT_UNSAFE_FILE_TYPE', 'workspace output parent is not a directory')
      const canonical = await realpath(current)
      const canonicalRelative = relative(canonicalRoot, canonical)
      if (isAbsolute(canonicalRelative) || canonicalRelative === '..' || canonicalRelative.startsWith(`..${sep}`)) {
        throw new GeoResearchError('ARTIFACT_PATH_OUTSIDE_WORKSPACE', 'workspace output parent escapes the bound workspace')
      }
      held.push(await open(current, 'r'))
    }
    return await use()
  } finally {
    for (const handle of held.reverse()) await handle.close().catch(() => undefined)
  }
}

async function readCurrentWindowsUserSid(): Promise<string> {
  const koffi = (await import('koffi')).default
  const PVOID = koffi.pointer('void')
  const kernel32 = koffi.load('kernel32.dll')
  const advapi32 = koffi.load('advapi32.dll')
  const getCurrentProcess = kernel32.func('__stdcall', 'GetCurrentProcess', 'void *', []) as () => NativeHandle
  const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int', ['void *']) as CloseHandle
  const getLastError = kernel32.func('__stdcall', 'GetLastError', 'uint', []) as GetLastError
  const localFree = kernel32.func('__stdcall', 'LocalFree', 'void *', ['void *']) as (value: NativeHandle) => NativeHandle | null
  const lstrlenW = kernel32.func('__stdcall', 'lstrlenW', 'int', ['void *']) as (value: NativeHandle) => number
  const openProcessToken = advapi32.func(
    '__stdcall',
    'OpenProcessToken',
    'int',
    ['void *', 'uint', koffi.pointer(PVOID)],
  ) as (process: NativeHandle, access: number, token: unknown) => number
  const getTokenInformation = advapi32.func(
    '__stdcall',
    'GetTokenInformation',
    'int',
    ['void *', 'uint', 'void *', 'uint', koffi.pointer('uint32')],
  ) as (token: NativeHandle, kind: number, data: Buffer | null, size: number, needed: unknown) => number
  const convertSid = advapi32.func(
    '__stdcall',
    'ConvertSidToStringSidW',
    'int',
    ['void *', koffi.pointer(PVOID)],
  ) as (sid: NativeHandle, stringSid: unknown) => number
  const tokenSlot = koffi.alloc(PVOID, 1)
  if (openProcessToken(getCurrentProcess(), TOKEN_QUERY, tokenSlot) === 0) {
    throw new Error(`OpenProcessToken failed with Win32 code ${getLastError()}`)
  }
  const token = koffi.decode(tokenSlot, PVOID) as NativeHandle
  try {
    const needed = koffi.alloc('uint32', 1)
    getTokenInformation(token, TOKEN_USER, null, 0, needed)
    const code = getLastError()
    const length = koffi.decode(needed, 'uint32') as number
    if (code !== ERROR_INSUFFICIENT_BUFFER || length < PVOID.size) {
      throw new Error(`GetTokenInformation size probe failed with Win32 code ${code}`)
    }
    const buffer = Buffer.alloc(length)
    if (getTokenInformation(token, TOKEN_USER, buffer, buffer.length, needed) === 0) {
      throw new Error(`GetTokenInformation failed with Win32 code ${getLastError()}`)
    }
    const sid = koffi.decode(buffer, 0, PVOID) as NativeHandle | null
    if (sid === null) throw new Error('GetTokenInformation returned a null user SID')
    const stringSlot = koffi.alloc(PVOID, 1)
    if (convertSid(sid, stringSlot) === 0) {
      throw new Error(`ConvertSidToStringSidW failed with Win32 code ${getLastError()}`)
    }
    const stringPointer = koffi.decode(stringSlot, PVOID) as NativeHandle | null
    if (stringPointer === null) throw new Error('ConvertSidToStringSidW returned a null string')
    try {
      const length = lstrlenW(stringPointer)
      if (length < 1 || length > 256) throw new Error(`invalid current user SID length: ${length}`)
      const result = Buffer.from(new Uint8Array(koffi.view(stringPointer, length * 2))).toString('utf16le')
      if (!/^S-\d-(?:\d+-)+\d+$/u.test(result)) throw new Error(`invalid current user SID: ${result}`)
      return result
    } finally {
      const remainder = localFree(stringPointer)
      if (!nullPointer(remainder)) throw new Error('LocalFree failed for the current user SID string')
    }
  } finally {
    if (closeHandle(token) === 0) throw new Error(`CloseHandle failed with Win32 code ${getLastError()}`)
  }
}

interface OpenedWindowsPath {
  readonly identity: CanonicalPathIdentity
  readonly size: number
  read(buffer: Buffer, bytesRead: [number]): number
  refreshIdentity(): CanonicalPathIdentity & { readonly size: number }
  lastError(): number
  close(): void
}

async function openWindowsPath(
  path: string,
  directory: boolean,
  sharePolicy: 'identity' | 'parent' | 'source',
): Promise<OpenedWindowsPath> {
  const koffi = (await import('koffi')).default
  const kernel32 = koffi.load('kernel32.dll')
  const createFile = kernel32.func('__stdcall', 'CreateFileW', 'void *', [
    'str16', 'uint', 'uint', 'void *', 'uint', 'uint', 'void *',
  ]) as CreateFileW
  const getInfo = kernel32.func('__stdcall', 'GetFileInformationByHandleEx', 'int', [
    'void *', 'uint', 'void *', 'uint',
  ]) as GetFileInformationByHandleEx
  const getFileType = kernel32.func('__stdcall', 'GetFileType', 'uint', ['void *']) as GetFileType
  const getFinalPath = kernel32.func('__stdcall', 'GetFinalPathNameByHandleW', 'uint', [
    'void *', 'void *', 'uint', 'uint',
  ]) as GetFinalPathNameByHandleW
  const readFile = kernel32.func('__stdcall', 'ReadFile', 'int', [
    'void *', 'void *', 'uint', koffi.out(koffi.pointer('uint32')), 'void *',
  ]) as ReadFile
  const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int', ['void *']) as CloseHandle
  const getLastError = kernel32.func('__stdcall', 'GetLastError', 'uint', []) as GetLastError
  const flags = FILE_FLAG_OPEN_REPARSE_POINT
    | (directory ? FILE_FLAG_BACKUP_SEMANTICS : FILE_FLAG_SEQUENTIAL_SCAN)
  const share = sharePolicy === 'source'
    ? FILE_SHARE_READ
    : sharePolicy === 'parent'
      ? FILE_SHARE_READ | FILE_SHARE_WRITE
      : FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
  const handle = createFile(toNamespacedPath(resolve(path)), GENERIC_READ, share, null, OPEN_EXISTING, flags, null)
  if (invalidHandle(koffi, handle)) throw new Error(`CreateFileW failed with Win32 code ${getLastError()}: ${path}`)
  const refresh = (): CanonicalPathIdentity & { readonly size: number } => {
    if (getFileType(handle as NativeHandle) !== FILE_TYPE_DISK) {
      throw new GeoResearchError('ARTIFACT_UNSAFE_FILE_TYPE', 'artifact source is not a disk file')
    }
    const attributes = Buffer.alloc(8)
    if (getInfo(handle as NativeHandle, FILE_ATTRIBUTE_TAG_INFO, attributes, attributes.length) === 0) {
      throw new Error(`GetFileInformationByHandleEx(FileAttributeTagInfo) failed with Win32 code ${getLastError()}`)
    }
    if ((attributes.readUInt32LE(0) & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
      throw new GeoResearchError('ARTIFACT_UNSAFE_FILE_TYPE', 'symbolic links, junctions, and reparse points are not accepted')
    }
    const id = Buffer.alloc(24)
    if (getInfo(handle as NativeHandle, FILE_ID_INFO, id, id.length) === 0) {
      throw new Error(`GetFileInformationByHandleEx(FileIdInfo) failed with Win32 code ${getLastError()}`)
    }
    const standard = Buffer.alloc(24)
    if (getInfo(handle as NativeHandle, 1, standard, standard.length) === 0) {
      throw new Error(`GetFileInformationByHandleEx(FileStandardInfo) failed with Win32 code ${getLastError()}`)
    }
    const isDirectory = standard[21] !== 0
    if (isDirectory !== directory) throw new TypeError(directory ? 'path is not a directory' : 'artifact source is not a regular file')
    const length = Number(standard.readBigInt64LE(8))
    if (!Number.isSafeInteger(length) || length < 0) throw new Error('file length exceeds the supported safe integer range')
    const pathBuffer = Buffer.alloc(65_536)
    const pathLength = getFinalPath(handle as NativeHandle, pathBuffer, pathBuffer.length / 2, 0)
    if (pathLength === 0 || pathLength >= pathBuffer.length / 2) {
      throw new Error(`GetFinalPathNameByHandleW failed with Win32 code ${getLastError()}`)
    }
    const canonicalPath = normalizeFinalPath(pathBuffer.subarray(0, pathLength * 2).toString('utf16le'))
    return {
      canonicalPath,
      volumeIdentity: `volume:${id.readBigUInt64LE(0).toString(16).padStart(16, '0')}`,
      fileIdentity: `file:${id.subarray(8, 24).toString('hex')}`,
      size: length,
    }
  }
  try {
    const initial = refresh()
    return {
      identity: {
        canonicalPath: initial.canonicalPath,
        volumeIdentity: initial.volumeIdentity,
        fileIdentity: initial.fileIdentity,
      },
      size: initial.size,
      read: (buffer, bytesRead) => readFile(handle as NativeHandle, buffer, buffer.length, bytesRead, null),
      refreshIdentity: refresh,
      lastError: getLastError,
      close: () => {
        if (closeHandle(handle as NativeHandle) === 0) {
          throw new Error(`CloseHandle failed with Win32 code ${getLastError()}`)
        }
      },
    }
  } catch (error) {
    closeHandle(handle as NativeHandle)
    throw error
  }
}

async function snapshotPortable(
  source: string,
  temporary: string,
  options: SnapshotNativeOptions,
): Promise<NativeFileSnapshot> {
  const sourceHandle = await open(source, 'r')
  let destination
  try {
    const linkInfo = await lstatPortable(source)
    if (linkInfo.symbolic) throw new GeoResearchError('ARTIFACT_UNSAFE_FILE_TYPE', 'symbolic links are not accepted')
    const before = await sourceHandle.stat()
    if (!before.isFile()) throw new GeoResearchError('ARTIFACT_UNSAFE_FILE_TYPE', 'artifact source is not a regular file')
    const identity = {
      canonicalPath: await realpath(source),
      volumeIdentity: `dev:${String(before.dev)}`,
      fileIdentity: `ino:${String(before.ino)}`,
    }
    await options.onSourceOpened?.(identity)
    destination = await open(temporary, 'wx', 0o600)
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES)
    let position = 0
    while (true) {
      const result = await sourceHandle.read(buffer, 0, buffer.length, position)
      if (result.bytesRead === 0) break
      const chunk = buffer.subarray(0, result.bytesRead)
      await destination.writeFile(chunk)
      hash.update(chunk)
      position += result.bytesRead
    }
    await destination.sync()
    const after = await sourceHandle.stat()
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || position !== before.size) {
      throw new GeoResearchError('ARTIFACT_SOURCE_CHANGED', 'artifact source identity or length changed while it was copied')
    }
    return { identity, size: position, digestHex: hash.digest('hex') }
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  } finally {
    await destination?.close().catch(() => undefined)
    await sourceHandle.close()
  }
}

async function assertPortableParentsSafe(root: string, parent: string): Promise<void> {
  const parts = relative(root, parent).split(sep).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    if ((await lstatPortable(current)).symbolic) {
      throw new GeoResearchError('ARTIFACT_UNSAFE_FILE_TYPE', 'symbolic links are not accepted in artifact paths')
    }
  }
}

async function lstatPortable(path: string): Promise<{ readonly symbolic: boolean }> {
  const { lstat } = await import('node:fs/promises')
  const info = await lstat(path)
  return { symbolic: info.isSymbolicLink() }
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}

async function acquireSocketMutex(projectId: string): Promise<ProjectMutexLease> {
  const socketPath = join(tmpdir(), `georesearch-project-${shortHash(projectId)}.sock`)
  let server: Server
  try {
    server = await listen(socketPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error
    if (await socketLive(socketPath)) {
      throw new GeoResearchError('PROJECT_WRITE_LOCK_TIMEOUT', `project ${projectId} is locked`)
    }
    await rm(socketPath, { force: true })
    server = await listen(socketPath)
  }
  server.unref()
  let released = false
  return {
    abandoned: false,
    async release() {
      if (released) return
      released = true
      await new Promise<void>((resolveClose, rejectClose) => server.close(error => error === undefined ? resolveClose() : rejectClose(error)))
      await rm(socketPath, { force: true })
    },
  }
}

async function listen(path: string): Promise<Server> {
  const server = createServer(socket => socket.end())
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(path, resolveListen)
  })
  return server
}

async function socketLive(path: string): Promise<boolean> {
  return await new Promise<boolean>(resolveLive => {
    const socket = createConnection(path)
    const settle = (value: boolean): void => {
      socket.destroy()
      resolveLive(value)
    }
    socket.once('connect', () => settle(true))
    socket.once('error', error => settle((error as NodeJS.ErrnoException).code !== 'ECONNREFUSED'))
    socket.setTimeout(500, () => settle(true))
  })
}

function shortHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)
}

function normalizeFinalPath(value: string): string {
  if (value.startsWith('\\\\?\\UNC\\')) return `\\\\${value.slice('\\\\?\\UNC\\'.length)}`
  if (value.startsWith('\\\\?\\')) return value.slice('\\\\?\\'.length)
  return value
}

function nullPointer(value: NativeHandle | null | undefined): boolean {
  return value === null || value === undefined || value === 0 || value === 0n
}

function invalidHandle(koffi: { address(value: unknown): bigint }, value: NativeHandle | null): boolean {
  if (value === null) return true
  const address = koffi.address(value)
  return address === -1n || address === 0xffffffffffffffffn || address === 0xffffffffn
}
