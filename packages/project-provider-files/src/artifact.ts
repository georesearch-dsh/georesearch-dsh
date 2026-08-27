import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  GeoResearchError,
  digestJson,
  type ArtifactRecord,
  type Sha256Digest,
  type WorkspaceBinding,
} from '@georesearch/dsh-contracts'
import { atomicWriteFile, publishNoClobber } from './atomic.js'
import { projectPaths } from './paths.js'
import {
  canonicalDirectoryIdentity,
  snapshotFileFromSingleHandle,
  snapshotWorkspaceFileFromSingleHandle,
  withSafeWorkspaceParentChain,
  type SnapshotNativeOptions,
} from './win32.js'

export interface ArtifactCommitInput {
  readonly projectId: string
  readonly binding: WorkspaceBinding
  readonly sourceRelativePath: string
  readonly kind: string
  readonly mediaType: string
  readonly inputDigests?: readonly Sha256Digest[]
  readonly transformationType: string
  readonly codeDigest?: Sha256Digest
  readonly configDigest?: Sha256Digest
  readonly committedAt: string
}

export interface ArtifactStreamCommitInput extends Omit<ArtifactCommitInput, 'sourceRelativePath'> {
  readonly sourceRelativePath?: string
}

export interface DeliverableMaterializeInput {
  readonly projectId: string
  readonly binding: WorkspaceBinding
  readonly artifact: ArtifactRecord
  readonly targetRelativePath: string
  readonly maxBytes: number
  readonly expectedDigest?: Sha256Digest
}

export interface DeliverableMaterializeResult {
  readonly relativePath: string
  readonly digest: Sha256Digest
  readonly size: number
  readonly status: 'created' | 'replaced' | 'unchanged'
}

export interface ArtifactStreamOptions {
  readonly maxBytes: number
  readonly signal?: AbortSignal
}

export interface ArtifactStoreConfig {
  readonly home: string
}

export interface VerifiedReadLeaseOptions {
  readonly maxBytes: number
  readonly signal?: AbortSignal
  readonly onHandleOpened?: () => void | Promise<void>
}

export interface VerifiedReadLease {
  readonly artifact: ArtifactRecord
  readonly bytes: Uint8Array
  readonly digest: Sha256Digest
  readonly size: number
}

export class ArtifactFileStore {
  constructor(private readonly config: ArtifactStoreConfig) {}

  async snapshot(
    input: ArtifactCommitInput,
    nativeOptions: SnapshotNativeOptions = {},
  ): Promise<ArtifactRecord> {
    validateInput(input)
    await assertBindingCurrent(input.binding)
    const normalizedRelative = containedRelativePath(input.sourceRelativePath)
    const source = resolve(input.binding.canonicalPath, normalizedRelative)
    assertContained(input.binding.canonicalPath, source)
    const paths = projectPaths(this.config.home, input.projectId)
    await Promise.all([mkdir(paths.temp, { recursive: true }), mkdir(paths.objectSha256, { recursive: true })])
    const temporary = join(paths.temp, `artifact-${randomUUID()}.tmp`)
    const snapshot = await snapshotWorkspaceFileFromSingleHandle(
      input.binding.canonicalPath,
      source,
      temporary,
      nativeOptions,
    )
    const digest = `sha256:${snapshot.digestHex}` as Sha256Digest
    const destination = join(paths.objectSha256, snapshot.digestHex.slice(0, 2), snapshot.digestHex)
    await mkdir(dirname(destination), { recursive: true })
    const publish = await publishNoClobber(temporary, destination)
    if (publish === 'exists') {
      await rm(temporary, { force: true })
      const existing = await verifyObject(destination, paths.temp)
      if (existing.digest !== digest || existing.size !== snapshot.size) {
        throw new GeoResearchError('ARTIFACT_INTEGRITY_FAILURE', `content-addressed object ${digest} does not match its name`)
      }
    }
    return artifactRecord(
      input,
      digest,
      snapshot.size,
      relative(paths.root, destination).replaceAll('\\', '/'),
      normalizedRelative.replaceAll('\\', '/'),
    )
  }

  async ingestStream(
    input: ArtifactStreamCommitInput,
    source: AsyncIterable<Uint8Array>,
    options: ArtifactStreamOptions,
  ): Promise<ArtifactRecord> {
    validateInput(input)
    const sourceRelativePath = input.sourceRelativePath === undefined
      ? undefined
      : containedRelativePath(input.sourceRelativePath).replaceAll('\\', '/')
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new TypeError('artifact stream maxBytes must be a positive safe integer')
    }
    await assertBindingCurrent(input.binding)
    const paths = projectPaths(this.config.home, input.projectId)
    await Promise.all([mkdir(paths.temp, { recursive: true }), mkdir(paths.objectSha256, { recursive: true })])
    const temporary = join(paths.temp, `artifact-${randomUUID()}.tmp`)
    const handle = await open(temporary, 'wx', 0o600)
    const hash = createHash('sha256')
    let size = 0
    let closed = false
    try {
      for await (const chunk of source) {
        options.signal?.throwIfAborted()
        const bytes = Buffer.from(chunk)
        size += bytes.byteLength
        if (size > options.maxBytes) {
          throw new GeoResearchError('ATTACHMENT_TOO_LARGE', `uploaded file exceeds ${options.maxBytes} bytes`)
        }
        hash.update(bytes)
        await handle.writeFile(bytes)
      }
      options.signal?.throwIfAborted()
      await handle.sync()
      await handle.close()
      closed = true
      const digestHex = hash.digest('hex')
      const digest = `sha256:${digestHex}` as Sha256Digest
      const destination = join(paths.objectSha256, digestHex.slice(0, 2), digestHex)
      await mkdir(dirname(destination), { recursive: true })
      const publish = await publishNoClobber(temporary, destination)
      if (publish === 'exists') {
        await rm(temporary, { force: true })
        const existing = await verifyObject(destination, paths.temp)
        if (existing.digest !== digest || existing.size !== size) {
          throw new GeoResearchError('ARTIFACT_INTEGRITY_FAILURE', `content-addressed object ${digest} does not match its name`)
        }
      }
      return artifactRecord(
        input,
        digest,
        size,
        relative(paths.root, destination).replaceAll('\\', '/'),
        sourceRelativePath,
      )
    } finally {
      if (!closed) await handle.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  async materializeDeliverable(input: DeliverableMaterializeInput): Promise<DeliverableMaterializeResult> {
    if (input.binding.projectId !== input.projectId || input.artifact.workspaceId !== input.binding.workspaceId) {
      throw new GeoResearchError('PROJECT_BINDING_MISMATCH', 'deliverable Artifact does not belong to the active workspace')
    }
    await assertBindingCurrent(input.binding)
    const normalized = containedRelativePath(input.targetRelativePath).replaceAll('\\', '/')
    if (!normalized.startsWith('deliverables/') || normalized === 'deliverables/') {
      throw new GeoResearchError('DELIVERABLE_INVALID', 'deliverables may be materialized only below deliverables/')
    }
    if (input.artifact.sourceRelativePath !== normalized) {
      throw new GeoResearchError('DELIVERABLE_INVALID', 'deliverable Artifact path does not match the requested output path')
    }
    const target = resolve(input.binding.canonicalPath, normalized)
    assertContained(input.binding.canonicalPath, target)
    const paths = projectPaths(this.config.home, input.projectId)
    return this.withVerifiedReadLease(
      input.projectId,
      input.artifact,
      { maxBytes: input.maxBytes },
      async lease => withSafeWorkspaceParentChain(
        input.binding.canonicalPath,
        dirname(target),
        async () => {
          const current = await currentFileIdentity(target, paths.temp)
          if (current !== undefined) {
            if (current.digest === lease.digest && current.size === lease.size) {
              return { relativePath: normalized, digest: lease.digest, size: lease.size, status: 'unchanged' }
            }
            if (input.expectedDigest === undefined) {
              throw new GeoResearchError(
                'DELIVERABLE_OVERWRITE_REQUIRES_DIGEST',
                `replacing ${normalized} requires expectedDigest=${current.digest}`,
              )
            }
            if (current.digest !== input.expectedDigest) {
              throw new GeoResearchError(
                'DELIVERABLE_PRECONDITION_FAILED',
                `${normalized} no longer matches the expected digest; current digest is ${current.digest}`,
              )
            }
          } else if (input.expectedDigest !== undefined) {
            throw new GeoResearchError(
              'DELIVERABLE_PRECONDITION_FAILED',
              `${normalized} does not exist at the expected digest`,
            )
          }

          await atomicWriteFile(target, lease.bytes)
          const published = await currentFileIdentity(target, paths.temp)
          if (published === undefined || published.digest !== lease.digest || published.size !== lease.size) {
            throw new GeoResearchError('ARTIFACT_INTEGRITY_FAILURE', `published deliverable ${normalized} failed verification`)
          }
          return {
            relativePath: normalized,
            digest: lease.digest,
            size: lease.size,
            status: current === undefined ? 'created' : 'replaced',
          }
        },
      ),
    )
  }

  objectPath(projectId: string, record: ArtifactRecord): string {
    const paths = projectPaths(this.config.home, projectId)
    const absolute = resolve(paths.root, record.objectPath)
    assertContained(paths.root, absolute)
    return absolute
  }

  async verifyForProject(projectId: string, record: ArtifactRecord): Promise<ArtifactRecord> {
    const absolute = this.objectPath(projectId, record)
    try {
      const checked = await verifyObject(absolute, projectPaths(this.config.home, projectId).temp)
      if (checked.digest !== record.digest || checked.size !== record.size) {
        return { ...record, integrity: 'corrupt' }
      }
      return { ...record, integrity: 'verified' }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...record, integrity: 'missing' }
      throw error
    }
  }

  async verifiedObjectPath(projectId: string, record: ArtifactRecord): Promise<string> {
    const verified = await this.verifyForProject(projectId, record)
    if (verified.integrity !== 'verified') {
      throw new GeoResearchError('ARTIFACT_INTEGRITY_FAILURE', `artifact ${record.artifactId} is ${verified.integrity}`)
    }
    return this.objectPath(projectId, verified)
  }

  async withVerifiedReadLease<T>(
    projectId: string,
    record: ArtifactRecord,
    options: VerifiedReadLeaseOptions,
    use: (lease: VerifiedReadLease) => T | Promise<T>,
  ): Promise<T> {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1) {
      throw new TypeError('verified read lease maxBytes must be a positive safe integer')
    }
    const path = this.objectPath(projectId, record)
    let handle
    try {
      handle = await open(path, 'r')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new GeoResearchError('ARTIFACT_NOT_FOUND', `artifact ${record.artifactId} object is missing`)
      }
      throw error
    }
    try {
      const before = await handle.stat()
      if (!before.isFile()) {
        throw new GeoResearchError('ARTIFACT_INTEGRITY_FAILURE', 'artifact object is not a regular file')
      }
      if (before.size > options.maxBytes) {
        throw new GeoResearchError(
          'ARTIFACT_INTEGRITY_FAILURE',
          `artifact ${record.artifactId} exceeds the verified read lease limit`,
        )
      }
      options.signal?.throwIfAborted()
      await options.onHandleOpened?.()
      options.signal?.throwIfAborted()
      const bytes = await handle.readFile()
      options.signal?.throwIfAborted()
      const after = await handle.stat()
      const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}` as Sha256Digest
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || bytes.byteLength !== after.size || digest !== record.digest || after.size !== record.size) {
        throw new GeoResearchError(
          'ARTIFACT_INTEGRITY_FAILURE',
          `artifact ${record.artifactId} changed or does not match its committed identity`,
        )
      }
      return await use({
        artifact: { ...record, integrity: 'verified' },
        bytes: Uint8Array.from(bytes),
        digest,
        size: after.size,
      })
    } finally {
      await handle.close()
    }
  }
}

function artifactRecord(
  input: ArtifactStreamCommitInput,
  digest: Sha256Digest,
  size: number,
  objectPath: string,
  sourceRelativePath?: string,
): ArtifactRecord {
  const lineage = {
    inputDigests: [...new Set(input.inputDigests ?? [])].sort(),
    transformationType: input.transformationType,
    ...(input.codeDigest === undefined ? {} : { codeDigest: input.codeDigest }),
    ...(input.configDigest === undefined ? {} : { configDigest: input.configDigest }),
    outputDigest: digest,
  }
  const artifactId = `artifact-${digestJson({
    domain: 'georesearch.artifact-id/v1',
    projectId: input.projectId,
    workspaceId: input.binding.workspaceId,
    kind: input.kind,
    digest,
    lineage,
  }).slice('sha256:'.length)}`
  return {
    schemaVersion: 1,
    artifactId,
    digest,
    kind: input.kind,
    size,
    mediaType: input.mediaType,
    ...(sourceRelativePath === undefined ? {} : { sourceRelativePath }),
    workspaceId: input.binding.workspaceId,
    materialization: 'committed',
    integrity: 'verified',
    validity: 'current',
    objectPath,
    lineage,
    committedAt: input.committedAt,
  }
}

async function verifyObject(path: string, tempRoot: string): Promise<{ readonly digest: Sha256Digest; readonly size: number }> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new GeoResearchError('ARTIFACT_INTEGRITY_FAILURE', 'content-addressed object is not a regular file')
  }
  await mkdir(tempRoot, { recursive: true })
  const temporary = join(tempRoot, `verify-${randomUUID()}.tmp`)
  try {
    const snapshot = await snapshotFileFromSingleHandle(path, temporary)
    return { digest: `sha256:${snapshot.digestHex}`, size: snapshot.size }
  } finally {
    await rm(temporary, { force: true })
  }
}

async function currentFileIdentity(
  path: string,
  tempRoot: string,
): Promise<{ readonly digest: Sha256Digest; readonly size: number } | undefined> {
  let info
  try {
    info = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new GeoResearchError('ARTIFACT_UNSAFE_FILE_TYPE', 'deliverable target is not a regular file')
  }
  await mkdir(tempRoot, { recursive: true })
  const temporary = join(tempRoot, `deliverable-${randomUUID()}.tmp`)
  try {
    const snapshot = await snapshotFileFromSingleHandle(path, temporary)
    return { digest: `sha256:${snapshot.digestHex}`, size: snapshot.size }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function assertBindingCurrent(binding: WorkspaceBinding): Promise<void> {
  const current = await canonicalDirectoryIdentity(binding.canonicalPath)
  if (current.volumeIdentity !== binding.volumeIdentity || current.fileIdentity !== binding.directoryFileIdentity) {
    throw new GeoResearchError('PROJECT_BINDING_MISMATCH', 'workspace identity no longer matches the authoritative binding')
  }
}

function validateInput(input: ArtifactStreamCommitInput): void {
  if (input.binding.projectId !== input.projectId) throw new TypeError('artifact binding projectId does not match')
  if (input.kind.trim().length === 0 || input.mediaType.trim().length === 0 || input.transformationType.trim().length === 0) {
    throw new TypeError('artifact kind, mediaType, and transformationType must be non-empty')
  }
  const date = new Date(input.committedAt)
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== input.committedAt) {
    throw new TypeError('artifact committedAt must be canonical UTC')
  }
}

function containedRelativePath(value: string): string {
  if (value.length === 0 || isAbsolute(value)) {
    throw new GeoResearchError('ARTIFACT_PATH_OUTSIDE_WORKSPACE', 'artifact path must be relative to the bound workspace')
  }
  const normalized = value.replaceAll('/', '\\')
  if (normalized === '..' || normalized.startsWith('..\\') || normalized.includes('\\..\\')) {
    throw new GeoResearchError('ARTIFACT_PATH_OUTSIDE_WORKSPACE', 'artifact path escapes the bound workspace')
  }
  return value
}

function assertContained(root: string, child: string): void {
  const normalizedRoot = resolve(root)
  const normalizedChild = resolve(child)
  const compareRoot = process.platform === 'win32' ? normalizedRoot.toLowerCase() : normalizedRoot
  const compareChild = process.platform === 'win32' ? normalizedChild.toLowerCase() : normalizedChild
  if (compareChild !== compareRoot && !compareChild.startsWith(`${compareRoot}\\`)
    && !compareChild.startsWith(`${compareRoot}/`)) {
    throw new GeoResearchError('ARTIFACT_PATH_OUTSIDE_WORKSPACE', 'artifact path escapes the bound workspace')
  }
}
