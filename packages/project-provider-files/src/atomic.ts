import { randomUUID } from 'node:crypto'
import { link, mkdir, open, rename, rm, unlink } from 'node:fs/promises'
import { basename, dirname, join, toNamespacedPath } from 'node:path'

type MoveFileExW = (existing: string, replacement: string, flags: number) => number
type GetLastError = () => number

interface Win32Bindings {
  readonly moveFileExW: MoveFileExW
  readonly getLastError: GetLastError
}

const MOVEFILE_REPLACE_EXISTING = 0x00000001
const MOVEFILE_WRITE_THROUGH = 0x00000008
const ERROR_ALREADY_EXISTS = 183
let bindings: Win32Bindings | undefined

export async function atomicWriteFile(path: string, data: string | Uint8Array): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true })
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`)
  let published = false
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await moveWriteThrough(temporary, path, true)
    published = true
  } finally {
    if (!published) await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, undefined, 2)}\n`)
}

export async function publishNoClobber(temporary: string, destination: string): Promise<'published' | 'exists'> {
  await mkdir(dirname(destination), { recursive: true })
  if (process.platform === 'win32') {
    const api = await win32()
    if (api.moveFileExW(toNamespacedPath(temporary), toNamespacedPath(destination), MOVEFILE_WRITE_THROUGH) !== 0) {
      return 'published'
    }
    const code = api.getLastError()
    if (code === ERROR_ALREADY_EXISTS) return 'exists'
    const error = new Error(`MoveFileExW failed with Win32 code ${code}: ${temporary} -> ${destination}`) as NodeJS.ErrnoException
    error.code = `WIN32_${code}`
    error.path = temporary
    throw error
  }
  try {
    await link(temporary, destination)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
    throw error
  }
  await unlink(temporary)
  return 'published'
}

export async function moveWriteThrough(existing: string, replacement: string, replaceExisting: boolean): Promise<void> {
  if (process.platform !== 'win32') {
    await rename(existing, replacement)
    await syncDirectory(dirname(replacement))
    return
  }
  const api = await win32()
  const flags = MOVEFILE_WRITE_THROUGH | (replaceExisting ? MOVEFILE_REPLACE_EXISTING : 0)
  if (api.moveFileExW(toNamespacedPath(existing), toNamespacedPath(replacement), flags) === 0) {
    const code = api.getLastError()
    const error = new Error(`MoveFileExW failed with Win32 code ${code}: ${existing} -> ${replacement}`) as NodeJS.ErrnoException
    error.code = `WIN32_${code}`
    error.path = existing
    throw error
  }
}

async function win32(): Promise<Win32Bindings> {
  if (bindings !== undefined) return bindings
  const koffi = (await import('koffi')).default
  const kernel32 = koffi.load('kernel32.dll')
  bindings = {
    moveFileExW: kernel32.func('__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint']) as MoveFileExW,
    getLastError: kernel32.func('__stdcall', 'GetLastError', 'uint', []) as GetLastError,
  }
  return bindings
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
