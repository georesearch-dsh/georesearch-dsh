import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import * as tar from 'tar-stream'
import {
  DEFAULT_ARCHIVE_LIMITS,
  listArchive,
  readArchiveEntry,
  validateArchivePath,
} from '../src/archive.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('safe archive inspection', () => {
  it('lists and reads a regular ZIP entry without extracting it', async () => {
    const path = await archivePath('safe.zip', zipBytes([{ name: 'notes/readme.txt', data: 'bounded text' }]))
    const listing = await listArchive(path, 'zip')
    expect(listing).toMatchObject({
      format: 'zip',
      totalEntries: 1,
      totalExpandedBytes: 12,
      entries: [{ path: 'notes/readme.txt', type: 'file', size: 12 }],
    })
    expect(Buffer.from(await readArchiveEntry(path, 'zip', 'notes/readme.txt')).toString()).toBe('bounded text')
  })

  it('rejects traversal, absolute, NTFS ADS, duplicate, and symlink ZIP entries', async () => {
    for (const unsafe of ['../secret.txt', '/absolute.txt', 'C:/absolute.txt', 'notes.txt:payload']) {
      expect(() => validateArchivePath(unsafe)).toThrow(/ATTACHMENT_ARCHIVE_UNSAFE/)
    }
    const duplicate = await archivePath('duplicate.zip', zipBytes([
      { name: 'same.txt', data: 'left' },
      { name: 'same.txt', data: 'right' },
    ]))
    await expect(listArchive(duplicate, 'zip')).rejects.toMatchObject({ code: 'ATTACHMENT_ARCHIVE_UNSAFE' })

    const link = await archivePath('link.zip', zipBytes([
      { name: 'shortcut', data: 'target.txt', mode: 0o120777 },
    ]))
    await expect(listArchive(link, 'zip')).rejects.toMatchObject({ code: 'ATTACHMENT_ARCHIVE_UNSAFE' })
  })

  it('rejects excessive ZIP expansion ratios under the configured safety envelope', async () => {
    const path = await archivePath('ratio.zip', zipBytes([{ name: 'data.txt', data: '1234' }]))
    await expect(listArchive(path, 'zip', 100, {
      ...DEFAULT_ARCHIVE_LIMITS,
      maxCompressionRatio: 0.5,
    })).rejects.toMatchObject({ code: 'ATTACHMENT_ARCHIVE_UNSAFE' })
  })

  it('reads regular TAR entries and rejects links and duplicate paths', async () => {
    const safe = await archivePath('safe.tar', await tarBytes([
      { name: 'folder/data.csv', data: 'x,y\n1,2\n' },
    ]))
    expect(await listArchive(safe, 'tar')).toMatchObject({
      totalEntries: 1,
      entries: [{ path: 'folder/data.csv', type: 'file', size: 8 }],
    })
    expect(Buffer.from(await readArchiveEntry(safe, 'tar', 'folder/data.csv')).toString()).toBe('x,y\n1,2\n')

    const link = await archivePath('link.tar', await tarBytes([
      { name: 'shortcut', data: '', type: 'symlink', linkname: 'target.txt' },
    ]))
    await expect(listArchive(link, 'tar')).rejects.toMatchObject({ code: 'ATTACHMENT_ARCHIVE_UNSAFE' })

    const duplicate = await archivePath('duplicate.tar', await tarBytes([
      { name: 'same.txt', data: 'left' },
      { name: 'same.txt', data: 'right' },
    ]))
    await expect(listArchive(duplicate, 'tar')).rejects.toMatchObject({ code: 'ATTACHMENT_ARCHIVE_UNSAFE' })
  })
})

async function archivePath(name: string, bytes: Uint8Array): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'georesearch-archive-'))
  roots.push(root)
  const path = join(root, name)
  await writeFile(path, bytes)
  return path
}

interface TarEntryInput {
  readonly name: string
  readonly data: string
  readonly type?: tar.Headers['type']
  readonly linkname?: string
}

async function tarBytes(entries: readonly TarEntryInput[]): Promise<Buffer> {
  const pack = tar.pack()
  const chunks: Buffer[] = []
  pack.on('data', chunk => chunks.push(Buffer.from(chunk)))
  const ended = new Promise<void>((resolve, reject) => {
    pack.once('end', resolve)
    pack.once('error', reject)
  })
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      pack.entry({
        name: entry.name,
        size: Buffer.byteLength(entry.data),
        ...(entry.type === undefined ? {} : { type: entry.type }),
        ...(entry.linkname === undefined ? {} : { linkname: entry.linkname }),
      }, entry.data, error => error === null ? resolve() : reject(error))
    })
  }
  pack.finalize()
  await ended
  return Buffer.concat(chunks)
}

interface ZipEntryInput {
  readonly name: string
  readonly data: string
  readonly mode?: number
}

function zipBytes(entries: readonly ZipEntryInput[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const data = Buffer.from(entry.data)
    const crc = crc32(data)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(data.byteLength, 18)
    localHeader.writeUInt32LE(data.byteLength, 22)
    localHeader.writeUInt16LE(name.byteLength, 26)
    local.push(localHeader, name, data)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(0x0314, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(data.byteLength, 20)
    centralHeader.writeUInt32LE(data.byteLength, 24)
    centralHeader.writeUInt16LE(name.byteLength, 28)
    centralHeader.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, name)
    offset += localHeader.byteLength + name.byteLength + data.byteLength
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.byteLength, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBytes, end])
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
