import { stat } from 'node:fs/promises'
import { toNamespacedPath } from 'node:path'
import { GeoResearchError } from '@georesearch/dsh-contracts'
import type { InstallationPaths } from '@georesearch/dsh-installation-guard/validation'

type NativeHandle = object | number | bigint
type CreateFileW = (
  path: string,
  desiredAccess: number,
  shareMode: number,
  securityAttributes: null,
  creationDisposition: number,
  flagsAndAttributes: number,
  templateFile: null,
) => NativeHandle | null
type CloseHandle = (handle: NativeHandle) => number
type GetLastError = () => number

const DELETE_ACCESS = 0x00010000
const FILE_SHARE_READ = 0x00000001
const FILE_SHARE_WRITE = 0x00000002
const FILE_SHARE_DELETE = 0x00000004
const OPEN_EXISTING = 3
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000

export async function assertManagedDirectoriesReplaceable(paths: InstallationPaths): Promise<void> {
  if (process.platform !== 'win32') return
  await assertDirectoryReplaceable(paths.profileRoot, 'Profile')
  await assertDirectoryReplaceable(paths.sharedPackagesRoot, 'shared package')
  await assertDirectoryReplaceable(paths.presetRoot, 'Preset')
}

async function assertDirectoryReplaceable(path: string, label: string): Promise<void> {
  try {
    const info = await stat(path)
    if (!info.isDirectory()) return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }

  const koffi = (await import('koffi')).default
  const kernel32 = koffi.load('kernel32.dll')
  const createFile = kernel32.func(
    '__stdcall',
    'CreateFileW',
    'void *',
    ['str16', 'uint', 'uint', 'void *', 'uint', 'uint', 'void *'],
  ) as CreateFileW
  const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int', ['void *']) as CloseHandle
  const getLastError = kernel32.func('__stdcall', 'GetLastError', 'uint', []) as GetLastError
  const handle = createFile(
    toNamespacedPath(path),
    DELETE_ACCESS,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    null,
    OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS,
    null,
  )
  const invalidHandle = BigInt.asUintN(process.arch === 'ia32' ? 32 : 64, -1n)
  if (handle === null || koffi.address(handle) === invalidHandle) {
    const code = getLastError()
    if (code === 5 || code === 32 || code === 33) {
      throw new GeoResearchError(
        'INSTALLATION_TRANSACTION_PENDING',
        `${label} directory is in use; stop every Harness profile using this DSH_HOME before mutation`,
      )
    }
    throw new Error(`CreateFileW replaceability probe failed with Win32 code ${code}: ${path}`)
  }
  if (closeHandle(handle) === 0) {
    throw new Error(`CloseHandle failed with Win32 code ${getLastError()}: ${path}`)
  }
}
