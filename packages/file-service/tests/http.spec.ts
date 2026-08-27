import { createServer, type RequestListener } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import { sha256Bytes, type ArtifactRecord, type IngestedFileRecord } from '@georesearch/dsh-contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FILE_API_PATH, GeoResearchFileService, inject } from '../src/index.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('universal file HTTP route', () => {
  it('keeps the file service available when the host has no Web server', async () => {
    const home = await mkdtemp(join(tmpdir(), 'georesearch-file-headless-'))
    roots.push(home)
    const ctx = new Context()
    const service = new GeoResearchFileService(
      ctx,
      { home },
      { analyze: vi.fn(), dispose: vi.fn(async () => undefined) } as never,
      { analyze: vi.fn() } as never,
    )

    expect(inject).not.toContain('webServer')
    expect(service).toBeInstanceOf(GeoResearchFileService)
    await ctx.fiber.dispose()
  })

  it('uploads raw bytes, exposes a path-free reference, restores it by GET, and denies another session', async () => {
    const fixture = await httpFixture()
    try {
      const attachmentId = '00000000-0000-4000-8000-000000000020'
      const bytes = Buffer.from('plain text despite the browser claim\n')
      const upload = await fetch(`${fixture.origin}${FILE_API_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.byteLength),
          'x-georesearch-session-id': 'session-1',
          'x-georesearch-attachment-id': attachmentId,
          'x-georesearch-file-name': Buffer.from('misleading.pdf').toString('base64url'),
          'x-georesearch-browser-media-type': 'application/pdf',
          'x-georesearch-batch-count': '2',
          'x-georesearch-batch-bytes': String(bytes.byteLength + 8),
        },
        body: bytes,
      })
      expect(upload.status).toBe(201)
      const reference = await upload.json() as Record<string, unknown>
      expect(reference).toMatchObject({
        attachmentId,
        name: 'misleading.pdf',
        size: bytes.byteLength,
        mediaType: 'text/plain',
        contentKind: 'text',
        readStrategy: 'direct-text',
      })
      expect(reference).not.toHaveProperty('sourceRelativePath')
      expect(await readFile(fixture.objects.get(String(reference.artifactId))!, 'utf8')).toBe(bytes.toString())

      const stored = await fixture.service.records.read('project-http', attachmentId)
      expect(stored).toMatchObject({
        browserMediaType: 'application/pdf',
        sessionId: 'session-1',
        agentId: 'agent-1',
        workspaceId: 'workspace-http',
        parserProvenance: { evidence: 'text-sniff' },
      })

      const restored = await fetch(`${fixture.origin}${FILE_API_PATH}/${attachmentId}`, {
        headers: { 'x-georesearch-session-id': 'session-1' },
      })
      expect(restored.status).toBe(200)
      expect(await restored.json()).toEqual(reference)

      const forbidden = await fetch(`${fixture.origin}${FILE_API_PATH}/${attachmentId}`, {
        headers: { 'x-georesearch-session-id': 'session-2' },
      })
      expect(forbidden.status).toBe(403)
      expect(await forbidden.json()).toMatchObject({ error: { code: 'ATTACHMENT_SESSION_MISMATCH' } })
    } finally {
      await fixture.close()
    }
  })

  it('enforces declared batch and single-file limits before committing bytes', async () => {
    const fixture = await httpFixture({ maxFileBytes: 4 })
    try {
      const response = await fetch(`${fixture.origin}${FILE_API_PATH}`, {
        method: 'POST',
        headers: uploadHeaders('00000000-0000-4000-8000-000000000021', 'large.bin', 5),
        body: Buffer.from('12345'),
      })
      expect(response.status).toBe(413)
      expect(await response.json()).toMatchObject({ error: { code: 'ATTACHMENT_TOO_LARGE' } })
      expect(fixture.objects.size).toBe(0)
    } finally {
      await fixture.close()
    }
  })

  it('rejects recognized binary formats that have no approved content reader before Artifact commit', async () => {
    const fixture = await httpFixture()
    try {
      const bytes = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])
      const response = await fetch(`${fixture.origin}${FILE_API_PATH}`, {
        method: 'POST',
        headers: uploadHeaders('00000000-0000-4000-8000-000000000022', 'recording.wav', bytes.byteLength),
        body: bytes,
      })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({
        error: {
          code: 'ATTACHMENT_MEDIA_UNREADABLE',
          message: expect.stringContaining('no approved content reader'),
        },
      })
      expect(fixture.objects.size).toBe(0)
    } finally {
      await fixture.close()
    }
  })

  it('rolls back Artifact visibility when the attachment sidecar cannot be saved', async () => {
    const fixture = await httpFixture()
    try {
      vi.spyOn(fixture.service.records, 'save').mockRejectedValueOnce(new Error('attachment record volume is full'))
      const attachmentId = '00000000-0000-4000-8000-000000000025'
      const bytes = Buffer.from('rollback upload')
      const response = await fetch(`${fixture.origin}${FILE_API_PATH}`, {
        method: 'POST',
        headers: uploadHeaders(attachmentId, 'rollback.txt', bytes.byteLength),
        body: bytes,
      })

      expect(response.status).toBe(500)
      expect(fixture.rollbacks).toEqual([expect.objectContaining({ attachmentId, expectedGeneration: 2 })])
      expect(fixture.objects.size).toBe(0)
    } finally {
      await fixture.close()
    }
  })

  it('accepts common images without requiring the Harness native image store', async () => {
    const fixture = await httpFixture()
    try {
      const attachmentId = '00000000-0000-4000-8000-000000000024'
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      const response = await fetch(`${fixture.origin}${FILE_API_PATH}`, {
        method: 'POST',
        headers: uploadHeaders(attachmentId, 'map.png', bytes.byteLength),
        body: bytes,
      })

      expect(response.status).toBe(201)
      expect(await response.json()).toMatchObject({
        attachmentId,
        mediaType: 'image/png',
        contentKind: 'image',
        readStrategy: 'image',
      })
    } finally {
      await fixture.close()
    }
  })

  it('upgrades a legacy provider-required record after Artifact integrity verification', async () => {
    const fixture = await httpFixture()
    try {
      const attachmentId = '00000000-0000-4000-8000-000000000023'
      const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04])
      await fixture.seedLegacyAttachment({
        schemaVersion: 1,
        attachmentId,
        artifactId: `artifact-${sha256Bytes(bytes).slice('sha256:'.length)}`,
        digest: sha256Bytes(bytes),
        name: 'legacy-paper.docx',
        size: bytes.byteLength,
        mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        contentKind: 'document',
        readStrategy: 'provider-required',
        projectId: 'project-http',
        workspaceId: 'workspace-http',
        sessionId: 'session-1',
        agentId: 'agent-1',
        extension: '.docx',
        archive: { format: 'zip', supported: true },
        parserProvenance: {
          detector: 'georesearch.magic/v1',
          evidence: 'magic+name',
          archiveParser: 'yauzl',
        },
        uploadedAt: '2026-08-16T00:00:00.000Z',
      }, bytes)

      const restored = await fetch(`${fixture.origin}${FILE_API_PATH}/${attachmentId}`, {
        headers: { 'x-georesearch-session-id': 'session-1' },
      })
      expect(restored.status).toBe(200)
      expect(await restored.json()).toMatchObject({
        attachmentId,
        readStrategy: 'document',
      })
      expect(await fixture.service.records.read('project-http', attachmentId)).toMatchObject({
        readStrategy: 'document',
        parserProvenance: { contentParser: 'openxml' },
      })
    } finally {
      await fixture.close()
    }
  })
})

async function httpFixture(config: { readonly maxFileBytes?: number } = {}): Promise<{
  readonly origin: string
  readonly service: GeoResearchFileService
  readonly objects: Map<string, string>
  readonly rollbacks: Array<Record<string, unknown>>
  readonly seedLegacyAttachment: (record: IngestedFileRecord, bytes: Uint8Array) => Promise<void>
  readonly close: () => Promise<void>
}> {
  const home = await mkdtemp(join(tmpdir(), 'georesearch-file-http-'))
  roots.push(home)
  const objectRoot = join(home, 'mock-objects')
  await mkdir(objectRoot)
  const agents = new Map([
    ['session-1', agent('agent-1', 'session-1', home)],
    ['session-2', agent('agent-2', 'session-2', home)],
  ])
  const objects = new Map<string, string>()
  const artifacts = new Map<string, ArtifactRecord>()
  const rollbacks: Array<Record<string, unknown>> = []
  let route: RequestListener | undefined
  const ctx = new Context()
  ctx.provide('webServer', {
    register(value: { readonly handler: RequestListener }) {
      route = value.handler
      return () => undefined
    },
  } as never)
  ctx.provide('agents', { get: (id: string) => agents.get(String(id)) } as never)
  ctx.provide('geoResearchInstallation', { assertCurrent: () => undefined } as never)
  ctx.provide('geoResearchPolicy', { actorFor: () => 'coordinator' } as never)
  ctx.provide('geoResearchProjects', {
    async resolveAgent() {
      return { stateFile: { projectId: 'project-http' }, binding: { workspaceId: 'workspace-http' } }
    },
    async commitUploadedArtifact(_agent: unknown, request: {
      readonly source: AsyncIterable<Uint8Array>
      readonly mediaType: string
    }) {
      const chunks: Buffer[] = []
      for await (const chunk of request.source) chunks.push(Buffer.from(chunk))
      const bytes = Buffer.concat(chunks)
      const digest = sha256Bytes(bytes)
      const artifactId = `artifact-${digest.slice('sha256:'.length)}`
      const path = join(objectRoot, artifactId)
      await writeFile(path, bytes, { flag: 'wx' }).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error
      })
      const artifact: ArtifactRecord = {
        schemaVersion: 1,
        artifactId,
        digest,
        kind: 'uploaded-file',
        size: bytes.byteLength,
        mediaType: request.mediaType,
        workspaceId: 'workspace-http',
        materialization: 'committed',
        integrity: 'verified',
        validity: 'current',
        objectPath: `objects/${artifactId}`,
        lineage: { inputDigests: [], transformationType: 'user-upload', outputDigest: digest },
        committedAt: '2026-08-16T00:00:00.000Z',
      }
      objects.set(artifactId, path)
      artifacts.set(artifactId, artifact)
      return { projectId: 'project-http', workspaceId: 'workspace-http', generation: 2, artifact }
    },
    async rollbackUploadedArtifact(_agent: unknown, request: Record<string, unknown>) {
      rollbacks.push(request)
      const artifact = request.artifact as { readonly artifactId: string }
      const path = objects.get(artifact.artifactId)
      if (path !== undefined) await rm(path, { force: true })
      objects.delete(artifact.artifactId)
      artifacts.delete(artifact.artifactId)
      return { projectId: 'project-http', generation: 3, rolledBack: true }
    },
    async resolveArtifactFile(_agent: unknown, artifactId: string) {
      const artifact = artifacts.get(artifactId)
      const path = objects.get(artifactId)
      if (artifact === undefined || path === undefined) throw new Error('mock artifact is missing')
      return { projectId: 'project-http', workspaceId: 'workspace-http', artifact, path }
    },
  } as never)
  const service = new GeoResearchFileService(ctx, { home, ...config })
  if (route === undefined) throw new Error('file service did not register its HTTP route')
  const server = createServer(route)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${address.port}`,
    service,
    objects,
    rollbacks,
    seedLegacyAttachment: async (record, bytes) => {
      const path = join(objectRoot, record.artifactId)
      await writeFile(path, bytes, { flag: 'wx' })
      const artifact: ArtifactRecord = {
        schemaVersion: 1,
        artifactId: record.artifactId,
        digest: record.digest,
        kind: 'uploaded-file',
        size: record.size,
        mediaType: record.mediaType,
        workspaceId: record.workspaceId,
        materialization: 'committed',
        integrity: 'verified',
        validity: 'current',
        objectPath: `objects/${record.artifactId}`,
        lineage: { inputDigests: [], transformationType: 'user-upload', outputDigest: record.digest },
        committedAt: record.uploadedAt,
      }
      objects.set(record.artifactId, path)
      artifacts.set(record.artifactId, artifact)
      await service.records.save(record)
    },
    close: async () => await new Promise<void>((resolve, reject) => {
      server.close(error => error === undefined ? resolve() : reject(error))
    }),
  }
}

function agent(id: string, sessionId: string, cwd: string) {
  return { id, session: { id: sessionId, header: { cwd } } }
}

function uploadHeaders(attachmentId: string, name: string, length: number): Record<string, string> {
  return {
    'content-type': 'application/octet-stream',
    'content-length': String(length),
    'x-georesearch-session-id': 'session-1',
    'x-georesearch-attachment-id': attachmentId,
    'x-georesearch-file-name': Buffer.from(name).toString('base64url'),
    'x-georesearch-batch-count': '1',
    'x-georesearch-batch-bytes': String(length),
  }
}
