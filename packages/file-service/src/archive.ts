import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar-stream'
import * as yauzl from 'yauzl'
import {
  GENERIC_ATTACHMENT_LIMITS,
  GeoResearchError,
  type AttachmentArchiveFormat,
} from '@georesearch/dsh-contracts'

export interface SafeArchiveEntry {
  readonly path: string
  readonly type: 'file' | 'directory'
  readonly size: number
  readonly compressedSize?: number
}

export interface SafeArchiveListing {
  readonly format: AttachmentArchiveFormat
  readonly entries: readonly SafeArchiveEntry[]
  readonly totalEntries: number
  readonly totalExpandedBytes: number
  readonly truncated: boolean
}

export interface SafeZipSelection {
  readonly listing: SafeArchiveListing
  readonly files: ReadonlyMap<string, Uint8Array>
}

export interface ArchiveSafetyLimits {
  readonly maxEntries: number
  readonly maxExpandedBytes: number
  readonly maxEntryBytes: number
  readonly maxCompressionRatio: number
  readonly maxPathBytes: number
  readonly maxPathDepth: number
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveSafetyLimits = Object.freeze({
  maxEntries: GENERIC_ATTACHMENT_LIMITS.maxArchiveEntries,
  maxExpandedBytes: GENERIC_ATTACHMENT_LIMITS.maxArchiveExpandedBytes,
  maxEntryBytes: GENERIC_ATTACHMENT_LIMITS.maxArchiveEntryBytes,
  maxCompressionRatio: GENERIC_ATTACHMENT_LIMITS.maxArchiveCompressionRatio,
  maxPathBytes: GENERIC_ATTACHMENT_LIMITS.maxArchivePathBytes,
  maxPathDepth: GENERIC_ATTACHMENT_LIMITS.maxArchivePathDepth,
})

export async function listArchive(
  path: string,
  format: AttachmentArchiveFormat,
  limit = 1_000,
  limits: ArchiveSafetyLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<SafeArchiveListing> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > limits.maxEntries) throw new TypeError('archive list limit is invalid')
  switch (format) {
    case 'zip': return listZip(path, limit, limits)
    case 'tar':
    case 'tar.gz': return listTar(path, format, limit, limits)
    default:
      throw new GeoResearchError('ATTACHMENT_ARCHIVE_UNSUPPORTED', `${format} archives are stored but have no approved parser`)
  }
}

export async function readArchiveEntry(
  path: string,
  format: AttachmentArchiveFormat,
  requestedPath: string,
  maxBytes = GENERIC_ATTACHMENT_LIMITS.maxDirectReadBytes,
  limits: ArchiveSafetyLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<Uint8Array> {
  const normalized = validateArchivePath(requestedPath, limits)
  switch (format) {
    case 'zip': return readZipEntry(path, normalized, maxBytes, limits)
    case 'tar':
    case 'tar.gz': return readTarEntry(path, format, normalized, maxBytes, limits)
    default:
      throw new GeoResearchError('ATTACHMENT_ARCHIVE_UNSUPPORTED', `${format} archives are stored but have no approved parser`)
  }
}

export async function readZipEntries(
  path: string,
  select: (entry: SafeArchiveEntry) => boolean,
  maxTotalBytes: number,
  signal?: AbortSignal,
  limits: ArchiveSafetyLimits = DEFAULT_ARCHIVE_LIMITS,
): Promise<SafeZipSelection> {
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1 || maxTotalBytes > limits.maxExpandedBytes) {
    throw new TypeError('ZIP selection byte limit is invalid')
  }
  const listing = await listZip(path, limits.maxEntries, limits)
  const selected = listing.entries.filter(entry => entry.type === 'file' && select(entry))
  const selectedBytes = selected.reduce((sum, entry) => sum + entry.size, 0)
  if (selectedBytes > maxTotalBytes) {
    throw new GeoResearchError('ATTACHMENT_TOO_LARGE', `selected ZIP content exceeds ${maxTotalBytes} bytes`)
  }
  if (selected.length === 0) return { listing, files: new Map() }

  const expected = new Map(selected.map(entry => [entry.path, entry]))
  const files = new Map<string, Uint8Array>()
  const zip = await openZip(path)
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = (): void => { signal?.removeEventListener('abort', onAbort) }
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const succeed = (): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      }
      const onAbort = (): void => fail(signal?.reason instanceof Error ? signal.reason : new Error('ZIP read aborted'))
      if (signal?.aborted === true) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      zip.on('error', fail)
      zip.on('entry', (entry) => {
        let normalized: string
        try {
          normalized = validateArchivePath(entry.fileName, limits)
          validateZipEntry(entry, normalized, limits)
        } catch (error) {
          fail(error)
          return
        }
        const selectedEntry = expected.get(normalized)
        if (selectedEntry === undefined) {
          zip.readEntry()
          return
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error !== null) {
            fail(error)
            return
          }
          if (stream === undefined) {
            fail(new GeoResearchError('ATTACHMENT_UPLOAD_INCOMPLETE', `archive entry ${normalized} opened no stream`))
            return
          }
          void readBounded(stream, selectedEntry.size).then((bytes) => {
            if (settled) return
            files.set(normalized, bytes)
            zip.readEntry()
          }, fail)
        })
      })
      zip.on('end', () => {
        if (files.size !== expected.size) {
          fail(new GeoResearchError('ATTACHMENT_UPLOAD_INCOMPLETE', 'ZIP selection ended before every validated entry was read'))
          return
        }
        succeed()
      })
      zip.readEntry()
    })
    return { listing, files }
  } finally {
    zip.close()
  }
}

export function validateArchivePath(value: string, limits: ArchiveSafetyLimits = DEFAULT_ARCHIVE_LIMITS): string {
  if (value.includes('\0')) throw unsafe('archive entry contains NUL')
  const normalized = value.normalize('NFC').replaceAll('\\', '/')
  if (normalized.startsWith('/') || normalized.startsWith('//') || /^[A-Za-z]:/u.test(normalized)) {
    throw unsafe(`archive entry is absolute: ${value}`)
  }
  const body = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
  const segments = body.split('/')
  if (body.length === 0 || segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw unsafe(`archive entry path is not contained: ${value}`)
  }
  if (segments.some(segment => segment.includes(':'))) throw unsafe(`archive entry uses an NTFS alternate stream: ${value}`)
  if (segments.length > limits.maxPathDepth) throw unsafe(`archive entry path is too deep: ${value}`)
  if (Buffer.byteLength(normalized, 'utf8') > limits.maxPathBytes) throw unsafe(`archive entry path is too long: ${value}`)
  return normalized
}

async function listZip(path: string, limit: number, limits: ArchiveSafetyLimits): Promise<SafeArchiveListing> {
  const archiveBytes = (await stat(path)).size
  const zip = await openZip(path)
  try {
    const entries = await scanZip(zip, limits)
    assertOverallRatio(entries.reduce((sum, entry) => sum + entry.size, 0), archiveBytes, limits)
    return listing('zip', entries, limit)
  } finally {
    zip.close()
  }
}

async function readZipEntry(
  path: string,
  requestedPath: string,
  maxBytes: number,
  limits: ArchiveSafetyLimits,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > limits.maxEntryBytes) throw new TypeError('archive read maxBytes is invalid')
  const listing = await listZip(path, limits.maxEntries, limits)
  const selected = listing.entries.find(entry => entry.path === requestedPath)
  if (selected === undefined) throw new GeoResearchError('ATTACHMENT_NOT_FOUND', `archive entry ${requestedPath} does not exist`)
  if (selected.type !== 'file') throw new GeoResearchError('ATTACHMENT_MEDIA_UNREADABLE', `archive entry ${requestedPath} is not a file`)
  if (selected.size > maxBytes) throw new GeoResearchError('ATTACHMENT_TOO_LARGE', `archive entry ${requestedPath} exceeds the ${maxBytes}-byte read limit`)

  const zip = await openZip(path)
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      let settled = false
      const fail = (error: unknown): void => {
        if (settled) return
        settled = true
        reject(error)
      }
      zip.on('error', fail)
      zip.on('entry', (entry) => {
        let normalized: string
        try {
          normalized = validateArchivePath(entry.fileName, limits)
          validateZipEntry(entry, normalized, limits)
        } catch (error) {
          fail(error)
          return
        }
        if (normalized !== requestedPath) {
          zip.readEntry()
          return
        }
        zip.openReadStream(entry, (error, stream) => {
          if (error !== null) {
            fail(error)
            return
          }
          if (stream === undefined) {
            fail(new GeoResearchError('ATTACHMENT_UPLOAD_INCOMPLETE', `archive entry ${requestedPath} opened no stream`))
            return
          }
          void readBounded(stream, maxBytes).then((bytes) => {
            if (settled) return
            settled = true
            resolve(bytes)
          }, fail)
        })
      })
      zip.on('end', () => {
        if (!settled) fail(new GeoResearchError('ATTACHMENT_NOT_FOUND', `archive entry ${requestedPath} does not exist`))
      })
      zip.readEntry()
    })
  } finally {
    zip.close()
  }
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
      if (error !== null) reject(error)
      else if (zip === undefined) reject(new GeoResearchError('ATTACHMENT_UPLOAD_INCOMPLETE', 'ZIP parser returned no archive'))
      else resolve(zip)
    })
  })
}

function scanZip(zip: yauzl.ZipFile, limits: ArchiveSafetyLimits): Promise<SafeArchiveEntry[]> {
  return new Promise((resolve, reject) => {
    const entries: SafeArchiveEntry[] = []
    const paths = new Set<string>()
    let total = 0
    let settled = false
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    zip.on('error', fail)
    zip.on('entry', (entry) => {
      try {
        if (entries.length >= limits.maxEntries) throw unsafe(`archive exceeds ${limits.maxEntries} entries`)
        const normalized = validateArchivePath(entry.fileName, limits)
        const safe = validateZipEntry(entry, normalized, limits)
        if (paths.has(normalized)) throw unsafe(`archive contains duplicate entry ${normalized}`)
        paths.add(normalized)
        total += safe.size
        if (total > limits.maxExpandedBytes) throw unsafe(`archive expands beyond ${limits.maxExpandedBytes} bytes`)
        entries.push(safe)
        zip.readEntry()
      } catch (error) {
        fail(error)
      }
    })
    zip.on('end', () => {
      if (settled) return
      settled = true
      resolve(entries)
    })
    zip.readEntry()
  })
}

function validateZipEntry(entry: yauzl.Entry, path: string, limits: ArchiveSafetyLimits): SafeArchiveEntry {
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw unsafe(`encrypted ZIP entry is not readable: ${path}`)
  const directory = entry.fileName.endsWith('/') || (entry.externalFileAttributes & 0x10) !== 0
  const unixMode = (entry.externalFileAttributes >>> 16) & 0xffff
  const unixType = unixMode & 0o170000
  if (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000) {
    throw unsafe(`ZIP entry is a link, device, or special file: ${path}`)
  }
  if (entry.uncompressedSize > limits.maxEntryBytes) throw unsafe(`archive entry exceeds ${limits.maxEntryBytes} bytes: ${path}`)
  if (!directory && entry.uncompressedSize > 0) {
    if (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > limits.maxCompressionRatio) {
      throw unsafe(`archive entry compression ratio is excessive: ${path}`)
    }
  }
  return {
    path,
    type: directory ? 'directory' : 'file',
    size: entry.uncompressedSize,
    compressedSize: entry.compressedSize,
  }
}

async function listTar(
  path: string,
  format: 'tar' | 'tar.gz',
  limit: number,
  limits: ArchiveSafetyLimits,
): Promise<SafeArchiveListing> {
  const entries: SafeArchiveEntry[] = []
  const paths = new Set<string>()
  let total = 0
  let failure: Error | undefined
  const extract = tar.extract()
  const abort = (error: unknown): void => {
    failure ??= asError(error)
    extract.destroy()
  }
  extract.on('entry', (header, stream, next) => {
    try {
      if (entries.length >= limits.maxEntries) throw unsafe(`archive exceeds ${limits.maxEntries} entries`)
      const entry = validateTarEntry(header, limits)
      if (paths.has(entry.path)) throw unsafe(`archive contains duplicate entry ${entry.path}`)
      paths.add(entry.path)
      total += entry.size
      if (total > limits.maxExpandedBytes) throw unsafe(`archive expands beyond ${limits.maxExpandedBytes} bytes`)
      entries.push(entry)
      stream.on('error', abort)
      stream.on('end', next)
      stream.resume()
    } catch (error) {
      stream.resume()
      abort(error)
    }
  })
  try {
    await pipeTar(path, format, extract)
  } catch (error) {
    if (failure !== undefined) throw failure
    throw error
  }
  if (failure !== undefined) throw failure
  if (format === 'tar.gz') assertOverallRatio(total, (await stat(path)).size, limits)
  return listing(format, entries, limit)
}

async function readTarEntry(
  path: string,
  format: 'tar' | 'tar.gz',
  requestedPath: string,
  maxBytes: number,
  limits: ArchiveSafetyLimits,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > limits.maxEntryBytes) throw new TypeError('archive read maxBytes is invalid')
  const paths = new Set<string>()
  let total = 0
  let found: Uint8Array | undefined
  let failure: Error | undefined
  const extract = tar.extract()
  const abort = (error: unknown): void => {
    failure ??= asError(error)
    extract.destroy()
  }
  extract.on('entry', (header, stream, next) => {
    try {
      if (paths.size >= limits.maxEntries) throw unsafe(`archive exceeds ${limits.maxEntries} entries`)
      const entry = validateTarEntry(header, limits)
      if (paths.has(entry.path)) throw unsafe(`archive contains duplicate entry ${entry.path}`)
      paths.add(entry.path)
      total += entry.size
      if (total > limits.maxExpandedBytes) throw unsafe(`archive expands beyond ${limits.maxExpandedBytes} bytes`)
      if (entry.path !== requestedPath) {
        stream.on('error', abort)
        stream.on('end', next)
        stream.resume()
        return
      }
      if (entry.type !== 'file') throw new GeoResearchError('ATTACHMENT_MEDIA_UNREADABLE', `archive entry ${requestedPath} is not a file`)
      if (entry.size > maxBytes) throw new GeoResearchError('ATTACHMENT_TOO_LARGE', `archive entry ${requestedPath} exceeds the ${maxBytes}-byte read limit`)
      void readBounded(stream, maxBytes).then((bytes) => {
        found = bytes
        next()
      }, abort)
    } catch (error) {
      stream.resume()
      abort(error)
    }
  })
  try {
    await pipeTar(path, format, extract)
  } catch (error) {
    if (failure !== undefined) throw failure
    throw error
  }
  if (failure !== undefined) throw failure
  if (format === 'tar.gz') assertOverallRatio(total, (await stat(path)).size, limits)
  if (found === undefined) throw new GeoResearchError('ATTACHMENT_NOT_FOUND', `archive entry ${requestedPath} does not exist`)
  return found
}

function validateTarEntry(header: tar.Headers, limits: ArchiveSafetyLimits): SafeArchiveEntry {
  const path = validateArchivePath(header.name, limits)
  const type = header.type ?? 'file'
  if (type !== 'file' && type !== 'directory') throw unsafe(`TAR entry is a link, device, or special file: ${path}`)
  const size = header.size ?? 0
  if (!Number.isSafeInteger(size) || size < 0 || size > limits.maxEntryBytes) {
    throw unsafe(`archive entry size is invalid or excessive: ${path}`)
  }
  return { path, type, size }
}

async function pipeTar(path: string, format: 'tar' | 'tar.gz', extract: tar.Extract): Promise<void> {
  if (format === 'tar.gz') await pipeline(createReadStream(path), createGunzip(), extract)
  else await pipeline(createReadStream(path), extract)
}

async function readBounded(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream as AsyncIterable<Uint8Array>) {
    const bytes = Buffer.from(chunk)
    total += bytes.byteLength
    if (total > maxBytes) throw new GeoResearchError('ATTACHMENT_TOO_LARGE', `archive entry exceeds the ${maxBytes}-byte read limit`)
    chunks.push(bytes)
  }
  return Buffer.concat(chunks, total)
}

function listing(
  format: AttachmentArchiveFormat,
  entries: readonly SafeArchiveEntry[],
  limit: number,
): SafeArchiveListing {
  return {
    format,
    entries: entries.slice(0, limit),
    totalEntries: entries.length,
    totalExpandedBytes: entries.reduce((sum, entry) => sum + entry.size, 0),
    truncated: entries.length > limit,
  }
}

function assertOverallRatio(expanded: number, compressed: number, limits: ArchiveSafetyLimits): void {
  if (expanded === 0) return
  if (compressed <= 0 || expanded / compressed > limits.maxCompressionRatio) {
    throw unsafe('archive compression ratio is excessive')
  }
}

function unsafe(message: string): GeoResearchError {
  return new GeoResearchError('ATTACHMENT_ARCHIVE_UNSAFE', message)
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
