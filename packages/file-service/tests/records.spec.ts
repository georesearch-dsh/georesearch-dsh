import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { IngestedFileRecord } from '@georesearch/dsh-contracts'
import { IngestedFileRecordStore } from '../src/records.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('attachment sidecar identity', () => {
  it('persists exact Agent/Session/Project/Workspace ownership and rejects rebinding', async () => {
    const home = await mkdtemp(join(tmpdir(), 'georesearch-file-record-'))
    roots.push(home)
    const store = new IngestedFileRecordStore(home)
    const record = attachmentRecord()
    await store.save(record)
    expect(await store.read(record.projectId, record.attachmentId)).toEqual(record)
    await expect(store.save({ ...record, sessionId: 'session-2' }))
      .rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' })
  })
})

function attachmentRecord(): IngestedFileRecord {
  return {
    schemaVersion: 1,
    attachmentId: '00000000-0000-4000-8000-000000000010',
    artifactId: `artifact-${'a'.repeat(64)}`,
    digest: `sha256:${'a'.repeat(64)}`,
    name: 'notes.txt',
    size: 5,
    mediaType: 'text/plain',
    contentKind: 'text',
    readStrategy: 'direct-text',
    projectId: 'project-records',
    workspaceId: 'workspace-records',
    sessionId: 'session-1',
    agentId: 'agent-1',
    extension: '.txt',
    parserProvenance: { detector: 'georesearch.magic/v1', evidence: 'text-sniff' },
    uploadedAt: '2026-08-16T00:00:00.000Z',
  }
}
