import { cp, mkdir, open, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { movePathWriteThrough } from './atomic.js'

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function copyDirectory(source: string, destination: string): Promise<void> {
  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
  })
}

export async function copyProfileDirectoryForProbe(source: string, destination: string): Promise<void> {
  const sourceModules = resolve(source, 'node_modules')
  const sourceModulesPrefix = `${sourceModules}${sep}`
  await cp(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    verbatimSymlinks: true,
    filter: path => {
      const absolute = resolve(path)
      return absolute !== sourceModules && !absolute.startsWith(sourceModulesPrefix)
    },
  })
  if (await pathExists(sourceModules)) {
    await symlink(sourceModules, join(destination, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  }
}

export async function copyFileIfPresent(source: string, destination: string): Promise<boolean> {
  if (!await pathExists(source)) return false
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, await readFile(source), { flag: 'wx', mode: 0o600 })
  await syncFile(destination)
  return true
}

export async function publishDirectory(
  staged: string,
  target: string,
  backup: string,
): Promise<boolean> {
  await mkdir(dirname(target), { recursive: true })
  await mkdir(dirname(backup), { recursive: true })
  await syncTree(staged)
  const existed = await pathExists(target)
  if (existed) await movePathWriteThrough(target, backup)
  await movePathWriteThrough(staged, target)
  return existed
}

export async function restoreDirectory(target: string, backup: string, existedBefore: boolean): Promise<void> {
  const backupExists = await pathExists(backup)
  const targetExists = await pathExists(target)
  if (existedBefore) {
    if (backupExists) {
      if (targetExists) await rm(target, { recursive: true, force: true })
      await movePathWriteThrough(backup, target)
      return
    }
    if (targetExists) return
    throw new Error(`recovery has neither original target nor backup: ${target}`)
  }
  if (targetExists) await rm(target, { recursive: true, force: true })
  if (backupExists) await rm(backup, { recursive: true, force: true })
}

export async function syncTree(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      await syncTree(path)
    } else if (entry.isFile()) {
      await syncFile(path)
    } else {
      throw new Error(`managed staging tree contains unsupported entry: ${path}`)
    }
  }
}

export async function syncFile(path: string): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function removeTree(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}
