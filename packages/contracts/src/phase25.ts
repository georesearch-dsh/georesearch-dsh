import type { Sha256Digest } from './index.js'

export const GENERIC_ATTACHMENT_SCHEMA_VERSION = 1 as const

export const GENERIC_ATTACHMENT_LIMITS = Object.freeze({
  maxFilesPerBatch: 32,
  maxFileBytes: 256 * 1024 * 1024,
  maxBatchBytes: 512 * 1024 * 1024,
  sniffBytes: 8 * 1024,
  maxDirectReadBytes: 512 * 1024,
  maxArchiveEntries: 10_000,
  maxArchiveExpandedBytes: 512 * 1024 * 1024,
  maxArchiveEntryBytes: 128 * 1024 * 1024,
  maxArchiveCompressionRatio: 100,
  maxArchivePathBytes: 1_024,
  maxArchivePathDepth: 32,
} as const)

export type AttachmentContentKind =
  | 'text'
  | 'image'
  | 'archive'
  | 'document'
  | 'data'
  | 'binary'

export type AttachmentReadStrategy =
  | 'direct-text'
  | 'document'
  | 'data'
  | 'image'
  | 'archive'
  | 'provider-required'
  | 'metadata-only'

export const READABLE_ATTACHMENT_STRATEGIES = [
  'direct-text',
  'document',
  'data',
  'image',
  'archive',
] as const satisfies readonly AttachmentReadStrategy[]

export type AttachmentArchiveFormat =
  | 'zip'
  | 'tar'
  | 'tar.gz'
  | 'tar.bz2'
  | 'tar.xz'
  | '7z'
  | 'rar'

export const INSPECTABLE_ATTACHMENT_ARCHIVE_FORMATS = [
  'zip',
  'tar',
  'tar.gz',
] as const satisfies readonly AttachmentArchiveFormat[]

export const RECOGNIZED_ATTACHMENT_ARCHIVE_FORMATS = [
  ...INSPECTABLE_ATTACHMENT_ARCHIVE_FORMATS,
  'tar.bz2',
  'tar.xz',
  '7z',
  'rar',
] as const satisfies readonly AttachmentArchiveFormat[]

export const STORED_ATTACHMENT_ARCHIVE_FORMATS = [
  ...INSPECTABLE_ATTACHMENT_ARCHIVE_FORMATS,
] as const satisfies readonly AttachmentArchiveFormat[]

export interface AttachmentParserProvenance {
  readonly detector: 'georesearch.magic/v1'
  readonly evidence: 'magic' | 'magic+name' | 'text-sniff' | 'unknown'
  readonly archiveParser?: 'yauzl' | 'tar-stream' | 'unsupported'
  readonly contentParser?:
    | 'text'
    | 'pdfjs'
    | 'openxml'
    | 'opendocument'
    | 'epub'
    | 'jupyter'
    | 'sqlite'
    | 'legacy-doc'
    | 'legacy-xls'
    | 'legacy-ppt'
    | 'hdf5'
    | 'netcdf'
    | 'parquet'
    | 'tiff'
    | 'bmp'
    | 'image'
    | 'archive'
    | 'unsupported'
}

export interface GenericAttachmentRef {
  readonly schemaVersion: 1
  readonly attachmentId: string
  readonly artifactId: string
  readonly digest: Sha256Digest
  readonly name: string
  readonly size: number
  readonly mediaType: string
  readonly contentKind: AttachmentContentKind
  readonly readStrategy: AttachmentReadStrategy
}

export interface IngestedFileRecord extends GenericAttachmentRef {
  readonly projectId: string
  readonly workspaceId: string
  readonly sessionId: string
  readonly agentId: string
  readonly browserMediaType?: string
  readonly extension?: string
  readonly archive?: {
    readonly format: AttachmentArchiveFormat
    readonly supported: boolean
  }
  readonly parserProvenance: AttachmentParserProvenance
  readonly uploadedAt: string
}
