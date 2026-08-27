import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  HARNESS_BASELINE,
  digestFile,
  digestTree,
  sha256Bytes,
} from '@georesearch/dsh-contracts'

export interface HarnessBaselineProof {
  readonly archivePath: string
  readonly verifiedSourcePath: string
  readonly localMirrorPath: string
  readonly localPatchManifestPath: string
  readonly archiveSha256: string
  readonly sourceTreeDigest: string
  readonly sourceFileCount: number
  readonly localPatchManifestSha256: string
  readonly localPatchId: string
  readonly localPatchFileCount: number
  readonly localMirrorMatchesExpectedPatch: true
  readonly lockfileSha256: string
}

interface HarnessLocalPatchFile {
  readonly path: string
  readonly sha256: string
  readonly size: number
}

interface HarnessLocalPatchManifest {
  readonly schemaVersion: 1
  readonly id: string
  readonly baselineCommit: string
  readonly reason: string
  readonly files: readonly HarnessLocalPatchFile[]
}

const LOCAL_PATCH_MANIFEST_SHA256 = 'sha256:faf0e0b8373a5a4b4a2764b4df085bdf8eb155bf68e715f3ea27e179c9324c14'

export async function verifyHarnessBaseline(workspaceRoot: string): Promise<HarnessBaselineProof> {
  const parent = resolve(workspaceRoot, '..')
  const archivePath = join(parent, 'source', `deepseek-harness-${HARNESS_BASELINE.commit}.zip`)
  const verifiedSourcePath = join(
    parent,
    'source',
    `verified-harness-${HARNESS_BASELINE.commit}`,
    `deepseek-harness-${HARNESS_BASELINE.commit}`,
  )
  const localMirrorPath = join(parent, 'deepseek-harness-master')
  const localPatchManifestPath = join(workspaceRoot, 'docs', 'harness-local-patch.json')
  const archiveSha256 = await digestFile(archivePath)
  const officialTree = await digestTree(verifiedSourcePath)
  if (archiveSha256 !== HARNESS_BASELINE.archiveSha256) {
    throw new Error(`Harness archive digest mismatch: ${archiveSha256}`)
  }
  if (officialTree.digest !== HARNESS_BASELINE.sourceTreeDigest
    || officialTree.files.length !== HARNESS_BASELINE.sourceFileCount) {
    throw new Error(
      `Harness source tree mismatch: ${officialTree.digest}/${officialTree.files.length}`,
    )
  }

  const localPatchBytes = await readFile(localPatchManifestPath)
  const localPatchManifestSha256 = sha256Bytes(localPatchBytes)
  if (localPatchManifestSha256 !== LOCAL_PATCH_MANIFEST_SHA256) {
    throw new Error(`Harness local patch manifest digest mismatch: ${localPatchManifestSha256}`)
  }
  const localPatch = parseLocalPatchManifest(JSON.parse(localPatchBytes.toString('utf8')) as unknown)
  if (localPatch.baselineCommit !== HARNESS_BASELINE.commit) {
    throw new Error(`Harness local patch targets unexpected commit: ${localPatch.baselineCommit}`)
  }
  const patchFiles = new Map(localPatch.files.map(file => [file.path, file] as const))
  const mismatches = await compareLocalMirror(localMirrorPath, officialTree.files, patchFiles)
  if (mismatches.length > 0) {
    throw new Error(`local Harness mirror differs from the registered patch: ${mismatches.slice(0, 8).join(', ')}`)
  }
  const lockfileSha256 = await digestFile(join(verifiedSourcePath, 'pnpm-lock.yaml'))
  if (lockfileSha256 !== HARNESS_BASELINE.lockfileSha256) {
    throw new Error(`Harness lockfile digest mismatch: ${lockfileSha256}`)
  }
  const officialManifest = JSON.parse(
    await readFile(join(verifiedSourcePath, 'package.json'), 'utf8'),
  ) as Record<string, unknown>
  const localManifest = JSON.parse(
    await readFile(join(localMirrorPath, 'package.json'), 'utf8'),
  ) as Record<string, unknown>
  if (officialManifest.version !== HARNESS_BASELINE.version
    || localManifest.version !== HARNESS_BASELINE.version) {
    throw new Error('Harness package version does not match the pinned baseline')
  }
  return {
    archivePath,
    verifiedSourcePath,
    localMirrorPath,
    localPatchManifestPath,
    archiveSha256,
    sourceTreeDigest: officialTree.digest,
    sourceFileCount: officialTree.files.length,
    localPatchManifestSha256,
    localPatchId: localPatch.id,
    localPatchFileCount: localPatch.files.length,
    localMirrorMatchesExpectedPatch: true,
    lockfileSha256,
  }
}

async function compareLocalMirror(
  localMirrorPath: string,
  files: readonly { readonly path: string; readonly digest: string; readonly size: number }[],
  patchFiles: ReadonlyMap<string, HarnessLocalPatchFile>,
): Promise<string[]> {
  const mismatches: string[] = []
  const officialPaths = new Set(files.map(file => file.path))
  for (const path of patchFiles.keys()) {
    if (!officialPaths.has(path)) mismatches.push(`${path} is not present in the official archive`)
  }
  let next = 0
  const workers = Array.from({ length: 32 }, async () => {
    while (true) {
      const index = next
      next += 1
      const expected = files[index]
      if (expected === undefined) return
      try {
        const bytes = await readFile(join(localMirrorPath, ...expected.path.split('/')))
        const digest = sha256Bytes(bytes)
        const patch = patchFiles.get(expected.path)
        if (patch !== undefined) {
          if (bytes.byteLength !== patch.size || digest !== patch.sha256) {
            mismatches.push(`${expected.path} does not match the registered patch digest`)
          } else if (bytes.byteLength === expected.size && digest === expected.digest) {
            mismatches.push(`${expected.path} is a redundant local patch entry`)
          }
        } else if (bytes.byteLength !== expected.size || digest !== expected.digest) {
          mismatches.push(expected.path)
        }
      } catch {
        mismatches.push(expected.path)
      }
    }
  })
  await Promise.all(workers)
  return mismatches.sort()
}

function parseLocalPatchManifest(value: unknown): HarnessLocalPatchManifest {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || typeof value.id !== 'string'
    || value.id.length === 0
    || typeof value.baselineCommit !== 'string'
    || typeof value.reason !== 'string'
    || value.reason.length === 0
    || !Array.isArray(value.files)) {
    throw new Error('Harness local patch manifest is invalid')
  }
  const files: HarnessLocalPatchFile[] = []
  const paths = new Set<string>()
  for (const [index, entry] of value.files.entries()) {
    if (!isRecord(entry)
      || typeof entry.path !== 'string'
      || !isRepositoryRelativePath(entry.path)
      || typeof entry.sha256 !== 'string'
      || !/^sha256:[0-9a-f]{64}$/u.test(entry.sha256)
      || typeof entry.size !== 'number'
      || !Number.isSafeInteger(entry.size)
      || entry.size < 0) {
      throw new Error(`Harness local patch file entry ${String(index)} is invalid`)
    }
    if (paths.has(entry.path)) throw new Error(`Harness local patch path is duplicated: ${entry.path}`)
    paths.add(entry.path)
    files.push({ path: entry.path, sha256: entry.sha256, size: entry.size })
  }
  if (files.length === 0) throw new Error('Harness local patch manifest contains no files')
  return {
    schemaVersion: 1,
    id: value.id,
    baselineCommit: value.baselineCommit,
    reason: value.reason,
    files,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRepositoryRelativePath(value: string): boolean {
  return value.length > 0
    && !value.startsWith('/')
    && !value.includes('\\')
    && value.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}
