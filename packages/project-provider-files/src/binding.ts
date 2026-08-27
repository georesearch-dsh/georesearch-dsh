import { lstat, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  digestJson,
  type FileIdentity,
  type ProjectBinding,
  type WorkspaceBinding,
} from '@georesearch/dsh-contracts'
import { atomicWriteJson } from './atomic.js'
import { canonicalDirectoryIdentity } from './win32.js'

export interface InspectedWorkspace {
  readonly canonicalPath: string
  readonly volumeIdentity: string
  readonly directoryFileIdentity: string
  readonly gitCommonDirIdentity?: FileIdentity
  readonly gitWorktreeIdentity?: FileIdentity
  readonly workspaceId: string
}

export interface ProjectRefHint {
  readonly schemaVersion: 1
  readonly projectId: string
  readonly workspaceId: string
}

export async function inspectWorkspace(path: string): Promise<InspectedWorkspace> {
  const workspace = await canonicalDirectoryIdentity(path)
  const git = await inspectGitMetadata(workspace.canonicalPath)
  const workspaceId = `workspace-${digestJson({
    domain: 'georesearch.workspace-id/v1',
    volumeIdentity: workspace.volumeIdentity,
    directoryFileIdentity: workspace.fileIdentity,
    ...(git === undefined ? {} : { gitWorktreeIdentity: git.worktree }),
  }).slice('sha256:'.length)}`
  return {
    canonicalPath: workspace.canonicalPath,
    volumeIdentity: workspace.volumeIdentity,
    directoryFileIdentity: workspace.fileIdentity,
    ...(git === undefined ? {} : {
      gitCommonDirIdentity: git.common,
      gitWorktreeIdentity: git.worktree,
    }),
    workspaceId,
  }
}

export function workspaceBinding(
  projectId: string,
  workspace: InspectedWorkspace,
  bindingVersion: number,
  time: string,
): WorkspaceBinding {
  if (!Number.isSafeInteger(bindingVersion) || bindingVersion < 1) {
    throw new TypeError('bindingVersion must be a positive integer')
  }
  return {
    schemaVersion: 1,
    bindingVersion,
    workspaceId: workspace.workspaceId,
    projectId,
    canonicalPath: workspace.canonicalPath,
    volumeIdentity: workspace.volumeIdentity,
    directoryFileIdentity: workspace.directoryFileIdentity,
    ...(workspace.gitCommonDirIdentity === undefined ? {} : { gitCommonDirIdentity: workspace.gitCommonDirIdentity }),
    ...(workspace.gitWorktreeIdentity === undefined ? {} : { gitWorktreeIdentity: workspace.gitWorktreeIdentity }),
    attachedAt: time,
    verifiedAt: time,
  }
}

export function initialProjectBinding(projectId: string, workspaceId: string, time: string): ProjectBinding {
  return {
    schemaVersion: 1,
    projectId,
    bindingId: `binding-${digestJson({ domain: 'georesearch.project-binding/v1', projectId }).slice('sha256:'.length)}`,
    workspaceIds: [workspaceId],
    createdAt: time,
    updatedAt: time,
  }
}

export function exactWorkspaceMatch(binding: WorkspaceBinding, inspected: InspectedWorkspace): boolean {
  return pathEqual(binding.canonicalPath, inspected.canonicalPath)
    && sameWorkspaceIdentity(binding, inspected)
}

export function movedWorkspaceMatch(binding: WorkspaceBinding, inspected: InspectedWorkspace): boolean {
  return !pathEqual(binding.canonicalPath, inspected.canonicalPath)
    && sameWorkspaceIdentity(binding, inspected)
}

export function sameGitCommonDirectory(binding: WorkspaceBinding, inspected: InspectedWorkspace): boolean {
  return binding.gitCommonDirIdentity !== undefined
    && inspected.gitCommonDirIdentity !== undefined
    && sameFileIdentity(binding.gitCommonDirIdentity, inspected.gitCommonDirIdentity)
}

export async function readProjectRefHint(workspaceRoot: string): Promise<ProjectRefHint | undefined> {
  try {
    const value = JSON.parse(await readFile(join(workspaceRoot, '.georesearch', 'project-ref.json'), 'utf8')) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    if (record.schemaVersion !== 1 || typeof record.projectId !== 'string' || typeof record.workspaceId !== 'string') {
      return undefined
    }
    return { schemaVersion: 1, projectId: record.projectId, workspaceId: record.workspaceId }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return undefined
    throw error
  }
}

export async function writeProjectRefHint(workspaceRoot: string, hint: ProjectRefHint): Promise<void> {
  await atomicWriteJson(join(workspaceRoot, '.georesearch', 'project-ref.json'), hint)
}

function sameWorkspaceIdentity(binding: WorkspaceBinding, inspected: InspectedWorkspace): boolean {
  return binding.volumeIdentity === inspected.volumeIdentity
    && binding.directoryFileIdentity === inspected.directoryFileIdentity
    && optionalIdentityEqual(binding.gitCommonDirIdentity, inspected.gitCommonDirIdentity)
    && optionalIdentityEqual(binding.gitWorktreeIdentity, inspected.gitWorktreeIdentity)
}

function optionalIdentityEqual(left: FileIdentity | undefined, right: FileIdentity | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return sameFileIdentity(left, right)
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.volumeIdentity === right.volumeIdentity && left.fileIdentity === right.fileIdentity
}

function pathEqual(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

async function inspectGitMetadata(workspaceRoot: string): Promise<{
  readonly worktree: FileIdentity
  readonly common: FileIdentity
} | undefined> {
  const dotGit = join(workspaceRoot, '.git')
  let info
  try {
    info = await lstat(dotGit)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (info.isSymbolicLink()) throw new TypeError('.git must not be a symbolic link')
  let gitDirectory: string
  if (info.isDirectory()) {
    gitDirectory = dotGit
  } else if (info.isFile()) {
    const declaration = await readBoundedText(dotGit, 16 * 1024)
    const match = /^gitdir:\s*(.+?)\s*$/iu.exec(declaration)
    if (match?.[1] === undefined) throw new TypeError('.git file does not contain one gitdir declaration')
    gitDirectory = resolve(dirname(dotGit), match[1])
  } else {
    throw new TypeError('.git must be a directory or regular file')
  }
  const worktree = await canonicalDirectoryIdentity(gitDirectory)
  const commonDeclaration = join(worktree.canonicalPath, 'commondir')
  let commonDirectory = worktree.canonicalPath
  try {
    const relativeCommon = (await readBoundedText(commonDeclaration, 16 * 1024)).trim()
    if (relativeCommon.length === 0) throw new TypeError('Git commondir is empty')
    commonDirectory = resolve(worktree.canonicalPath, relativeCommon)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const common = await canonicalDirectoryIdentity(commonDirectory)
  return {
    worktree: { volumeIdentity: worktree.volumeIdentity, fileIdentity: worktree.fileIdentity },
    common: { volumeIdentity: common.volumeIdentity, fileIdentity: common.fileIdentity },
  }
}

async function readBoundedText(path: string, maxBytes: number): Promise<string> {
  const bytes = await readFile(path)
  if (bytes.byteLength > maxBytes) throw new TypeError(`${path} exceeds ${maxBytes} bytes`)
  return bytes.toString('utf8')
}
