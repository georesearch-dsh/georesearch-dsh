import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import Check from 'lucide-react/dist/esm/icons/check.js'
import Copy from 'lucide-react/dist/esm/icons/copy.js'
import Database from 'lucide-react/dist/esm/icons/database.js'
import File from 'lucide-react/dist/esm/icons/file.js'
import FileArchive from 'lucide-react/dist/esm/icons/file-archive.js'
import FileAudio from 'lucide-react/dist/esm/icons/file-audio.js'
import FileCode from 'lucide-react/dist/esm/icons/file-code.js'
import FileImage from 'lucide-react/dist/esm/icons/file-image.js'
import FileSpreadsheet from 'lucide-react/dist/esm/icons/file-spreadsheet.js'
import FileText from 'lucide-react/dist/esm/icons/file-text.js'
import FileVideo from 'lucide-react/dist/esm/icons/file-video.js'
import {
  ImageGallery,
  JsonBlock,
  MessageText,
  Tooltip,
  writeClipboard,
  type ChatNodeViewProps,
  type ImageAttachmentRef,
  type ImageLoader,
  type MessageImageLabels,
} from '@georesearch/dsh-compat-rc5/client'

const FILE_TAG = /<georesearch-file\b([^<>]*?)\/>/gu
const FILE_ATTRIBUTE = /([a-z][a-z0-9-]*)="([^"]*)"/gu
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const COMPOUND_EXTENSIONS = ['tar.gz', 'tar.bz2', 'tar.xz'] as const

export interface AttachmentDisplayMetadata {
  readonly attachmentId: string
  readonly name: string
  readonly mediaType: string
  readonly contentKind: string
}

export interface GeoResearchFileReference {
  readonly attachmentId: string
  readonly name?: string
  readonly mediaType?: string
}

export interface GeoResearchMessageProjection {
  readonly text: string
  readonly files: readonly GeoResearchFileReference[]
}

interface MessageRendererInjected {
  readonly resolveAttachment: (attachmentId: string, signal: AbortSignal) => Promise<AttachmentDisplayMetadata>
}

type UserImage = { readonly type: 'image'; readonly attachment: ImageAttachmentRef }

const IMAGE_LABELS: MessageImageLabels = {
  image: '图片',
  open: '查看原图',
  openNamed: name => `查看原图 ${name}`,
  loading: '加载中',
  loadFailed: '图片加载失败，点击重试',
  lightbox: { dialog: '原图预览', close: '关闭原图' },
}

/** Parse GeoResearch reference tags into display metadata and remove their model-only XML from visible text. */
export function projectGeoResearchMessage(text: string): GeoResearchMessageProjection {
  const files: GeoResearchFileReference[] = []
  let visible = ''
  let cursor = 0
  for (const match of text.matchAll(FILE_TAG)) {
    const raw = match[0]
    const attributes = attributesOf(match[1] ?? '')
    const attachmentId = attributes.get('attachment-id')
    if (attachmentId === undefined || !UUID.test(attachmentId)) continue
    visible += text.slice(cursor, match.index)
    cursor = (match.index ?? 0) + raw.length
    const name = attributes.get('name')
    const mediaType = attributes.get('media-type')
    files.push({
      attachmentId,
      ...(name === undefined ? {} : { name }),
      ...(mediaType === undefined ? {} : { mediaType }),
    })
  }
  visible += text.slice(cursor)
  return { text: visible.replaceAll('\uFFFC', '').trim(), files }
}

/** Return the concise format label shown on a historical attachment card. */
export function attachmentFormat(name: string | undefined, mediaType: string | undefined): string {
  const lower = name?.toLowerCase() ?? ''
  for (const compound of COMPOUND_EXTENSIONS) {
    if (lower.endsWith(`.${compound}`)) return compound.toUpperCase()
  }
  const dot = lower.lastIndexOf('.')
  if (dot >= 0 && lower.length - dot <= 11) {
    const extension = lower.slice(dot + 1)
    if (/^[a-z0-9]+$/u.test(extension)) return extension.toUpperCase()
  }
  const subtype = mediaType?.split('/')[1]?.split(/[;+]/u)[0]
  return subtype === undefined || subtype === '' ? 'FILE' : subtype.toUpperCase()
}

function attributesOf(source: string): Map<string, string> {
  const attributes = new Map<string, string>()
  for (const match of source.matchAll(FILE_ATTRIBUTE)) {
    const name = match[1]
    const value = match[2]
    if (name !== undefined && value !== undefined) attributes.set(name, decodeXml(value))
  }
  return attributes
}

function decodeXml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function messageParts(content: readonly unknown[]): {
  readonly text: string
  readonly images: readonly { readonly attachment: ImageAttachmentRef }[]
  readonly rest: readonly unknown[]
} {
  const texts: string[] = []
  const images: { attachment: ImageAttachmentRef }[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const candidate = block as { readonly type?: string; readonly text?: string; readonly attachment?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') texts.push(candidate.text)
    else if (candidate.type === 'image' && candidate.attachment !== undefined) {
      images.push({ attachment: (candidate as UserImage).attachment })
    } else rest.push(block)
  }
  return { text: texts.join(''), images, rest }
}

function fileTone(name: string | undefined, mediaType: string | undefined): string {
  const format = attachmentFormat(name, mediaType).toLowerCase()
  if (format === 'pdf') return 'pdf'
  if (['zip', 'tar', 'tar.gz', 'tar.bz2', 'tar.xz', '7z', 'rar', 'gz', 'bz2', 'xz'].includes(format)) return 'archive'
  if (mediaType?.startsWith('image/') === true) return 'image'
  if (mediaType?.startsWith('audio/') === true || mediaType?.startsWith('video/') === true) return 'media'
  if (['csv', 'xls', 'xlsx', 'sqlite', 'db', 'h5', 'hdf5', 'nc', 'netcdf', 'parquet'].includes(format)) return 'data'
  if ([
    'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'astro',
    'py', 'pyi', 'pyx', 'r', 'jl', 'm', 'sas', 'do', 'ado', 'c', 'h', 'cc', 'cpp',
    'cxx', 'hh', 'hpp', 'hxx', 'cs', 'java', 'kt', 'kts', 'go', 'rs', 'swift', 'mm',
    'php', 'rb', 'pl', 'pm', 'lua', 'dart', 'scala', 'sc', 'groovy', 'gradle', 'sol',
    'f', 'for', 'f77', 'f90', 'f95', 'f03', 'f08', 'v', 'vh', 'sv', 'svh', 'vhd',
    'vhdl', 'asm', 's', 'cu', 'cuh', 'cl', 'fs', 'fsx', 'fsi', 'ex', 'exs', 'erl',
    'hrl', 'clj', 'cljs', 'cljc', 'edn', 'hs', 'lhs', 'ml', 'mli', 'nim', 'zig',
    'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'sql', 'graphql', 'gql',
    'proto', 'wat', 'cmake', 'html', 'css', 'scss', 'sass', 'less', 'json', 'json5',
    'geojson', 'xml', 'yaml', 'yml', 'toml', 'ipynb', 'tex', 'bib', 'ris',
  ].includes(format)) return 'code'
  return 'document'
}

function iconFor(tone: string): typeof File {
  switch (tone) {
    case 'archive': return FileArchive
    case 'data': return Database
    case 'image': return FileImage
    case 'media': return FileAudio
    case 'code': return FileCode
    case 'pdf':
    case 'document': return FileText
    case 'spreadsheet': return FileSpreadsheet
    case 'video': return FileVideo
    default: return File
  }
}

function AttachmentChip({ reference, resolveAttachment }: {
  readonly reference: GeoResearchFileReference
  readonly resolveAttachment: MessageRendererInjected['resolveAttachment']
}): ReactNode {
  const embedded = useMemo<AttachmentDisplayMetadata | undefined>(() => reference.name === undefined
    ? undefined
    : {
        attachmentId: reference.attachmentId,
        name: reference.name,
        mediaType: reference.mediaType ?? 'application/octet-stream',
        contentKind: 'file',
      }, [reference.attachmentId, reference.mediaType, reference.name])
  const [resolved, setResolved] = useState<AttachmentDisplayMetadata | null | undefined>(embedded)
  useEffect(() => {
    if (embedded !== undefined) {
      setResolved(embedded)
      return
    }
    const controller = new AbortController()
    setResolved(undefined)
    void resolveAttachment(reference.attachmentId, controller.signal).then(
      value => { if (!controller.signal.aborted) setResolved(value) },
      () => { if (!controller.signal.aborted) setResolved(null) },
    )
    return () => { controller.abort() }
  }, [embedded, reference.attachmentId, resolveAttachment])
  const name = resolved === undefined
    ? '正在读取附件'
    : resolved === null
      ? '附件不可用'
      : resolved.name
  const mediaType = resolved === undefined || resolved === null ? reference.mediaType : resolved.mediaType
  const format = attachmentFormat(name, mediaType)
  const tone = fileTone(name, mediaType)
  const Icon = iconFor(tone)
  return (
    <div className="georesearch-message-file" data-tone={tone} title={resolved?.name ?? reference.attachmentId}>
      <span className="georesearch-message-file-icon" aria-hidden="true"><Icon size={18} strokeWidth={1.8} /></span>
      <span className="georesearch-message-file-name">{name}</span>
      <span className="georesearch-message-file-format">{format}</span>
    </div>
  )
}

function CopyAction({ text }: { readonly text: string }): ReactNode {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
  }, [])
  const copy = (): void => {
    if (copied) return
    void writeClipboard(text).then(ok => {
      if (!ok) return
      setCopied(true)
      if (timer.current !== undefined) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => { setCopied(false) }, 1_000)
    })
  }
  return (
    <Tooltip label={copied ? '已复制' : '复制'} side="bottom">
      <button type="button" className="georesearch-message-copy" aria-label={copied ? '已复制' : '复制'} onClick={copy}>
        {copied ? <Check size={15} /> : <Copy size={15} />}
      </button>
    </Tooltip>
  )
}

function GeoResearchMessage({ content, time, loadImage, resolveAttachment, pending = false }: {
  readonly content: readonly unknown[]
  readonly time: number
  readonly loadImage: ImageLoader
  readonly resolveAttachment: MessageRendererInjected['resolveAttachment']
  readonly pending?: boolean
}): ReactNode {
  const { text, images, rest } = messageParts(content)
  const projection = useMemo(() => projectGeoResearchMessage(text), [text])
  const visibleText = projection.text
  const copyText = [visibleText, ...projection.files.map(file => file.name ?? `[附件 ${file.attachmentId}]`)]
    .filter(value => value !== '')
    .join('\n')
  const showBubble = visibleText !== '' || rest.length > 0
  return (
    <div className="georesearch-message-row" data-pending-steering={pending || undefined} data-time-hover-root>
      <div className="georesearch-message-stack">
        <ImageGallery images={images} load={loadImage} align="end" labels={IMAGE_LABELS} />
        {projection.files.length > 0 && (
          <div className="georesearch-message-files">
            {projection.files.map((file, index) => (
              <AttachmentChip key={`${file.attachmentId}:${index}`} reference={file} resolveAttachment={resolveAttachment} />
            ))}
          </div>
        )}
        {showBubble && (
          <div className="georesearch-message-bubble">
            {visibleText !== '' && <MessageText text={visibleText} />}
            {rest.map((block, index) => (
              <JsonBlock key={index} label="附加内容" payload={block} truncatedLabel={total => `已截断，共 ${total} 项`} />
            ))}
          </div>
        )}
      </div>
      <div className="georesearch-message-actions">
        {!pending && <span className="georesearch-message-time">{new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
        <CopyAction text={copyText} />
      </div>
    </div>
  )
}

export const GeoResearchUserMessageView = memo(function GeoResearchUserMessageView({
  node, loadImage, resolveAttachment,
}: ChatNodeViewProps<'user'> & MessageRendererInjected) {
  return (
    <GeoResearchMessage
      content={node.data.content}
      time={node.data.time}
      loadImage={loadImage}
      resolveAttachment={resolveAttachment}
    />
  )
})

export const GeoResearchSteeringMessageView = memo(function GeoResearchSteeringMessageView({
  node, loadImage, resolveAttachment,
}: ChatNodeViewProps<'steering'> & MessageRendererInjected) {
  return (
    <GeoResearchMessage
      content={node.data.content}
      time={node.data.time}
      loadImage={loadImage}
      resolveAttachment={resolveAttachment}
      pending={false}
    />
  )
})
