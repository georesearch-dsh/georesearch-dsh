import { extname } from 'node:path'
import {
  READABLE_ATTACHMENT_STRATEGIES,
  type AttachmentArchiveFormat,
  type AttachmentContentKind,
  type AttachmentParserProvenance,
  type AttachmentReadStrategy,
} from '@georesearch/dsh-contracts'

type ContentParser = NonNullable<AttachmentParserProvenance['contentParser']>

interface ZipDocumentType {
  readonly mediaType: string
  readonly parser: 'openxml' | 'opendocument' | 'epub'
}

interface LegacyOfficeType {
  readonly mediaType: string
  readonly parser: 'legacy-doc' | 'legacy-xls' | 'legacy-ppt'
}

const READABLE_STRATEGIES = new Set<AttachmentReadStrategy>(READABLE_ATTACHMENT_STRATEGIES)

export function isReadableAttachmentType(value: Pick<DetectedFileType, 'readStrategy'>): boolean {
  return READABLE_STRATEGIES.has(value.readStrategy)
}

export interface DetectedFileType {
  readonly mediaType: string
  readonly contentKind: AttachmentContentKind
  readonly readStrategy: AttachmentReadStrategy
  readonly extension?: string
  readonly archive?: {
    readonly format: AttachmentArchiveFormat
    readonly supported: boolean
  }
  readonly parserProvenance: AttachmentParserProvenance
}

const TEXT_MEDIA_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.mdx': 'text/markdown',
  '.rst': 'text/x-rst',
  '.adoc': 'text/asciidoc',
  '.org': 'text/org',
  '.qmd': 'text/markdown',
  '.rmd': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.topojson': 'application/json',
  '.json5': 'application/json5',
  '.jsonl': 'application/x-ndjson',
  '.ndjson': 'application/x-ndjson',
  '.xml': 'application/xml',
  '.kml': 'application/vnd.google-earth.kml+xml',
  '.gpx': 'application/gpx+xml',
  '.svg': 'image/svg+xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xhtml': 'application/xhtml+xml',
  '.css': 'text/css',
  '.scss': 'text/x-scss',
  '.sass': 'text/x-sass',
  '.less': 'text/x-less',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.jsx': 'text/javascript',
  '.ts': 'text/typescript',
  '.mts': 'text/typescript',
  '.cts': 'text/typescript',
  '.tsx': 'text/typescript',
  '.vue': 'text/x-vue',
  '.svelte': 'text/x-svelte',
  '.astro': 'text/x-astro',
  '.py': 'text/x-python',
  '.pyi': 'text/x-python',
  '.pyx': 'text/x-cython',
  '.r': 'text/x-r',
  '.jl': 'text/x-julia',
  '.m': 'text/x-matlab',
  '.sas': 'text/x-sas',
  '.do': 'text/x-stata',
  '.ado': 'text/x-stata',
  '.c': 'text/x-c',
  '.h': 'text/x-c',
  '.cc': 'text/x-c++',
  '.cpp': 'text/x-c++',
  '.cxx': 'text/x-c++',
  '.hh': 'text/x-c++',
  '.hpp': 'text/x-c++',
  '.hxx': 'text/x-c++',
  '.cs': 'text/x-csharp',
  '.java': 'text/x-java-source',
  '.kt': 'text/x-kotlin',
  '.kts': 'text/x-kotlin',
  '.go': 'text/x-go',
  '.rs': 'text/x-rust',
  '.swift': 'text/x-swift',
  '.mm': 'text/x-objective-c++',
  '.php': 'text/x-php',
  '.rb': 'text/x-ruby',
  '.pl': 'text/x-perl',
  '.pm': 'text/x-perl',
  '.lua': 'text/x-lua',
  '.dart': 'text/x-dart',
  '.scala': 'text/x-scala',
  '.sc': 'text/x-scala',
  '.groovy': 'text/x-groovy',
  '.gradle': 'text/x-groovy',
  '.sol': 'text/x-solidity',
  '.f': 'text/x-fortran',
  '.for': 'text/x-fortran',
  '.f77': 'text/x-fortran',
  '.f90': 'text/x-fortran',
  '.f95': 'text/x-fortran',
  '.f03': 'text/x-fortran',
  '.f08': 'text/x-fortran',
  '.v': 'text/x-verilog',
  '.vh': 'text/x-verilog',
  '.sv': 'text/x-systemverilog',
  '.svh': 'text/x-systemverilog',
  '.vhd': 'text/x-vhdl',
  '.vhdl': 'text/x-vhdl',
  '.asm': 'text/x-asm',
  '.s': 'text/x-asm',
  '.cu': 'text/x-cuda',
  '.cuh': 'text/x-cuda',
  '.cl': 'text/x-opencl',
  '.fs': 'text/x-fsharp',
  '.fsx': 'text/x-fsharp',
  '.fsi': 'text/x-fsharp',
  '.ex': 'text/x-elixir',
  '.exs': 'text/x-elixir',
  '.erl': 'text/x-erlang',
  '.hrl': 'text/x-erlang',
  '.clj': 'text/x-clojure',
  '.cljs': 'text/x-clojure',
  '.cljc': 'text/x-clojure',
  '.edn': 'application/edn',
  '.hs': 'text/x-haskell',
  '.lhs': 'text/x-haskell',
  '.ml': 'text/x-ocaml',
  '.mli': 'text/x-ocaml',
  '.nim': 'text/x-nim',
  '.zig': 'text/x-zig',
  '.sh': 'text/x-shellscript',
  '.bash': 'text/x-shellscript',
  '.zsh': 'text/x-shellscript',
  '.fish': 'text/x-shellscript',
  '.ps1': 'text/x-powershell',
  '.bat': 'text/x-batch',
  '.cmd': 'text/x-batch',
  '.sql': 'application/sql',
  '.graphql': 'application/graphql',
  '.gql': 'application/graphql',
  '.proto': 'text/x-protobuf',
  '.wat': 'text/x-webassembly',
  '.cmake': 'text/x-cmake',
  '.toml': 'application/toml',
  '.ini': 'text/plain',
  '.cfg': 'text/plain',
  '.conf': 'text/plain',
  '.env': 'text/plain',
  '.properties': 'text/plain',
  '.lock': 'text/plain',
  '.log': 'text/plain',
  '.tex': 'application/x-tex',
  '.sty': 'application/x-tex',
  '.cls': 'application/x-tex',
  '.bib': 'application/x-bibtex',
  '.ris': 'application/x-research-info-systems',
  '.wkt': 'text/plain',
  '.prj': 'text/plain',
}

const TEXT_MEDIA_BY_BASENAME: Readonly<Record<string, string>> = {
  dockerfile: 'text/x-dockerfile',
  makefile: 'text/x-makefile',
  gnumakefile: 'text/x-makefile',
  'cmakelists.txt': 'text/x-cmake',
  jenkinsfile: 'text/x-groovy',
  vagrantfile: 'text/x-ruby',
  gemfile: 'text/x-ruby',
  rakefile: 'text/x-ruby',
}

export function normalizeUploadName(value: string): string {
  const normalized = value.normalize('NFC').replace(/[\u0000-\u001f\u007f]/gu, '')
  const name = normalized.replaceAll('\\', '/').split('/').at(-1)?.trim() ?? ''
  if (name.length === 0 || name === '.' || name === '..') throw new TypeError('uploaded file name is empty or unsafe')
  if (Buffer.byteLength(name, 'utf8') > 255) throw new TypeError('uploaded file name exceeds 255 UTF-8 bytes')
  return name
}

export function normalizedExtension(name: string): string | undefined {
  const lower = name.toLowerCase()
  if (lower.endsWith('.tar.gz')) return '.tar.gz'
  if (lower.endsWith('.tar.bz2')) return '.tar.bz2'
  if (lower.endsWith('.tar.xz')) return '.tar.xz'
  const extension = extname(lower)
  return extension === '' ? undefined : extension
}

export function detectFileType(head: Uint8Array, name: string): DetectedFileType {
  const bytes = Buffer.from(head)
  const extension = normalizedExtension(name)
  const magic = (
    mediaType: string,
    contentKind: AttachmentContentKind,
    readStrategy: AttachmentReadStrategy,
    contentParser: ContentParser,
  ): DetectedFileType => ({
    mediaType,
    contentKind,
    readStrategy,
    ...(extension === undefined ? {} : { extension }),
    parserProvenance: { detector: 'georesearch.magic/v1', evidence: 'magic', contentParser },
  })
  const archive = (
    format: AttachmentArchiveFormat,
    supported: boolean,
    mediaType: string,
    evidence: AttachmentParserProvenance['evidence'] = 'magic',
  ): DetectedFileType => ({
    mediaType,
    contentKind: 'archive',
    readStrategy: supported ? 'archive' : 'metadata-only',
    ...(extension === undefined ? {} : { extension }),
    archive: { format, supported },
    parserProvenance: {
      detector: 'georesearch.magic/v1',
      evidence,
      archiveParser: format === 'zip' ? 'yauzl' : format === 'tar' || format === 'tar.gz' ? 'tar-stream' : 'unsupported',
      contentParser: supported ? 'archive' : 'unsupported',
    },
  })

  if (starts(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return magic('image/png', 'image', 'image', 'image')
  if (starts(bytes, [0xff, 0xd8, 0xff])) return magic('image/jpeg', 'image', 'image', 'image')
  if (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a') return magic('image/gif', 'image', 'image', 'image')
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return magic('image/webp', 'image', 'image', 'image')
  if (starts(bytes, [0x49, 0x49, 0x2a, 0x00]) || starts(bytes, [0x4d, 0x4d, 0x00, 0x2a])) return magic('image/tiff', 'image', 'image', 'tiff')
  if (ascii(bytes, 0, 2) === 'BM') return magic('image/bmp', 'image', 'image', 'bmp')
  if (ascii(bytes, 0, 5) === '%PDF-') return magic('application/pdf', 'document', 'document', 'pdfjs')

  if (starts(bytes, [0x50, 0x4b, 0x03, 0x04]) || starts(bytes, [0x50, 0x4b, 0x05, 0x06])
    || starts(bytes, [0x50, 0x4b, 0x07, 0x08])) {
    const office = officeZipType(extension)
    if (office !== undefined) {
      return {
        mediaType: office.mediaType,
        contentKind: 'document',
        readStrategy: 'document',
        ...(extension === undefined ? {} : { extension }),
        archive: { format: 'zip', supported: true },
        parserProvenance: {
          detector: 'georesearch.magic/v1',
          evidence: 'magic+name',
          archiveParser: 'yauzl',
          contentParser: office.parser,
        },
      }
    }
    return archive('zip', true, 'application/zip')
  }
  if (isTar(bytes)) return archive('tar', true, 'application/x-tar')
  if (starts(bytes, [0x1f, 0x8b])) {
    if (extension === '.tgz' || extension === '.tar.gz') return archive('tar.gz', true, 'application/gzip', 'magic+name')
    return magic('application/gzip', 'archive', 'metadata-only', 'unsupported')
  }
  if (ascii(bytes, 0, 3) === 'BZh') {
    if (extension === '.tbz' || extension === '.tbz2' || extension === '.tar.bz2') {
      return archive('tar.bz2', false, 'application/x-bzip2', 'magic+name')
    }
    return magic('application/x-bzip2', 'archive', 'metadata-only', 'unsupported')
  }
  if (starts(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) {
    if (extension === '.txz' || extension === '.tar.xz') return archive('tar.xz', false, 'application/x-xz', 'magic+name')
    return magic('application/x-xz', 'archive', 'metadata-only', 'unsupported')
  }
  if (starts(bytes, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return archive('7z', false, 'application/x-7z-compressed')
  if (starts(bytes, [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07])) return archive('rar', false, 'application/vnd.rar')

  if (starts(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) {
    const office = legacyOfficeType(extension)
    return office === undefined
      ? magic('application/x-ole-storage', 'binary', 'provider-required', 'unsupported')
      : magic(office.mediaType, 'document', 'document', office.parser)
  }
  if (ascii(bytes, 0, 16) === 'SQLite format 3\0') return magic('application/vnd.sqlite3', 'data', 'data', 'sqlite')
  if (starts(bytes, [0x89, 0x48, 0x44, 0x46, 0x0d, 0x0a, 0x1a, 0x0a])) return magic('application/x-hdf5', 'data', 'data', 'hdf5')
  if (ascii(bytes, 0, 3) === 'CDF' && [1, 2].includes(bytes[3] ?? -1)) return magic('application/x-netcdf', 'data', 'data', 'netcdf')
  if (ascii(bytes, 0, 3) === 'CDF' && bytes[3] === 5) return magic('application/x-netcdf-cdf5', 'data', 'provider-required', 'unsupported')
  if (ascii(bytes, 0, 4) === 'PAR1') return magic('application/vnd.apache.parquet', 'data', 'data', 'parquet')
  if (starts(bytes, [0x7f, 0x45, 0x4c, 0x46]) || ascii(bytes, 0, 2) === 'MZ') {
    return magic('application/x-executable', 'binary', 'metadata-only', 'unsupported')
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return magic('audio/wav', 'binary', 'metadata-only', 'unsupported')
  if (bytes.byteLength >= 12 && ascii(bytes, 4, 4) === 'ftyp') return magic('video/mp4', 'binary', 'metadata-only', 'unsupported')

  if (looksLikeText(bytes)) {
    if (extension === '.ipynb') {
      return {
        mediaType: 'application/x-ipynb+json',
        contentKind: 'document',
        readStrategy: 'document',
        extension,
        parserProvenance: { detector: 'georesearch.magic/v1', evidence: 'text-sniff', contentParser: 'jupyter' },
      }
    }
    return {
      mediaType: textMediaType(name, extension, bytes),
      contentKind: 'text',
      readStrategy: 'direct-text',
      ...(extension === undefined ? {} : { extension }),
      parserProvenance: { detector: 'georesearch.magic/v1', evidence: 'text-sniff', contentParser: 'text' },
    }
  }
  return {
    mediaType: 'application/octet-stream',
    contentKind: 'binary',
    readStrategy: 'metadata-only',
    ...(extension === undefined ? {} : { extension }),
    parserProvenance: { detector: 'georesearch.magic/v1', evidence: 'unknown', contentParser: 'unsupported' },
  }
}

export function decodeTextBytes(bytes: Uint8Array): { readonly encoding: string; readonly text: string } | undefined {
  const data = Buffer.from(bytes)
  if (data.byteLength >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    return { encoding: 'utf-16le', text: data.subarray(2).toString('utf16le') }
  }
  if (data.byteLength >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    const swapped = Buffer.allocUnsafe(data.byteLength - 2)
    for (let index = 2; index + 1 < data.byteLength; index += 2) {
      swapped[index - 2] = data[index + 1] as number
      swapped[index - 1] = data[index] as number
    }
    return { encoding: 'utf-16be', text: swapped.toString('utf16le') }
  }
  try {
    return { encoding: 'utf-8', text: new TextDecoder('utf-8', { fatal: true }).decode(data) }
  } catch {
    return undefined
  }
}

export function looksLikeText(bytes: Uint8Array): boolean {
  const data = Buffer.from(bytes)
  if (data.byteLength === 0) return true
  if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff)) return true
  if (data.includes(0)) return false
  const decoded = decodeTextBytes(data)
  if (decoded === undefined) return false
  let acceptable = 0
  for (const character of decoded.text) {
    const code = character.codePointAt(0) as number
    if (code === 9 || code === 10 || code === 13 || code >= 32) acceptable += 1
  }
  return decoded.text.length === 0 || acceptable / decoded.text.length >= 0.9
}

function inferStructuredText(bytes: Uint8Array): string {
  const text = decodeTextBytes(bytes)?.text.trimStart() ?? ''
  if (text.startsWith('{') || text.startsWith('[')) return 'application/json'
  if (text.startsWith('<?xml') || /^<[A-Za-z_:][^>]*>/u.test(text)) return 'application/xml'
  return 'text/plain'
}

function textMediaType(name: string, extension: string | undefined, bytes: Uint8Array): string {
  const byName = TEXT_MEDIA_BY_BASENAME[name.toLowerCase()]
  if (byName !== undefined) return byName
  return extension === undefined ? inferStructuredText(bytes) : (TEXT_MEDIA_BY_EXTENSION[extension] ?? inferStructuredText(bytes))
}

function officeZipType(extension: string | undefined): ZipDocumentType | undefined {
  switch (extension) {
    case '.docx': return { mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', parser: 'openxml' }
    case '.xlsx': return { mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', parser: 'openxml' }
    case '.pptx': return { mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', parser: 'openxml' }
    case '.odt': return { mediaType: 'application/vnd.oasis.opendocument.text', parser: 'opendocument' }
    case '.ods': return { mediaType: 'application/vnd.oasis.opendocument.spreadsheet', parser: 'opendocument' }
    case '.odp': return { mediaType: 'application/vnd.oasis.opendocument.presentation', parser: 'opendocument' }
    case '.epub': return { mediaType: 'application/epub+zip', parser: 'epub' }
    default: return undefined
  }
}

function legacyOfficeType(extension: string | undefined): LegacyOfficeType | undefined {
  switch (extension) {
    case '.doc': return { mediaType: 'application/msword', parser: 'legacy-doc' }
    case '.xls': return { mediaType: 'application/vnd.ms-excel', parser: 'legacy-xls' }
    case '.ppt': return { mediaType: 'application/vnd.ms-powerpoint', parser: 'legacy-ppt' }
    default: return undefined
  }
}

function isTar(bytes: Buffer): boolean {
  return bytes.byteLength >= 265 && (ascii(bytes, 257, 5) === 'ustar' || ascii(bytes, 257, 6) === 'ustar\0')
}

function starts(bytes: Buffer, signature: readonly number[]): boolean {
  return signature.every((value, index) => bytes[index] === value)
}

function ascii(bytes: Buffer, offset: number, length: number): string {
  if (bytes.byteLength < offset + length) return ''
  return bytes.subarray(offset, offset + length).toString('latin1')
}
