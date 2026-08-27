import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ArtifactFileStore,
  inspectWorkspace,
  workspaceBinding,
} from '../src/index.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('artifact file store', () => {
  it('publishes content without clobber and returns the same content identity', async () => {
    const fixture = await artifactFixture()
    await writeFile(join(fixture.root, 'result.txt'), 'immutable result')
    const first = await fixture.artifacts.snapshot(input(fixture, 'result.txt'))
    const second = await fixture.artifacts.snapshot(input(fixture, 'result.txt'))
    expect(second.artifactId).toBe(first.artifactId)
    expect(second.digest).toBe(first.digest)
    expect(await readFile(fixture.artifacts.objectPath(fixture.projectId, first), 'utf8')).toBe('immutable result')
  })

  it('holds one source handle that denies concurrent writes while copying', async () => {
    const fixture = await artifactFixture()
    const source = join(fixture.root, 'locked.txt')
    await writeFile(source, 'original bytes')
    let writeDenied = false
    const record = await fixture.artifacts.snapshot(input(fixture, 'locked.txt'), {
      onSourceOpened: async () => {
        try {
          await writeFile(source, 'changed bytes')
        } catch {
          writeDenied = true
        }
      },
    })
    if (process.platform === 'win32') expect(writeDenied).toBe(true)
    expect(await readFile(fixture.artifacts.objectPath(fixture.projectId, record), 'utf8')).toBe('original bytes')
  })

  it('rejects a junction or symbolic-link component in the source path', async () => {
    const fixture = await artifactFixture()
    const outside = await temporaryRoot('georesearch-artifact-outside-')
    await writeFile(join(outside, 'secret.txt'), 'outside')
    const linked = join(fixture.root, 'linked')
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(fixture.artifacts.snapshot(input(fixture, 'linked/secret.txt')))
      .rejects.toMatchObject({ code: 'ARTIFACT_UNSAFE_FILE_TYPE' })
  })

  it('rejects paths outside the authoritative workspace binding', async () => {
    const fixture = await artifactFixture()
    await expect(fixture.artifacts.snapshot(input(fixture, '../outside.txt')))
      .rejects.toMatchObject({ code: 'ARTIFACT_PATH_OUTSIDE_WORKSPACE' })
  })

  it('ingests a bounded stream without exposing a workspace source path', async () => {
    const fixture = await artifactFixture()
    const record = await fixture.artifacts.ingestStream({
      projectId: fixture.projectId,
      binding: fixture.binding,
      kind: 'uploaded-file',
      mediaType: 'text/plain',
      transformationType: 'user-upload',
      committedAt: '2026-08-16T00:00:00.000Z',
    }, stream('streamed ', 'upload'), { maxBytes: 64 })
    expect(record).not.toHaveProperty('sourceRelativePath')
    expect(record.size).toBe(15)
    expect(await readFile(fixture.artifacts.objectPath(fixture.projectId, record), 'utf8')).toBe('streamed upload')
  })

  it('stops an oversized stream and removes its private temporary file', async () => {
    const fixture = await artifactFixture()
    await expect(fixture.artifacts.ingestStream({
      projectId: fixture.projectId,
      binding: fixture.binding,
      kind: 'uploaded-file',
      mediaType: 'application/octet-stream',
      transformationType: 'user-upload',
      committedAt: '2026-08-16T00:00:00.000Z',
    }, stream('1234', '5678'), { maxBytes: 6 })).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' })
    expect(await readdir(join(fixture.home, 'georesearch', 'projects', fixture.projectId, 'temp'))).toEqual([])
  })

  it('hands verified immutable bytes to a callback while the same handle remains open', async () => {
    const fixture = await artifactFixture()
    await writeFile(join(fixture.root, 'paper.pdf'), 'verified paper bytes')
    const record = await fixture.artifacts.snapshot(input(fixture, 'paper.pdf'))
    const path = fixture.artifacts.objectPath(fixture.projectId, record)
    let opened = false
    const value = await fixture.artifacts.withVerifiedReadLease(
      fixture.projectId,
      record,
      {
        maxBytes: 1024,
        onHandleOpened: () => { opened = true },
      },
      async lease => {
        expect(opened).toBe(true)
        expect(lease.digest).toBe(record.digest)
        expect(Buffer.from(lease.bytes).toString('utf8')).toBe('verified paper bytes')
        await rm(path, { force: true })
        return lease.size
      },
    )
    expect(value).toBe(record.size)
  })
})

async function* stream(...chunks: string[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield Buffer.from(chunk)
}

async function artifactFixture(): Promise<{
  readonly root: string
  readonly home: string
  readonly projectId: string
  readonly binding: ReturnType<typeof workspaceBinding>
  readonly artifacts: ArtifactFileStore
}> {
  const root = await temporaryRoot('georesearch-artifact-')
  await mkdir(join(root, 'workspace-data'))
  const home = join(root, 'host-home')
  const projectId = 'project-artifact'
  const binding = workspaceBinding(projectId, await inspectWorkspace(root), 1, '2026-08-16T00:00:00.000Z')
  return { root, home, projectId, binding, artifacts: new ArtifactFileStore({ home }) }
}

function input(fixture: Awaited<ReturnType<typeof artifactFixture>>, sourceRelativePath: string) {
  return {
    projectId: fixture.projectId,
    binding: fixture.binding,
    sourceRelativePath,
    kind: 'test-output',
    mediaType: 'text/plain',
    transformationType: 'same-handle-snapshot',
    committedAt: '2026-08-16T00:00:00.000Z',
  }
}

async function temporaryRoot(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(path)
  return path
}
