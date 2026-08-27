import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  GeoResearchError,
  canonicalJson,
  type IngestedFileRecord,
} from '@georesearch/dsh-contracts'
import { atomicWriteJson, publishNoClobber, projectPaths } from '@georesearch/dsh-project-provider-files'

export class IngestedFileRecordStore {
  constructor(private readonly home: string) {}

  async save(record: IngestedFileRecord): Promise<void> {
    validateRecord(record)
    const root = projectPaths(this.home, record.projectId).attachments
    await mkdir(root, { recursive: true })
    const destination = join(root, `${record.attachmentId}.json`)
    const temporary = join(root, `.${record.attachmentId}.${randomUUID()}.tmp`)
    let published = false
    try {
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(`${JSON.stringify(record, undefined, 2)}\n`, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      const result = await publishNoClobber(temporary, destination)
      if (result === 'published') {
        published = true
        return
      }
      const existing = await this.read(record.projectId, record.attachmentId)
      if (existing === undefined || canonicalJson(existing) !== canonicalJson(record)) {
        throw new GeoResearchError('ATTACHMENT_INVALID', `attachmentId ${record.attachmentId} is already bound to different content`)
      }
    } finally {
      if (!published) await rm(temporary, { force: true }).catch(() => undefined)
    }
  }

  async read(projectId: string, attachmentId: string): Promise<IngestedFileRecord | undefined> {
    assertAttachmentId(attachmentId)
    const path = join(projectPaths(this.home, projectId).attachments, `${attachmentId}.json`)
    try {
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new GeoResearchError('ATTACHMENT_INVALID', `attachment record ${attachmentId} is not a regular file`)
      }
      const value = JSON.parse(await readFile(path, 'utf8')) as unknown
      const record = parseRecord(value)
      if (record.projectId !== projectId || record.attachmentId !== attachmentId) {
        throw new GeoResearchError('ATTACHMENT_INVALID', `attachment record ${attachmentId} identity is inconsistent`)
      }
      return record
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async replaceClassification(previous: IngestedFileRecord, replacement: IngestedFileRecord): Promise<void> {
    validateRecord(previous)
    validateRecord(replacement)
    if (canonicalJson(stableRecordFields(previous)) !== canonicalJson(stableRecordFields(replacement))) {
      throw new GeoResearchError('ATTACHMENT_INVALID', 'attachment classification update changed immutable fields')
    }
    const current = await this.read(previous.projectId, previous.attachmentId)
    if (current === undefined) throw new GeoResearchError('ATTACHMENT_NOT_FOUND', `attachment ${previous.attachmentId} does not exist`)
    if (canonicalJson(current) === canonicalJson(replacement)) return
    if (canonicalJson(current) !== canonicalJson(previous)) {
      throw new GeoResearchError('ATTACHMENT_INVALID', `attachment ${previous.attachmentId} changed during classification update`)
    }
    const destination = join(projectPaths(this.home, previous.projectId).attachments, `${previous.attachmentId}.json`)
    await atomicWriteJson(destination, replacement)
  }

  async list(projectId: string): Promise<IngestedFileRecord[]> {
    const root = projectPaths(this.home, projectId).attachments
    let names: string[]
    try {
      names = await readdir(root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const records: IngestedFileRecord[] = []
    for (const name of names.filter(value => /^[0-9a-f-]{36}\.json$/u.test(value)).sort()) {
      const record = await this.read(projectId, name.slice(0, -'.json'.length))
      if (record !== undefined) records.push(record)
    }
    return records.sort((left, right) => left.uploadedAt.localeCompare(right.uploadedAt)
      || left.attachmentId.localeCompare(right.attachmentId))
  }
}

export function assertAttachmentId(value: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) {
    throw new GeoResearchError('ATTACHMENT_INVALID', 'attachmentId must be a lowercase UUID v4')
  }
}

function validateRecord(record: IngestedFileRecord): void {
  assertAttachmentId(record.attachmentId)
  canonicalJson(record)
  if (record.schemaVersion !== 1 || record.name.length === 0 || record.projectId.length === 0
    || record.workspaceId.length === 0 || record.sessionId.length === 0 || record.agentId.length === 0
    || !Number.isSafeInteger(record.size) || record.size < 0) {
    throw new GeoResearchError('ATTACHMENT_INVALID', 'attachment record fields are invalid')
  }
}

function parseRecord(value: unknown): IngestedFileRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GeoResearchError('ATTACHMENT_INVALID', 'attachment record is not an object')
  }
  const record = value as IngestedFileRecord
  validateRecord(record)
  return record
}

function stableRecordFields(record: IngestedFileRecord): object {
  return {
    schemaVersion: record.schemaVersion,
    attachmentId: record.attachmentId,
    artifactId: record.artifactId,
    digest: record.digest,
    name: record.name,
    size: record.size,
    mediaType: record.mediaType,
    projectId: record.projectId,
    workspaceId: record.workspaceId,
    sessionId: record.sessionId,
    agentId: record.agentId,
    ...(record.browserMediaType === undefined ? {} : { browserMediaType: record.browserMediaType }),
    uploadedAt: record.uploadedAt,
  }
}
