import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, toNamespacedPath } from 'node:path'

type MoveFileExW = (existing: string, replacement: string, flags: number) => number
type GetLastError = () => number

interface Win32Bindings {
  readonly moveFileExW: MoveFileExW
  readonly getLastError: GetLastError
}

const MOVEFILE_REPLACE_EXISTING = 0x00000001
const MOVEFILE_WRITE_THROUGH = 0x00000008
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
    await movePathWriteThrough(temporary, path, true)
    published = true
  } finally {
    if (!published) await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, undefined, 2)}\n`)
}

export async function movePathWriteThrough(
  existing: string,
  replacement: string,
  replaceExisting = false,
): Promise<void> {
  if (process.platform !== 'win32') {
    await rename(existing, replacement)
    await syncDirectory(dirname(replacement))
    return
  }
  const api = await win32()
  const flags = MOVEFILE_WRITE_THROUGH | (replaceExisting ? MOVEFILE_REPLACE_EXISTING : 0)
  const ok = api.moveFileExW(toNamespacedPath(existing), toNamespacedPath(replacement), flags)
  if (ok === 0) {
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
