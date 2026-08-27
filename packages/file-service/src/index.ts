import { Service, type Context } from '@deepseek-ai/cordis'
import { open, readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { basename } from 'node:path'
import type {} from '@georesearch/dsh-installation-guard'
import type {} from '@georesearch/dsh-policy'
import type {} from '@georesearch/dsh-project-service'
import {
  GENERIC_ATTACHMENT_LIMITS,
  GeoResearchError,
  type AttachmentArchiveFormat,
  type GenericAttachmentRef,
  type IngestedFileRecord,
  type JsonValue,
} from '@georesearch/dsh-contracts'
import {
  registerTool,
  registerWebPrefix,
  resolveDshHome,
  liveAgentForSession,
  onAgentCreated,
  onAgentDisposed,
  sessionCwd,
  type Agent,
  type ContentBlock,
  type ImageAttachmentRef,
  type ImageMediaType,
  type ToolDefinition,
  type ToolExecution,
} from '@georesearch/dsh-compat-rc5'
import { listArchive, readArchiveEntry } from './archive.js'
import {
  readStructuredAttachment,
  STRUCTURED_READ_LIMITS,
  type StructuredImageContext,
} from './document.js'
import {
  decodeTextBytes,
  detectFileType,
  isReadableAttachmentType,
  normalizeUploadName,
  type DetectedFileType,
} from './media.js'
import { PDF_READ_LIMITS, readPdfDocument, type PdfDocumentRead } from './pdf.js'
import { assertAttachmentId, IngestedFileRecordStore } from './records.js'
import { readSpecialImage, readSpecialImageBytes, SPECIAL_IMAGE_LIMITS } from './special-image.js'
import {
  LocalImageOcr,
  OCR_LIMITS,
  type ImageTextAnalysis,
  type ImageTextAnalyzer,
} from './ocr.js'
import {
  DEEPSEEK_VISION_LIMITS,
  DeepSeekVisionAnalyzer,
  describeVisionFailure,
  type ImageUnderstandingAnalysis,
  type ImageUnderstandingAnalyzer,
  type ImageUnderstandingPurpose,
} from './vision.js'

export {
  DEEPSEEK_VISION_BASE_URL,
  DEEPSEEK_VISION_CREDENTIAL_REF,
  DEEPSEEK_VISION_LIMITS,
  DEEPSEEK_VISION_MODEL,
  DEEPSEEK_VISION_RELEASE_DATE,
  DeepSeekVisionAnalyzer,
  DeepSeekVisionError,
} from './vision.js'
export type {
  DeepSeekVisionAnalyzerOptions,
  DeepSeekVisionErrorCode,
  ImageUnderstandingAnalysis,
  ImageUnderstandingAnalyzer,
  ImageUnderstandingPurpose,
  ImageUnderstandingRequest,
  ImageUnderstandingUsage,
} from './vision.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    geoResearchFiles: GeoResearchFileService
  }
}

export const name = 'georesearch-file-service'
export const inject = [
  'geoResearchInstallation',
  'geoResearchPolicy',
  'geoResearchProjects',
  'credentials',
  'tools',
  'agents',
  'fs',
]
export const FILE_API_PATH = '/api/georesearch/files/v1'

export interface Config {
  readonly home?: string
  readonly maxFileBytes?: number
  readonly maxDirectReadBytes?: number
  readonly maxArchiveListEntries?: number
  readonly visionCredentialRef?: string
  readonly visionTimeoutMs?: number
  readonly visionMaxOutputTokens?: number
  readonly visionCacheMaxEntries?: number
}

interface WorkspaceFsTarget {
  readonly displayPath: string
}

interface WorkspaceFsInfo {
  readonly type: string
  readonly version: unknown
}

interface WorkspaceFsContext {
  readonly fs: {
    resolve(path: string, options: { readonly cwd: string; readonly signal: AbortSignal }): Promise<WorkspaceFsTarget>
    stat(target: WorkspaceFsTarget, signal: AbortSignal): Promise<WorkspaceFsInfo | undefined>
    readBytes(target: WorkspaceFsTarget, signal: AbortSignal, maxBytes: number): Promise<Uint8Array>
  }
  emit(
    event: 'fs/observed',
    target: WorkspaceFsTarget,
    observation: { readonly kind: 'absent' } | { readonly kind: 'present'; readonly version: unknown },
    actor: ToolExecution,
  ): void
}

interface ResolvedRecord {
  readonly record: IngestedFileRecord
  readonly path: string
}

interface UploadHeaders {
  readonly attachmentId: string
  readonly name: string
  readonly browserMediaType?: string
}

export class GeoResearchFileService extends Service {
  readonly records: IngestedFileRecordStore
  readonly maxFileBytes: number
  readonly maxDirectReadBytes: number
  readonly maxArchiveListEntries: number
  readonly imageTextAnalyzer: ImageTextAnalyzer
  readonly imageUnderstandingAnalyzer: ImageUnderstandingAnalyzer

  constructor(
    ctx: Context,
    config: Config,
    imageTextAnalyzer: ImageTextAnalyzer = new LocalImageOcr(),
    imageUnderstandingAnalyzer: ImageUnderstandingAnalyzer = defaultImageUnderstandingAnalyzer(ctx, config),
  ) {
    super(ctx, 'geoResearchFiles')
    this.maxFileBytes = boundedConfig(config.maxFileBytes, GENERIC_ATTACHMENT_LIMITS.maxFileBytes, 'maxFileBytes')
    this.maxDirectReadBytes = boundedConfig(
      config.maxDirectReadBytes,
      GENERIC_ATTACHMENT_LIMITS.maxDirectReadBytes,
      'maxDirectReadBytes',
    )
    this.maxArchiveListEntries = boundedConfig(config.maxArchiveListEntries, 1_000, 'maxArchiveListEntries')
    this.imageTextAnalyzer = imageTextAnalyzer
    this.imageUnderstandingAnalyzer = imageUnderstandingAnalyzer
    this.records = new IngestedFileRecordStore(resolveDshHome(config.home))
    ctx.effect(
      () => async () => await this.imageTextAnalyzer.dispose(),
      'georesearch-file-service: local image OCR',
    )
    ctx.effect(
      () => registerWebPrefix(ctx, FILE_API_PATH, (req, res) => this.handle(req, res)),
      'georesearch-file-service: optional upload route',
    )
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '', 'http://127.0.0.1')
      if (req.method === 'POST' && url.pathname === FILE_API_PATH) {
        await this.handleUpload(req, res)
        return
      }
      if (req.method === 'GET' && url.pathname.startsWith(`${FILE_API_PATH}/`)) {
        const attachmentId = url.pathname.slice(FILE_API_PATH.length + 1)
        const agent = this.agentForRequest(req)
        const resolved = await this.requireRecord(agent, attachmentId)
        responseJson(res, 200, publicReference(resolved.record))
        return
      }
      responseJson(res, req.method === 'GET' || req.method === 'POST' ? 404 : 405, {
        error: { code: 'ATTACHMENT_NOT_FOUND', message: 'file route not found' },
      })
    } catch (error) {
      const normalized = normalizeError(error)
      responseJson(res, statusFor(normalized.code), { error: normalized })
    }
  }

  async listForAgent(agent: Agent): Promise<IngestedFileRecord[]> {
    const resolved = await this.authorizeAgent(agent, false)
    const records = await this.records.list(resolved.projectId)
    const owned = records.filter(record => record.sessionId === String(agent.session.id)
      && record.agentId === String(agent.id)
      && record.workspaceId === resolved.workspaceId)
    const refreshed: IngestedFileRecord[] = []
    for (const record of owned) {
      refreshed.push(isReadableAttachmentType(record)
        ? record
        : (await this.requireRecord(agent, record.attachmentId)).record)
    }
    return refreshed
  }

  async requireRecord(agent: Agent, attachmentId: string): Promise<ResolvedRecord> {
    assertAttachmentId(attachmentId)
    const resolved = await this.authorizeAgent(agent, false)
    const record = await this.records.read(resolved.projectId, attachmentId)
    if (record === undefined) throw new GeoResearchError('ATTACHMENT_NOT_FOUND', `attachment ${attachmentId} does not exist`)
    if (record.projectId !== resolved.projectId || record.workspaceId !== resolved.workspaceId
      || record.sessionId !== String(agent.session.id) || record.agentId !== String(agent.id)) {
      throw new GeoResearchError('ATTACHMENT_SESSION_MISMATCH', `attachment ${attachmentId} is not bound to this live Agent session`)
    }
    const file = await this.ctx.geoResearchProjects.resolveArtifactFile(agent, record.artifactId)
    if (file.artifact.digest !== record.digest || file.artifact.size !== record.size
      || file.artifact.mediaType !== record.mediaType || file.workspaceId !== record.workspaceId) {
      throw new GeoResearchError('ARTIFACT_INTEGRITY_FAILURE', `attachment ${attachmentId} no longer matches its Artifact`)
    }
    return { record: await this.refreshLegacyClassification(record, file.path), path: file.path }
  }

  private async refreshLegacyClassification(record: IngestedFileRecord, path: string): Promise<IngestedFileRecord> {
    if (isReadableAttachmentType(record)) return record
    const length = Math.min(record.size, GENERIC_ATTACHMENT_LIMITS.sniffBytes)
    const head = Buffer.alloc(length)
    if (length > 0) {
      const handle = await open(path, 'r')
      try {
        const read = await handle.read(head, 0, length, 0)
        if (read.bytesRead !== length) {
          throw new GeoResearchError('ARTIFACT_INTEGRITY_FAILURE', `${record.attachmentId} ended before its recorded size`)
        }
      } finally {
        await handle.close()
      }
    }
    const detected = detectFileType(head, record.name)
    if (!isReadableAttachmentType(detected) || detected.mediaType !== record.mediaType) return record
    const replacement: IngestedFileRecord = {
      schemaVersion: record.schemaVersion,
      attachmentId: record.attachmentId,
      artifactId: record.artifactId,
      digest: record.digest,
      name: record.name,
      size: record.size,
      mediaType: record.mediaType,
      contentKind: detected.contentKind,
      readStrategy: detected.readStrategy,
      projectId: record.projectId,
      workspaceId: record.workspaceId,
      sessionId: record.sessionId,
      agentId: record.agentId,
      ...(record.browserMediaType === undefined ? {} : { browserMediaType: record.browserMediaType }),
      ...(detected.extension === undefined ? {} : { extension: detected.extension }),
      ...(detected.archive === undefined ? {} : { archive: detected.archive }),
      parserProvenance: detected.parserProvenance,
      uploadedAt: record.uploadedAt,
    }
    await this.records.replaceClassification(record, replacement)
    return replacement
  }

  private async handleUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const agent = this.agentForRequest(req)
    const owner = await this.authorizeAgent(agent, true)
    const headers = uploadHeaders(req)
    validateBatchHeaders(req)
    const declaredLength = contentLength(req)
    if (declaredLength !== undefined && declaredLength > this.maxFileBytes) {
      req.resume()
      throw new GeoResearchError('ATTACHMENT_TOO_LARGE', `uploaded file exceeds ${this.maxFileBytes} bytes`)
    }
    const existing = await this.records.read(owner.projectId, headers.attachmentId)
    if (existing !== undefined) {
      req.resume()
      const verified = await this.requireRecord(agent, headers.attachmentId)
      responseJson(res, 200, publicReference(verified.record))
      return
    }

    const abort = new AbortController()
    req.once('aborted', () => abort.abort(new GeoResearchError('ATTACHMENT_UPLOAD_INCOMPLETE', 'upload request was aborted')))
    const peeked = await peekStream(req, GENERIC_ATTACHMENT_LIMITS.sniffBytes)
    const detected = detectFileType(peeked.head, headers.name)
    if (!isReadableAttachmentType(detected)) {
      req.resume()
      throw new GeoResearchError(
        'ATTACHMENT_MEDIA_UNREADABLE',
        `${headers.name} is recognized as ${detected.mediaType}, but this installation has no approved content reader for it`,
      )
    }
    const readableLimit = this.readableUploadLimit(detected)
    if (declaredLength !== undefined && declaredLength > readableLimit) {
      req.resume()
      throw new GeoResearchError('ATTACHMENT_TOO_LARGE', `${headers.name} exceeds its ${readableLimit}-byte readable upload limit`)
    }
    const source = declaredLength === undefined ? peeked.source : exactLengthSource(peeked.source, declaredLength)
    const committed = await this.ctx.geoResearchProjects.commitUploadedArtifact(agent, {
      attachmentId: headers.attachmentId,
      source,
      maxBytes: readableLimit,
      mediaType: detected.mediaType,
      signal: abort.signal,
    })
    const record: IngestedFileRecord = {
      schemaVersion: 1,
      attachmentId: headers.attachmentId,
      artifactId: committed.artifact.artifactId,
      digest: committed.artifact.digest,
      name: headers.name,
      size: committed.artifact.size,
      mediaType: detected.mediaType,
      contentKind: detected.contentKind,
      readStrategy: detected.readStrategy,
      projectId: committed.projectId,
      workspaceId: committed.workspaceId,
      sessionId: String(agent.session.id),
      agentId: String(agent.id),
      ...(headers.browserMediaType === undefined ? {} : { browserMediaType: headers.browserMediaType }),
      ...(detected.extension === undefined ? {} : { extension: detected.extension }),
      ...(detected.archive === undefined ? {} : { archive: detected.archive }),
      parserProvenance: detected.parserProvenance,
      uploadedAt: committed.artifact.committedAt,
    }
    try {
      await this.records.save(record)
    } catch (error) {
      try {
        await this.ctx.geoResearchProjects.rollbackUploadedArtifact(agent, {
          attachmentId: headers.attachmentId,
          expectedGeneration: committed.generation,
          artifact: {
            artifactId: committed.artifact.artifactId,
            digest: committed.artifact.digest,
            kind: committed.artifact.kind,
          },
        })
      } catch (rollbackError) {
        throw new GeoResearchError(
          'ATTACHMENT_INVALID',
          'attachment record publication failed and Artifact rollback could not be completed',
          { cause: new AggregateError([error, rollbackError], 'attachment upload compensation failed') },
        )
      }
      throw error
    }
    responseJson(res, 201, publicReference(record))
  }

  private readableUploadLimit(detected: DetectedFileType): number {
    if (detected.readStrategy === 'document' || detected.readStrategy === 'data') {
      return Math.min(this.maxFileBytes, STRUCTURED_READ_LIMITS.maxInputBytes)
    }
    if (detected.readStrategy === 'image') {
      if (isTranscodedImageMediaType(detected.mediaType)) {
        return Math.min(this.maxFileBytes, SPECIAL_IMAGE_LIMITS.maxInputBytes)
      }
      return Math.min(
        this.maxFileBytes,
        DEEPSEEK_VISION_LIMITS.maxInlineImageBytes,
        OCR_LIMITS.maxInputBytes,
      )
    }
    return this.maxFileBytes
  }

  private agentForRequest(req: IncomingMessage): Agent {
    const raw = singleHeader(req, 'x-georesearch-session-id')
    if (raw === undefined || raw.length === 0 || raw.length > 128) {
      throw new GeoResearchError('ATTACHMENT_SESSION_MISMATCH', 'upload requires an exact session id')
    }
    const agent = liveAgentForSession(this.ctx, raw)
    if (agent === undefined) throw new GeoResearchError('ATTACHMENT_SESSION_MISMATCH', 'the addressed Agent is not live')
    return agent
  }

  private async authorizeAgent(agent: Agent, attachIfMissing: boolean): Promise<{ readonly projectId: string; readonly workspaceId: string }> {
    this.ctx.geoResearchInstallation.assertCurrent()
    if (this.ctx.geoResearchPolicy.actorFor(agent) === undefined) {
      throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', 'file access requires a live GeoResearch Agent')
    }
    const resolved = await this.ctx.geoResearchProjects.resolveAgent(agent, { attachIfMissing })
    return { projectId: resolved.stateFile.projectId, workspaceId: resolved.binding.workspaceId }
  }
}

function defaultImageUnderstandingAnalyzer(ctx: Context, config: Config): ImageUnderstandingAnalyzer {
  const credentials = ctx.get('credentials', false) ?? {
    resolve: async () => undefined,
  }
  return new DeepSeekVisionAnalyzer({
    credentials,
    ...(config.visionCredentialRef === undefined ? {} : { credentialRef: config.visionCredentialRef }),
    timeoutMs: boundedConfig(
      config.visionTimeoutMs,
      DEEPSEEK_VISION_LIMITS.timeoutMs,
      'visionTimeoutMs',
    ),
    maxOutputTokens: boundedConfig(
      config.visionMaxOutputTokens,
      DEEPSEEK_VISION_LIMITS.maxOutputTokens,
      'visionMaxOutputTokens',
    ),
    cacheMaxEntries: optionalNonNegativeInteger(
      config.visionCacheMaxEntries,
      'visionCacheMaxEntries',
    ) ?? DEEPSEEK_VISION_LIMITS.maxCachedResults,
  })
}

export function apply(ctx: Context, config: Config = {}): void {
  const service = new GeoResearchFileService(ctx, config)
  for (const tool of fileTools(ctx, service)) registerTool(ctx, tool)
  installWorkspaceImageOverrides(ctx, service)
}

function installWorkspaceImageOverrides(ctx: Context, service: GeoResearchFileService): void {
  const installed = new Map<Agent, () => void>()
  const install = (agent: Agent): void => {
    if (installed.has(agent)) return
    const dispose = registerWorkspaceImageOverride(ctx, service, agent)
    if (dispose !== undefined) installed.set(agent, dispose)
  }
  const remove = (agent: Agent): void => {
    installed.get(agent)?.()
    installed.delete(agent)
  }
  ctx.effect(() => {
    const stopCreated = onAgentCreated(ctx, install)
    const stopDisposed = onAgentDisposed(ctx, remove)
    for (const agent of ctx.agents.list()) install(agent)
    return () => {
      stopCreated()
      stopDisposed()
      for (const dispose of installed.values()) dispose()
      installed.clear()
    }
  }, 'georesearch-file-service: scoped workspace image tools')
}

export function registerWorkspaceImageOverride(
  ctx: Context,
  service: GeoResearchFileService,
  agent: Agent,
): (() => void) | undefined {
  if (ctx.geoResearchPolicy.actorFor(agent) === undefined) return undefined
  return registerTool(agent.ctx, workspaceImageTool(ctx, service))
}

export function workspaceImageTool(
  ctx: Context,
  service: GeoResearchFileService = ctx.geoResearchFiles,
): ToolDefinition {
  return {
    name: 'read_image',
    description: 'Read and interpret a workspace PNG, JPEG, WebP, GIF, TIFF, or BMP with DeepSeek-V4-Flash-Vision-Exp, independently of whether the selected Harness model accepts image input. Provider failure falls back to selected-model native vision when available, then bounded local English/Simplified-Chinese OCR. An optional question focuses the analysis; use page for multi-page TIFF files.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_path: { type: 'string' },
        page: { type: 'integer' },
        question: { type: 'string' },
      },
      required: ['file_path'],
    },
    output: { schema: openObjectSchema(), render: renderWorkspaceImageRead },
    isConcurrencySafe: () => true,
    async execute(args, execution) {
      const record = objectRecord(args, 'read_image arguments')
      const agent = exactAgent(execution, 'read_image')
      const filePath = nonEmptyText(record.file_path, 'file_path')
      const question = optionalBoundedText(
        record.question,
        'question',
        DEEPSEEK_VISION_LIMITS.maxQuestionBytes,
      )
      return await readWorkspaceImage(ctx, agent, service, filePath, record, question, execution)
    },
  }
}

export function fileTools(ctx: Context, service: GeoResearchFileService = ctx.geoResearchFiles): readonly ToolDefinition[] {
  return [
    {
      name: 'attachment_list',
      description: 'List files uploaded into this exact live GeoResearch Agent session. No workspace path is required.',
      parameters: emptyObjectSchema(),
      output: { schema: openObjectSchema(), render: renderJson },
      isConcurrencySafe: () => true,
      async execute(_args, execution) {
        return { attachments: await service.listForAgent(exactAgent(execution, 'attachment_list')) } as unknown as JsonValue
      },
    },
    {
      name: 'attachment_inspect',
      description: 'Inspect byte-derived type, size, digest, Artifact identity, and read strategy for one uploaded file.',
      parameters: attachmentParameters(),
      output: { schema: openObjectSchema(), render: renderJson },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        return (await service.requireRecord(
          exactAgent(execution, 'attachment_inspect'),
          attachmentIdArg(args),
        )).record as unknown as JsonValue
      },
    },
    {
      name: 'attachment_read',
      description: 'Read uploaded source/text by byte window, PDF by 1-based page window, or safely extract modern/legacy Office, OpenDocument, EPUB, Jupyter Notebook, SQLite, HDF5, NetCDF classic, and Parquet content. Every approved embedded document image within the byte and archive safety envelope is automatically interpreted with DeepSeek-V4-Flash-Vision-Exp; the plugin imposes no image-count cap. PPTX package thumbnails are excluded and presentation images are analyzed with their slide text and speaker-note context. Provider failure falls back to native model vision when available, then local English/Simplified-Chinese OCR. Uploaded code, formulas, macros, notebooks, database extensions, and embedded active content are never executed.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachmentId: { type: 'string' },
          byteOffset: { type: 'integer' },
          page: { type: 'integer' },
          maxPages: { type: 'integer' },
        },
        required: ['attachmentId'],
      },
      output: { schema: openObjectSchema(), render: renderAttachmentRead },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        const record = objectRecord(args, 'attachment_read arguments')
        const agent = exactAgent(execution, 'attachment_read')
        const resolved = await service.requireRecord(agent, attachmentIdArg(record))
        if (resolved.record.readStrategy === 'document' && resolved.record.mediaType === 'application/pdf') {
          if (record.byteOffset !== undefined) throw new TypeError('byteOffset is not valid for PDF files')
          return await readPdfAttachment(ctx, agent, service, resolved, record, execution.signal)
        }
        if (resolved.record.readStrategy === 'document' || resolved.record.readStrategy === 'data') {
          if (record.page !== undefined || record.maxPages !== undefined) {
            throw new TypeError('page and maxPages are only valid for PDF files')
          }
          return await readStructuredFile(ctx, agent, service, resolved, record, service.maxDirectReadBytes, execution.signal)
        }
        if (resolved.record.readStrategy !== 'direct-text') {
          throw new GeoResearchError(
            'ATTACHMENT_MEDIA_UNREADABLE',
            `${resolved.record.name} requires ${resolved.record.readStrategy}`,
          )
        }
        if (record.page !== undefined || record.maxPages !== undefined) {
          throw new TypeError('page and maxPages are only valid for PDF files')
        }
        const offset = optionalNonNegativeInteger(record.byteOffset, 'byteOffset') ?? 0
        const window = await readFileWindow(resolved.path, resolved.record.size, offset, service.maxDirectReadBytes)
        const decoded = offset === 0
          ? decodeTextBytes(window.bytes)
          : { encoding: 'utf-8-window', text: Buffer.from(window.bytes).toString('utf8') }
        if (decoded === undefined) throw new GeoResearchError('ATTACHMENT_MEDIA_UNREADABLE', `${resolved.record.name} is not valid UTF-8/UTF-16 text`)
        return {
          attachmentId: resolved.record.attachmentId,
          name: resolved.record.name,
          mediaType: resolved.record.mediaType,
          byteOffset: offset,
          bytesRead: window.bytes.byteLength,
          nextByteOffset: window.truncated ? offset + window.bytes.byteLength : null,
          truncated: window.truncated,
          encoding: decoded.encoding,
          text: decoded.text,
        }
      },
    },
    {
      name: 'archive_list',
      description: 'Safely list bounded entries in an uploaded ZIP, TAR, or TAR.GZ archive without extracting it to the workspace.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { attachmentId: { type: 'string' }, limit: { type: 'integer' } },
        required: ['attachmentId'],
      },
      output: { schema: openObjectSchema(), render: renderJson },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        const record = objectRecord(args, 'archive_list arguments')
        const resolved = await service.requireRecord(exactAgent(execution, 'archive_list'), attachmentIdArg(record))
        const format = archiveFormat(resolved.record)
        const limit = optionalPositiveInteger(record.limit, 'limit') ?? service.maxArchiveListEntries
        if (limit > service.maxArchiveListEntries) throw new TypeError(`limit cannot exceed ${service.maxArchiveListEntries}`)
        return {
          attachmentId: resolved.record.attachmentId,
          name: resolved.record.name,
          ...(await listArchive(resolved.path, format, limit)),
        } as unknown as JsonValue
      },
    },
    {
      name: 'archive_read',
      description: 'Read one bounded text entry from an uploaded ZIP, TAR, or TAR.GZ archive after validating the entire archive safety envelope.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { attachmentId: { type: 'string' }, entryPath: { type: 'string' } },
        required: ['attachmentId', 'entryPath'],
      },
      output: { schema: openObjectSchema(), render: renderArchiveRead },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        const record = objectRecord(args, 'archive_read arguments')
        const resolved = await service.requireRecord(exactAgent(execution, 'archive_read'), attachmentIdArg(record))
        const entryPath = nonEmptyText(record.entryPath, 'entryPath')
        const bytes = await readArchiveEntry(resolved.path, archiveFormat(resolved.record), entryPath, service.maxDirectReadBytes)
        const detected = detectFileType(bytes.subarray(0, GENERIC_ATTACHMENT_LIMITS.sniffBytes), entryPath)
        if (detected.contentKind === 'archive') {
          throw new GeoResearchError('ATTACHMENT_ARCHIVE_UNSAFE', 'nested archive traversal is disabled')
        }
        const decoded = decodeTextBytes(bytes)
        if (decoded === undefined) throw new GeoResearchError('ATTACHMENT_MEDIA_UNREADABLE', `archive entry ${entryPath} is not text`)
        return {
          attachmentId: resolved.record.attachmentId,
          archiveName: resolved.record.name,
          entryPath,
          mediaType: detected.mediaType,
          encoding: decoded.encoding,
          bytesRead: bytes.byteLength,
          text: decoded.text,
        }
      },
    },
    {
      name: 'attachment_read_image',
      description: 'Interpret an uploaded PNG, JPEG, WebP, GIF, TIFF, or BMP with DeepSeek-V4-Flash-Vision-Exp. An optional question focuses the visual analysis. Provider failure falls back to native model vision when available, then bounded local English/Simplified-Chinese OCR. TIFF/BMP are safely transcoded to PNG; use page for multi-page TIFF files.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachmentId: { type: 'string' },
          page: { type: 'integer' },
          question: { type: 'string' },
        },
        required: ['attachmentId'],
      },
      output: { schema: openObjectSchema(), render: renderImageRead },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        const record = objectRecord(args, 'attachment_read_image arguments')
        const agent = exactAgent(execution, 'attachment_read_image')
        const resolved = await service.requireRecord(agent, attachmentIdArg(record))
        if (resolved.record.readStrategy !== 'image') {
          throw new GeoResearchError('ATTACHMENT_MEDIA_UNREADABLE', `${resolved.record.name} is not an image attachment`)
        }
        const question = optionalBoundedText(
          record.question,
          'question',
          DEEPSEEK_VISION_LIMITS.maxQuestionBytes,
        )
        return await readImageAttachment(ctx, agent, service, resolved, record, question, execution.signal)
      },
    },
  ]
}

async function readStructuredFile(
  ctx: Context,
  agent: Agent,
  service: GeoResearchFileService,
  resolved: ResolvedRecord,
  args: Record<string, unknown>,
  maxBytes: number,
  signal: AbortSignal,
): Promise<JsonValue> {
  const offset = optionalNonNegativeInteger(args.byteOffset, 'byteOffset') ?? 0
  let parsed: Awaited<ReturnType<typeof readStructuredAttachment>>
  try {
    parsed = await readStructuredAttachment(resolved.path, resolved.record.mediaType, signal)
  } catch (error) {
    if (signal.aborted) throw error
    if (error instanceof GeoResearchError) throw error
    throw new GeoResearchError(
      'ATTACHMENT_MEDIA_UNREADABLE',
      `${resolved.record.name}: ${error instanceof Error ? error.message : 'structured content read failed'}`,
      { cause: error },
    )
  }
  const warnings = [...parsed.warnings]
  const images: Array<Record<string, JsonValue>> = []
  const ocrImages: Array<Record<string, JsonValue>> = []
  const visionImages: Array<Record<string, JsonValue>> = []
  if (offset === 0 && parsed.images.length > 0) {
    const attempts = await mapWithConcurrency(parsed.images, 3, async embedded => await attemptVision(
      service,
      embedded,
      'document-image',
      documentImageQuestion(embedded.contexts),
      signal,
    ))
    const needsFallback = attempts.some(attempt => attempt.analysis === undefined)
    const attachments = needsFallback ? ctx.get('attachments', false) : undefined
    const capabilityFailure = needsFallback
      ? await imageCapabilityFailure(ctx, agent, signal)
      : undefined
    let remainingBytes = attachments?.imageLimits.maxMessageImageBytes ?? 0
    for (const [index, embedded] of parsed.images.entries()) {
      const attempt = attempts[index]
      if (attempt?.analysis !== undefined) {
        visionImages.push({
          path: embedded.path,
          mediaType: embedded.mediaType,
          contexts: (embedded.contexts ?? []) as unknown as JsonValue,
          analysis: attempt.analysis as unknown as JsonValue,
        })
        continue
      }
      const visionFailure = attempt?.failure ?? 'DeepSeek vision analysis was unavailable'
      warnings.push(`${embedded.path} DeepSeek visual analysis fallback: ${visionFailure}.`)
      const nativeFailure = nativeImageDeliveryFailure(
        attachments,
        capabilityFailure,
        embedded,
        remainingBytes,
      )
      if (attachments !== undefined && nativeFailure === undefined) {
        try {
          const image = await attachments.saveImage({
            data: embedded.data,
            mediaType: embedded.mediaType,
            name: embedded.path,
          })
          images.push({
            path: embedded.path,
            contexts: (embedded.contexts ?? []) as unknown as JsonValue,
            image: image as unknown as JsonValue,
          })
          remainingBytes -= embedded.data.byteLength
          continue
        } catch {
          warnings.push(`${embedded.path} could not be stored for native visual fallback.`)
        }
      }
      try {
        const ocr = await analyzeLocalOcr(service, embedded.path, embedded.data, signal)
        ocrImages.push({
          path: embedded.path,
          mediaType: embedded.mediaType,
          contexts: (embedded.contexts ?? []) as unknown as JsonValue,
          ocr: ocr as unknown as JsonValue,
        })
      } catch (error) {
        if (signal.aborted) throw error
        warnings.push(`${embedded.path} local OCR failed after visual fallbacks.`)
      }
    }
  }
  const bytes = Buffer.from(parsed.text)
  if (offset > bytes.byteLength) throw new TypeError('byteOffset is outside the extracted document text')
  const end = Math.min(bytes.byteLength, offset + maxBytes)
  const text = bytes.subarray(offset, end).toString('utf8')
  return {
    kind: 'structured',
    attachmentId: resolved.record.attachmentId,
    name: resolved.record.name,
    mediaType: resolved.record.mediaType,
    format: parsed.format,
    byteOffset: offset,
    bytesRead: end - offset,
    nextByteOffset: end < bytes.byteLength ? end : null,
    truncated: end < bytes.byteLength,
    extractedTextBytes: parsed.extractedTextBytes,
    extractionTruncated: parsed.extractionTruncated,
    warnings,
    images,
    ocrImages,
    visionImages,
    text,
  }
}

async function readPdfAttachment(
  ctx: Context,
  agent: Agent,
  service: GeoResearchFileService,
  resolved: ResolvedRecord,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<JsonValue> {
  const page = optionalPositiveInteger(args.page, 'page') ?? 1
  const maxPages = optionalPositiveInteger(args.maxPages, 'maxPages') ?? PDF_READ_LIMITS.maxPagesPerCall
  if (maxPages > PDF_READ_LIMITS.maxPagesPerCall) {
    throw new TypeError(`maxPages cannot exceed ${PDF_READ_LIMITS.maxPagesPerCall}`)
  }
  if (resolved.record.size > PDF_READ_LIMITS.maxInputBytes) {
    throw new GeoResearchError(
      'ATTACHMENT_TOO_LARGE',
      `${resolved.record.name} exceeds the ${PDF_READ_LIMITS.maxInputBytes}-byte PDF read limit`,
    )
  }
  const warnings: string[] = []
  const renderImages = true
  const maxPagePixels: number = PDF_READ_LIMITS.maxPagePixels
  const maxPageImageBytes: number = Math.min(
    PDF_READ_LIMITS.maxPageImageBytes,
    DEEPSEEK_VISION_LIMITS.maxInlineImageBytes,
    OCR_LIMITS.maxInputBytes,
  )
  let parsed: PdfDocumentRead
  try {
    parsed = await readPdfDocument(await readFile(resolved.path), {
      page,
      maxPages,
      renderImages,
      maxPagePixels,
      maxPageImageBytes,
    }, signal)
  } catch (error) {
    if (signal.aborted) throw error
    const message = error instanceof Error ? error.message : 'PDF read failed'
    throw new GeoResearchError(
      /exceeds/iu.test(message) ? 'ATTACHMENT_TOO_LARGE' : 'ATTACHMENT_MEDIA_UNREADABLE',
      `${resolved.record.name}: ${message}`,
      { cause: error },
    )
  }
  const visionAttempts = await Promise.all(parsed.pages.map(async parsedPage => (
    parsedPage.image === undefined
      ? undefined
      : await attemptVision(service, parsedPage.image, 'pdf-page', undefined, signal)
  )))
  const needsFallback = visionAttempts.some(attempt => attempt !== undefined && attempt.analysis === undefined)
  const attachments = needsFallback ? ctx.get('attachments', false) : undefined
  const capabilityFailure = needsFallback
    ? await imageCapabilityFailure(ctx, agent, signal)
    : undefined
  let remainingBytes = attachments?.imageLimits.maxMessageImageBytes ?? 0
  const pages: Array<Record<string, JsonValue>> = []
  for (const [index, parsedPage] of parsed.pages.entries()) {
    if (parsedPage.imageWarning !== undefined) warnings.push(`Page ${parsedPage.page}: ${parsedPage.imageWarning}`)
    let image: ImageAttachmentRef | undefined
    let ocr: ImageTextAnalysis | undefined
    let analysis: ImageUnderstandingAnalysis | undefined
    if (parsedPage.image !== undefined) {
      const attempt = visionAttempts[index]
      if (attempt?.analysis !== undefined) {
        analysis = attempt.analysis
      } else {
        const visionFailure = attempt?.failure ?? 'DeepSeek vision analysis was unavailable'
        warnings.push(`Page ${parsedPage.page} DeepSeek visual analysis fallback: ${visionFailure}.`)
        const nativeFailure = nativeImageDeliveryFailure(
          attachments,
          capabilityFailure,
          parsedPage.image,
          remainingBytes,
        )
        if (attachments !== undefined && nativeFailure === undefined) {
          try {
            image = await attachments.saveImage({
              data: parsedPage.image.data,
              mediaType: parsedPage.image.mediaType,
              name: `${resolved.record.attachmentId}-page-${parsedPage.page}.jpg`,
            })
            remainingBytes -= parsedPage.image.data.byteLength
          } catch {
            warnings.push(`Page ${parsedPage.page} could not be stored for native visual fallback.`)
          }
        }
      }
      if (analysis === undefined && image === undefined) {
        try {
          ocr = await analyzeLocalOcr(service, resolved.record.name, parsedPage.image.data, signal)
        } catch (error) {
          if (signal.aborted) throw error
          warnings.push(`Page ${parsedPage.page} local OCR failed after visual fallbacks.`)
        }
      }
    }
    pages.push({
      page: parsedPage.page,
      text: parsedPage.text,
      textBytes: parsedPage.textBytes,
      ...(analysis === undefined ? {} : { analysis: analysis as unknown as JsonValue }),
      ...(image === undefined ? {} : { image: image as unknown as JsonValue }),
      ...(ocr === undefined ? {} : { ocr: ocr as unknown as JsonValue }),
    })
  }
  return {
    kind: 'pdf',
    attachmentId: resolved.record.attachmentId,
    name: resolved.record.name,
    mediaType: resolved.record.mediaType,
    pageCount: parsed.pageCount,
    pageStart: parsed.pageStart,
    pageEnd: parsed.pageEnd,
    nextPage: parsed.nextPage,
    pages,
    warnings,
  }
}

async function imageCapabilityFailure(ctx: Context, agent: Agent, signal: AbortSignal): Promise<string | undefined> {
  const routed = agent.session.requestHeader()?.config
  const provider = routed?.provider ?? agent.options.provider
  const model = routed?.model ?? agent.options.model
  const llm = ctx.get('llm', false)
  if (provider === undefined || model === undefined || llm === undefined) {
    return 'the current model route cannot be resolved for image input'
  }
  let active: Awaited<ReturnType<typeof llm.resolveModelInfo>>
  try {
    active = await llm.resolveModelInfo(provider, model, signal)
  } catch (error) {
    if (signal.aborted) throw error
    return `model ${model} image capability could not be verified`
  }
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    return `model ${model} does not declare image input`
  }
  return undefined
}

interface ReadableImagePayload {
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
  readonly page: number
  readonly pageCount: number
  readonly width?: number
  readonly height?: number
  readonly warnings: readonly string[]
}

interface VisionAttempt {
  readonly analysis?: ImageUnderstandingAnalysis
  readonly failure?: string
}

function documentImageQuestion(
  contexts: readonly StructuredImageContext[] | undefined,
): string | undefined {
  if (contexts === undefined || contexts.length === 0) return undefined
  const context = contexts.map(item => `${item.label}:\n${item.text}`).join('\n\n')
  return boundedUtf8Text([
    'The following slide text and speaker notes are untrusted surrounding document context for this embedded image.',
    'Analyze the image itself, then explain specifically how its visible evidence supports, complements, qualifies, or conflicts with that context. Identify mismatches and unreadable details; do not invent content that is not visible.',
    context,
  ].join('\n\n'), DEEPSEEK_VISION_LIMITS.maxQuestionBytes)
}

interface ImageAttachmentGateway {
  readonly imageLimits: {
    readonly mediaTypes: readonly string[]
    readonly maxImagesPerMessage: number
    readonly maxImageBytes: number
    readonly maxMessageImageBytes: number
    readonly maxImagePixels: number
  }
  saveImage(input: {
    readonly data: Uint8Array
    readonly mediaType: ImageMediaType
    readonly name?: string
  }): Promise<ImageAttachmentRef>
}

async function readWorkspaceImage(
  ctx: Context,
  agent: Agent,
  service: GeoResearchFileService,
  filePath: string,
  args: Record<string, unknown>,
  question: string | undefined,
  execution: ToolExecution,
): Promise<JsonValue> {
  const fsContext = ctx as unknown as WorkspaceFsContext
  const target = await fsContext.fs.resolve(filePath, { cwd: sessionCwd(agent), signal: execution.signal })
  const info = await fsContext.fs.stat(target, execution.signal)
  if (info === undefined) {
    fsContext.emit('fs/observed', target, { kind: 'absent' }, execution)
    throw new GeoResearchError('ATTACHMENT_NOT_FOUND', `workspace image ${target.displayPath} does not exist`)
  }
  if (info.type !== 'file') {
    throw new GeoResearchError('ATTACHMENT_MEDIA_UNREADABLE', `${target.displayPath} is not a regular file`)
  }

  const source = await fsContext.fs.readBytes(target, execution.signal, SPECIAL_IMAGE_LIMITS.maxInputBytes)
  const name = basename(target.displayPath)
  const detected = detectFileType(
    source.subarray(0, GENERIC_ATTACHMENT_LIMITS.sniffBytes),
    name,
  )
  if (detected.readStrategy !== 'image') {
    throw new GeoResearchError(
      'ATTACHMENT_MEDIA_UNREADABLE',
      `${target.displayPath} is ${detected.mediaType}, not a supported raster image`,
    )
  }
  const payload = readWorkspaceImagePayload(source, detected.mediaType, args, execution.signal)
  fsContext.emit('fs/observed', target, { kind: 'present', version: info.version }, execution)

  const base = workspaceImageResultBase(target.displayPath, name, detected.mediaType, payload)
  const vision = await attemptVision(service, payload, 'standalone', question, execution.signal)
  if (vision.analysis !== undefined) {
    return {
      ...base,
      delivery: 'deepseek-vision',
      analysis: vision.analysis as unknown as JsonValue,
    }
  }

  const visionFailure = vision.failure ?? 'DeepSeek vision analysis was unavailable'
  const warnings = [...payload.warnings, `DeepSeek visual analysis fallback: ${visionFailure}.`]
  const attachments = ctx.get('attachments', false)
  const capabilityFailure = await imageCapabilityFailure(ctx, agent, execution.signal)
  const nativeFailure = nativeImageDeliveryFailure(
    attachments,
    capabilityFailure,
    payload,
    payload.data.byteLength,
  )
  if (attachments !== undefined && nativeFailure === undefined) {
    try {
      const image = await attachments.saveImage({
        data: payload.data,
        mediaType: payload.mediaType,
        name: payload.pageCount === 1 ? name : `${name}-page-${payload.page}.png`,
      })
      return {
        ...base,
        warnings,
        delivery: 'native-vision',
        fallbackReason: visionFailure,
        image: image as unknown as JsonValue,
      }
    } catch {
      warnings.push('Harness native image storage failed after the DeepSeek vision fallback.')
    }
  }

  const ocr = await analyzeLocalOcr(service, name, payload.data, execution.signal)
  return {
    ...base,
    warnings,
    delivery: 'local-ocr',
    fallbackReason: [visionFailure, nativeFailure].filter(value => value !== undefined).join('; '),
    ocr: ocr as unknown as JsonValue,
  }
}

function readWorkspaceImagePayload(
  source: Uint8Array,
  sourceMediaType: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): ReadableImagePayload {
  if (isTranscodedImageMediaType(sourceMediaType)) {
    const selectedPage = optionalPositiveInteger(args.page, 'page')
    const parsed = readSpecialImageBytes(source, sourceMediaType, {
      ...(selectedPage === undefined ? {} : { page: selectedPage }),
      maxPixels: SPECIAL_IMAGE_LIMITS.maxDecodedPixels,
      maxOutputBytes: Math.min(SPECIAL_IMAGE_LIMITS.maxOutputBytes, OCR_LIMITS.maxInputBytes),
    }, signal)
    return {
      data: parsed.data,
      mediaType: parsed.mediaType,
      page: parsed.page,
      pageCount: parsed.pageCount,
      width: parsed.width,
      height: parsed.height,
      warnings: parsed.warnings,
    }
  }

  const page = optionalPositiveInteger(args.page, 'page') ?? 1
  if (page !== 1) throw new TypeError('native image files contain only page 1')
  const limit = Math.min(DEEPSEEK_VISION_LIMITS.maxInlineImageBytes, OCR_LIMITS.maxInputBytes)
  if (source.byteLength > limit) {
    throw new GeoResearchError(
      'ATTACHMENT_TOO_LARGE',
      `workspace image exceeds the ${limit}-byte readable image limit`,
    )
  }
  return {
    data: source,
    mediaType: imageDeliveryMediaType(sourceMediaType),
    page,
    pageCount: 1,
    warnings: [],
  }
}

function workspaceImageResultBase(
  path: string,
  name: string,
  sourceMediaType: string,
  payload: ReadableImagePayload,
): Record<string, JsonValue> {
  return {
    path,
    name,
    sourceMediaType,
    mediaType: payload.mediaType,
    page: payload.page,
    pageCount: payload.pageCount,
    ...(payload.width === undefined ? {} : { width: payload.width }),
    ...(payload.height === undefined ? {} : { height: payload.height }),
    warnings: [...payload.warnings],
  }
}

async function readImageAttachment(
  ctx: Context,
  agent: Agent,
  service: GeoResearchFileService,
  resolved: ResolvedRecord,
  args: Record<string, unknown>,
  question: string | undefined,
  signal: AbortSignal,
): Promise<JsonValue> {
  const payload = await readImagePayload(resolved, args, signal)
  const vision = await attemptVision(service, payload, 'standalone', question, signal)
  const base = imageReadResultBase(resolved, payload)
  if (vision.analysis !== undefined) {
    return {
      ...base,
      delivery: 'deepseek-vision',
      analysis: vision.analysis as unknown as JsonValue,
    }
  }

  const visionFailure = vision.failure ?? 'DeepSeek vision analysis was unavailable'
  const warnings = [...payload.warnings, `DeepSeek visual analysis fallback: ${visionFailure}.`]
  const attachments = ctx.get('attachments', false)
  const capabilityFailure = await imageCapabilityFailure(ctx, agent, signal)
  const nativeFailure = nativeImageDeliveryFailure(
    attachments,
    capabilityFailure,
    payload,
    payload.data.byteLength,
  )
  if (attachments !== undefined && nativeFailure === undefined) {
    try {
      const image = await attachments.saveImage({
        data: payload.data,
        mediaType: payload.mediaType,
        name: payload.pageCount === 1
          ? resolved.record.name
          : `${resolved.record.name}-page-${payload.page}.png`,
      })
      return {
        ...base,
        warnings,
        delivery: 'native-vision',
        fallbackReason: visionFailure,
        image: image as unknown as JsonValue,
      }
    } catch {
      warnings.push('Harness native image storage failed after the DeepSeek vision fallback.')
    }
  }

  const ocr = await analyzeLocalOcr(service, resolved.record.name, payload.data, signal)
  return {
    ...base,
    warnings,
    delivery: 'local-ocr',
    fallbackReason: [visionFailure, nativeFailure].filter(value => value !== undefined).join('; '),
    ocr: ocr as unknown as JsonValue,
  }
}

async function readImagePayload(
  resolved: ResolvedRecord,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ReadableImagePayload> {
  if (isTranscodedImageMediaType(resolved.record.mediaType)) {
    const selectedPage = optionalPositiveInteger(args.page, 'page')
    const parsed = await readSpecialImage(resolved.path, resolved.record.mediaType, {
      ...(selectedPage === undefined ? {} : { page: selectedPage }),
      maxPixels: SPECIAL_IMAGE_LIMITS.maxDecodedPixels,
      maxOutputBytes: Math.min(SPECIAL_IMAGE_LIMITS.maxOutputBytes, OCR_LIMITS.maxInputBytes),
    }, signal)
    return {
      data: parsed.data,
      mediaType: parsed.mediaType,
      page: parsed.page,
      pageCount: parsed.pageCount,
      width: parsed.width,
      height: parsed.height,
      warnings: parsed.warnings,
    }
  }

  const page = optionalPositiveInteger(args.page, 'page') ?? 1
  if (page !== 1) throw new TypeError('native image files contain only page 1')
  const limit = Math.min(DEEPSEEK_VISION_LIMITS.maxInlineImageBytes, OCR_LIMITS.maxInputBytes)
  if (resolved.record.size > limit) {
    throw new GeoResearchError(
      'ATTACHMENT_TOO_LARGE',
      `${resolved.record.name} exceeds the ${limit}-byte readable image limit`,
    )
  }
  return {
    data: await readFile(resolved.path, { signal }),
    mediaType: imageDeliveryMediaType(resolved.record.mediaType),
    page,
    pageCount: 1,
    warnings: [],
  }
}

async function attemptVision(
  service: Pick<GeoResearchFileService, 'imageUnderstandingAnalyzer'>,
  image: Pick<ReadableImagePayload, 'data' | 'mediaType'>,
  purpose: ImageUnderstandingPurpose,
  question: string | undefined,
  signal: AbortSignal,
): Promise<VisionAttempt> {
  try {
    const analysis = await service.imageUnderstandingAnalyzer.analyze({
      data: image.data,
      mediaType: image.mediaType,
      purpose,
      ...(question === undefined ? {} : { question }),
    }, signal)
    return { analysis }
  } catch (error) {
    if (signal.aborted) throw error
    return { failure: describeVisionFailure(error) }
  }
}

async function analyzeLocalOcr(
  service: Pick<GeoResearchFileService, 'imageTextAnalyzer'>,
  name: string,
  data: Uint8Array,
  signal: AbortSignal,
): Promise<ImageTextAnalysis> {
  try {
    return await service.imageTextAnalyzer.analyze(data, signal)
  } catch (error) {
    if (signal.aborted) throw error
    const message = error instanceof Error ? error.message : 'local OCR failed'
    throw new GeoResearchError(
      /exceeds/iu.test(message) ? 'ATTACHMENT_TOO_LARGE' : 'ATTACHMENT_MEDIA_UNREADABLE',
      `${name}: ${message}`,
      { cause: error },
    )
  }
}

function imageReadResultBase(
  resolved: ResolvedRecord,
  payload: ReadableImagePayload,
): Record<string, JsonValue> {
  return {
    attachmentId: resolved.record.attachmentId,
    name: resolved.record.name,
    sourceMediaType: resolved.record.mediaType,
    mediaType: payload.mediaType,
    page: payload.page,
    pageCount: payload.pageCount,
    ...(payload.width === undefined ? {} : { width: payload.width }),
    ...(payload.height === undefined ? {} : { height: payload.height }),
    warnings: [...payload.warnings],
  }
}

function nativeImageDeliveryFailure(
  attachments: ImageAttachmentGateway | undefined,
  capabilityFailure: string | undefined,
  image: Pick<ReadableImagePayload, 'data' | 'mediaType' | 'width' | 'height'>,
  remainingBytes: number,
): string | undefined {
  if (capabilityFailure !== undefined) return capabilityFailure
  if (attachments === undefined) return 'no Harness image attachment store is mounted'
  if (!attachments.imageLimits.mediaTypes.includes(image.mediaType)) {
    return `the Harness image store does not accept ${image.mediaType}`
  }
  if (image.data.byteLength > attachments.imageLimits.maxImageBytes
    || image.data.byteLength > attachments.imageLimits.maxMessageImageBytes
    || image.data.byteLength > remainingBytes) {
    return 'the image exceeds the Harness native image byte budget'
  }
  if (image.width !== undefined && image.height !== undefined
    && image.width * image.height > attachments.imageLimits.maxImagePixels) {
    return 'the image exceeds the Harness native image pixel budget'
  }
  return undefined
}

function renderImageRead(_args: unknown, value: JsonValue): ContentBlock[] {
  const record = value as unknown as {
    readonly attachmentId: string
    readonly name: string
    readonly sourceMediaType: string
    readonly mediaType: string
    readonly page: number
    readonly pageCount: number
    readonly warnings: readonly string[]
    readonly delivery: 'deepseek-vision' | 'native-vision' | 'local-ocr'
    readonly fallbackReason?: string
    readonly analysis?: ImageUnderstandingAnalysis
    readonly image?: ImageAttachmentRef
    readonly ocr?: ImageTextAnalysis
  }
  const blocks: ContentBlock[] = [{
    type: 'text',
    text: `<georesearch-file attachment-id="${record.attachmentId}" name="${xml(record.name)}" type="image" source-media-type="${xml(record.sourceMediaType)}" media-type="${xml(record.mediaType)}" page="${record.page}" page-count="${record.pageCount}" delivery="${record.delivery}"/>`,
  }]
  if (record.analysis !== undefined) {
    blocks.push(renderVisionBlock(
      'georesearch-image-analysis',
      `attachment-id="${record.attachmentId}" page="${record.page}"`,
      record.analysis,
    ))
  }
  if (record.image !== undefined) blocks.push({ type: 'image', attachment: record.image })
  if (record.ocr !== undefined) {
    blocks.push(renderOcrBlock(
      'georesearch-image-ocr',
      `attachment-id="${record.attachmentId}" page="${record.page}" fallback-reason="${xml(record.fallbackReason ?? '')}"`,
      record.ocr,
    ))
  }
  if (record.warnings.length > 0) {
    blocks.push({ type: 'text', text: `<georesearch-image-warnings>\n${record.warnings.join('\n')}\n</georesearch-image-warnings>` })
  }
  return blocks
}

function renderWorkspaceImageRead(_args: unknown, value: JsonValue): ContentBlock[] {
  const record = value as unknown as {
    readonly path: string
    readonly name: string
    readonly sourceMediaType: string
    readonly mediaType: string
    readonly page: number
    readonly pageCount: number
    readonly warnings: readonly string[]
    readonly delivery: 'deepseek-vision' | 'native-vision' | 'local-ocr'
    readonly fallbackReason?: string
    readonly analysis?: ImageUnderstandingAnalysis
    readonly image?: ImageAttachmentRef
    readonly ocr?: ImageTextAnalysis
  }
  const attributes = `path="${xml(record.path)}" name="${xml(record.name)}" type="image" source-media-type="${xml(record.sourceMediaType)}" media-type="${xml(record.mediaType)}" page="${record.page}" page-count="${record.pageCount}" delivery="${record.delivery}"`
  const blocks: ContentBlock[] = [{ type: 'text', text: `<georesearch-workspace-image ${attributes}/>` }]
  if (record.analysis !== undefined) {
    blocks.push(renderVisionBlock(
      'georesearch-workspace-image-analysis',
      `path="${xml(record.path)}" page="${record.page}"`,
      record.analysis,
    ))
  }
  if (record.image !== undefined) blocks.push({ type: 'image', attachment: record.image })
  if (record.ocr !== undefined) {
    blocks.push(renderOcrBlock(
      'georesearch-workspace-image-ocr',
      `path="${xml(record.path)}" page="${record.page}" fallback-reason="${xml(record.fallbackReason ?? '')}"`,
      record.ocr,
    ))
  }
  if (record.warnings.length > 0) {
    blocks.push({
      type: 'text',
      text: `<georesearch-workspace-image-warnings>\n${record.warnings.map(xml).join('\n')}\n</georesearch-workspace-image-warnings>`,
    })
  }
  return blocks
}

function renderAttachmentRead(args: unknown, value: JsonValue): ContentBlock[] {
  const kind = (value as unknown as { readonly kind?: unknown }).kind
  if (kind === 'pdf') return renderPdfRead(value)
  if (kind === 'structured') return renderStructuredRead(value)
  return renderTextRead(args, value)
}

function renderPdfRead(value: JsonValue): ContentBlock[] {
  const record = value as unknown as {
    readonly attachmentId: string
    readonly name: string
    readonly pageCount: number
    readonly pageStart: number
    readonly pageEnd: number
    readonly nextPage: number | null
    readonly warnings: readonly string[]
    readonly pages: readonly {
      readonly page: number
      readonly text: string
      readonly textBytes: number
      readonly analysis?: ImageUnderstandingAnalysis
      readonly image?: ImageAttachmentRef
      readonly ocr?: ImageTextAnalysis
    }[]
  }
  const blocks: ContentBlock[] = [{
    type: 'text',
    text: `<georesearch-pdf attachment-id="${record.attachmentId}" name="${xml(record.name)}" page-count="${record.pageCount}" page-start="${record.pageStart}" page-end="${record.pageEnd}" next-page="${record.nextPage ?? ''}"/>`,
  }]
  for (const page of record.pages) {
    blocks.push({
      type: 'text',
      text: `<georesearch-pdf-page attachment-id="${record.attachmentId}" page="${page.page}" text-bytes="${page.textBytes}">\n${page.text}\n</georesearch-pdf-page>`,
    })
    if (page.analysis !== undefined) {
      blocks.push(renderVisionBlock(
        'georesearch-pdf-page-analysis',
        `attachment-id="${record.attachmentId}" page="${page.page}"`,
        page.analysis,
      ))
    }
    if (page.image !== undefined) {
      blocks.push({
        type: 'text',
        text: `<georesearch-pdf-page-image attachment-id="${record.attachmentId}" page="${page.page}"/>`,
      })
      blocks.push({ type: 'image', attachment: page.image })
    }
    if (page.ocr !== undefined) {
      blocks.push(renderOcrBlock(
        'georesearch-pdf-page-ocr',
        `attachment-id="${record.attachmentId}" page="${page.page}"`,
        page.ocr,
      ))
    }
  }
  if (record.warnings.length > 0) {
    blocks.push({ type: 'text', text: `<georesearch-pdf-warnings>\n${record.warnings.join('\n')}\n</georesearch-pdf-warnings>` })
  }
  return blocks
}

function renderStructuredRead(value: JsonValue): ContentBlock[] {
  const record = value as unknown as {
    readonly attachmentId: string
    readonly name: string
    readonly mediaType: string
    readonly format: string
    readonly byteOffset: number
    readonly nextByteOffset: number | null
    readonly extractionTruncated: boolean
    readonly warnings: readonly string[]
    readonly images: readonly {
      readonly path: string
      readonly contexts: readonly StructuredImageContext[]
      readonly image: ImageAttachmentRef
    }[]
    readonly ocrImages: readonly {
      readonly path: string
      readonly mediaType: string
      readonly contexts: readonly StructuredImageContext[]
      readonly ocr: ImageTextAnalysis
    }[]
    readonly visionImages: readonly {
      readonly path: string
      readonly mediaType: string
      readonly contexts: readonly StructuredImageContext[]
      readonly analysis: ImageUnderstandingAnalysis
    }[]
    readonly text: string
  }
  const blocks: ContentBlock[] = [{
    type: 'text',
    text: `<georesearch-document attachment-id="${record.attachmentId}" name="${xml(record.name)}" media-type="${xml(record.mediaType)}" format="${xml(record.format)}" byte-offset="${record.byteOffset}" next-byte-offset="${record.nextByteOffset ?? ''}" extraction-truncated="${record.extractionTruncated}">\n${record.text}\n</georesearch-document>`,
  }]
  if (record.warnings.length > 0) {
    blocks.push({ type: 'text', text: `<georesearch-document-warnings>\n${record.warnings.join('\n')}\n</georesearch-document-warnings>` })
  }
  for (const embedded of record.images) {
    blocks.push({
      type: 'text',
      text: `<georesearch-document-image attachment-id="${record.attachmentId}" path="${xml(embedded.path)}"${imageSlideAttribute(embedded.contexts)}/>`,
    })
    blocks.push({ type: 'image', attachment: embedded.image })
  }
  for (const embedded of record.ocrImages) {
    blocks.push(renderOcrBlock(
      'georesearch-document-image-ocr',
      `attachment-id="${record.attachmentId}" path="${xml(embedded.path)}" media-type="${xml(embedded.mediaType)}"${imageSlideAttribute(embedded.contexts)}`,
      embedded.ocr,
    ))
  }
  for (const embedded of record.visionImages) {
    blocks.push(renderVisionBlock(
      'georesearch-document-image-analysis',
      `attachment-id="${record.attachmentId}" path="${xml(embedded.path)}" media-type="${xml(embedded.mediaType)}"${imageSlideAttribute(embedded.contexts)}`,
      embedded.analysis,
    ))
  }
  return blocks
}

function imageSlideAttribute(contexts: readonly StructuredImageContext[]): string {
  const slides = [...new Set(contexts.map(context => context.index))].sort((left, right) => left - right)
  return slides.length === 0 ? '' : ` slides="${slides.join(',')}"`
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex
        nextIndex += 1
        results[index] = await mapper(items[index] as T, index)
      }
    },
  )
  await Promise.all(workers)
  return results
}

function boundedUtf8Text(value: string, maxBytes: number): string {
  const source = Buffer.from(value)
  if (source.byteLength <= maxBytes) return value
  let end = maxBytes
  while (end > 0 && (source[end] ?? 0) >= 0x80 && (source[end] ?? 0) < 0xc0) end -= 1
  return source.subarray(0, end).toString('utf8').trimEnd()
}

function renderVisionBlock(
  tag: string,
  attributes: string,
  analysis: ImageUnderstandingAnalysis,
): ContentBlock {
  const usage = analysis.usage
  return {
    type: 'text',
    text: `<${tag} ${attributes} engine="${xml(analysis.engine)}" provider="${xml(analysis.provider)}" model="${xml(analysis.model)}" release-date="${xml(analysis.releaseDate)}" cache-status="${xml(analysis.cacheStatus ?? 'provider-response')}" finish-reason="${xml(analysis.finishReason ?? '')}" request-id="${xml(analysis.requestId ?? '')}" prompt-tokens="${usage.promptTokens ?? ''}" completion-tokens="${usage.completionTokens ?? ''}" total-tokens="${usage.totalTokens ?? ''}" input-bytes="${analysis.input.bytes}" detail="${analysis.input.detail}">\n<georesearch-vision-text>\n${xml(analysis.text)}\n</georesearch-vision-text>\n<georesearch-vision-warnings>\n${xml(analysis.warnings.join('\n'))}\n</georesearch-vision-warnings>\n</${tag}>`,
  }
}

function renderOcrBlock(tag: string, attributes: string, ocr: ImageTextAnalysis): ContentBlock {
  const confidence = ocr.confidence === null ? '' : String(ocr.confidence)
  return {
    type: 'text',
    text: `<${tag} ${attributes} engine="${xml(ocr.engine)}" languages="${xml(ocr.languages.join(','))}" confidence="${confidence}">\n<georesearch-ocr-text>\n${ocr.text}\n</georesearch-ocr-text>\n<georesearch-ocr-layout>${JSON.stringify(ocr.lines)}</georesearch-ocr-layout>\n<georesearch-ocr-warnings>\n${ocr.warnings.join('\n')}\n</georesearch-ocr-warnings>\n</${tag}>`,
  }
}

function renderTextRead(_args: unknown, value: JsonValue): ContentBlock[] {
  const record = value as unknown as { readonly attachmentId: string; readonly name: string; readonly text: string; readonly truncated: boolean; readonly nextByteOffset: number | null }
  return [{
    type: 'text',
    text: `<georesearch-file attachment-id="${record.attachmentId}" name="${xml(record.name)}" truncated="${record.truncated}" next-byte-offset="${record.nextByteOffset ?? ''}">\n${record.text}\n</georesearch-file>`,
  }]
}

function renderArchiveRead(_args: unknown, value: JsonValue): ContentBlock[] {
  const record = value as unknown as { readonly attachmentId: string; readonly archiveName: string; readonly entryPath: string; readonly text: string }
  return [{
    type: 'text',
    text: `<georesearch-archive attachment-id="${record.attachmentId}" name="${xml(record.archiveName)}" entry="${xml(record.entryPath)}">\n${record.text}\n</georesearch-archive>`,
  }]
}

function renderJson(_args: unknown, value: JsonValue): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function publicReference(record: IngestedFileRecord): GenericAttachmentRef {
  return {
    schemaVersion: 1,
    attachmentId: record.attachmentId,
    artifactId: record.artifactId,
    digest: record.digest,
    name: record.name,
    size: record.size,
    mediaType: record.mediaType,
    contentKind: record.contentKind,
    readStrategy: record.readStrategy,
  }
}

function archiveFormat(record: IngestedFileRecord): AttachmentArchiveFormat {
  if (record.archive === undefined) throw new GeoResearchError('ATTACHMENT_ARCHIVE_UNSUPPORTED', `${record.name} is not a recognized archive`)
  if (!record.archive.supported) {
    throw new GeoResearchError('ATTACHMENT_ARCHIVE_UNSUPPORTED', `${record.archive.format} archives have no approved parser`)
  }
  return record.archive.format
}

function nativeImageMediaType(value: string): ImageMediaType {
  switch (value) {
    case 'image/png':
    case 'image/jpeg':
    case 'image/webp':
    case 'image/gif': return value
    default: throw new GeoResearchError('ATTACHMENT_MEDIA_UNREADABLE', `${value} cannot be emitted as a Harness image block`)
  }
}

function imageDeliveryMediaType(value: string): ImageMediaType {
  return isTranscodedImageMediaType(value) ? 'image/png' : nativeImageMediaType(value)
}

function isTranscodedImageMediaType(value: string): value is 'image/tiff' | 'image/bmp' {
  return value === 'image/tiff' || value === 'image/bmp'
}

async function readFileWindow(
  path: string,
  size: number,
  offset: number,
  maxBytes: number,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > size) throw new TypeError('byteOffset is outside the file')
  const length = Math.min(maxBytes, size - offset)
  const buffer = Buffer.alloc(length)
  const handle = await open(path, 'r')
  try {
    const result = await handle.read(buffer, 0, length, offset)
    return { bytes: buffer.subarray(0, result.bytesRead), truncated: offset + result.bytesRead < size }
  } finally {
    await handle.close()
  }
}

async function peekStream(
  source: IncomingMessage,
  maxBytes: number,
): Promise<{ readonly head: Uint8Array; readonly source: AsyncIterable<Uint8Array> }> {
  const iterator = source[Symbol.asyncIterator]()
  const consumed: Uint8Array[] = []
  let total = 0
  let ended = false
  while (total < maxBytes) {
    const next = await iterator.next()
    if (next.done === true) {
      ended = true
      break
    }
    const chunk = Buffer.from(next.value)
    consumed.push(chunk)
    total += chunk.byteLength
  }
  return {
    head: Buffer.concat(consumed.map(Buffer.from), total).subarray(0, maxBytes),
    source: {
      async *[Symbol.asyncIterator]() {
        for (const chunk of consumed) yield chunk
        if (ended) return
        while (true) {
          const next = await iterator.next()
          if (next.done === true) return
          yield Buffer.from(next.value)
        }
      },
    },
  }
}

function exactLengthSource(source: AsyncIterable<Uint8Array>, expected: number): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      let total = 0
      for await (const chunk of source) {
        total += chunk.byteLength
        if (total > expected) throw new GeoResearchError('ATTACHMENT_UPLOAD_INCOMPLETE', 'upload exceeded Content-Length')
        yield chunk
      }
      if (total !== expected) throw new GeoResearchError('ATTACHMENT_UPLOAD_INCOMPLETE', 'upload ended before Content-Length')
    },
  }
}

function uploadHeaders(req: IncomingMessage): UploadHeaders {
  const attachmentId = singleHeader(req, 'x-georesearch-attachment-id') ?? ''
  assertAttachmentId(attachmentId)
  const encodedName = singleHeader(req, 'x-georesearch-file-name')
  if (encodedName === undefined || encodedName.length === 0 || encodedName.length > 1_024) {
    throw new GeoResearchError('ATTACHMENT_INVALID', 'upload requires a bounded encoded file name')
  }
  let decodedName: string
  try {
    decodedName = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encodedName, 'base64url'))
  } catch (error) {
    throw new GeoResearchError('ATTACHMENT_INVALID', 'encoded file name is not valid UTF-8', { cause: error })
  }
  const name = normalizeUploadName(decodedName)
  const browserMediaType = singleHeader(req, 'x-georesearch-browser-media-type')?.trim()
  if (browserMediaType !== undefined && (browserMediaType.length > 255 || !/^[\x20-\x7e]*$/u.test(browserMediaType))) {
    throw new GeoResearchError('ATTACHMENT_INVALID', 'browser media type header is invalid')
  }
  return {
    attachmentId,
    name,
    ...(browserMediaType === undefined || browserMediaType === '' ? {} : { browserMediaType }),
  }
}

function validateBatchHeaders(req: IncomingMessage): void {
  const count = optionalHeaderInteger(req, 'x-georesearch-batch-count')
  const bytes = optionalHeaderInteger(req, 'x-georesearch-batch-bytes')
  if (count !== undefined && (count < 1 || count > GENERIC_ATTACHMENT_LIMITS.maxFilesPerBatch)) {
    throw new GeoResearchError('ATTACHMENT_TOO_LARGE', `upload batch exceeds ${GENERIC_ATTACHMENT_LIMITS.maxFilesPerBatch} files`)
  }
  if (bytes !== undefined && (bytes < 0 || bytes > GENERIC_ATTACHMENT_LIMITS.maxBatchBytes)) {
    throw new GeoResearchError('ATTACHMENT_TOO_LARGE', `upload batch exceeds ${GENERIC_ATTACHMENT_LIMITS.maxBatchBytes} bytes`)
  }
}

function contentLength(req: IncomingMessage): number | undefined {
  const value = singleHeader(req, 'content-length')
  if (value === undefined) return undefined
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new GeoResearchError('ATTACHMENT_INVALID', 'Content-Length is invalid')
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new GeoResearchError('ATTACHMENT_TOO_LARGE', 'Content-Length exceeds safe integer range')
  return parsed
}

function optionalHeaderInteger(req: IncomingMessage, name: string): number | undefined {
  const value = singleHeader(req, name)
  if (value === undefined) return undefined
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) throw new GeoResearchError('ATTACHMENT_INVALID', `${name} is invalid`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new GeoResearchError('ATTACHMENT_INVALID', `${name} is outside safe integer range`)
  return parsed
}

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  if (Array.isArray(value)) throw new GeoResearchError('ATTACHMENT_INVALID', `${name} must appear once`)
  return value
}

function responseJson(res: ServerResponse, status: number, value: unknown): void {
  if (res.headersSent) return
  const body = `${JSON.stringify(value)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function statusFor(code: string): number {
  switch (code) {
    case 'ATTACHMENT_TOO_LARGE': return 413
    case 'ATTACHMENT_NOT_FOUND': return 404
    case 'ATTACHMENT_SESSION_MISMATCH':
    case 'GEORESEARCH_ROLE_MISMATCH': return 403
    case 'ATTACHMENT_INVALID':
    case 'ATTACHMENT_MEDIA_UNREADABLE':
    case 'ATTACHMENT_ARCHIVE_UNSUPPORTED':
    case 'ATTACHMENT_ARCHIVE_UNSAFE':
    case 'ATTACHMENT_UPLOAD_INCOMPLETE': return 400
    default: return 500
  }
}

function normalizeError(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof GeoResearchError) return { code: error.code, message: error.message.slice(error.code.length + 2) }
  if (error instanceof TypeError) return { code: 'ATTACHMENT_INVALID', message: error.message }
  return { code: 'ATTACHMENT_STORAGE_FAILURE', message: 'attachment storage operation failed' }
}

function exactAgent(execution: Pick<ToolExecution, 'agent'>, operation: string): Agent {
  if (execution.agent === undefined) throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', `${operation} requires an exact live Agent`)
  return execution.agent
}

function attachmentIdArg(value: unknown): string {
  const record = objectRecord(value, 'attachment arguments')
  const attachmentId = nonEmptyText(record.attachmentId, 'attachmentId')
  assertAttachmentId(attachmentId)
  return attachmentId
}

function objectRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${field} must be an object`)
  return value as Record<string, unknown>
}

function nonEmptyText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${field} must be non-empty`)
  return value
}

function optionalBoundedText(value: unknown, field: string, maxBytes: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${field} must be non-empty`)
  const normalized = value.trim()
  if (Buffer.byteLength(normalized) > maxBytes) throw new TypeError(`${field} exceeds ${maxBytes} bytes`)
  return normalized
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive integer`)
  return value as number
}

function optionalNonNegativeInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${field} must be a non-negative integer`)
  return value as number
}

function boundedConfig(value: number | undefined, fallback: number, field: string): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > fallback) {
    throw new TypeError(`${field} must be an integer between 1 and ${fallback}`)
  }
  return selected
}

function emptyObjectSchema(): Readonly<Record<string, unknown>> {
  return { type: 'object', additionalProperties: false, properties: {} }
}

function attachmentParameters(): Readonly<Record<string, unknown>> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: { attachmentId: { type: 'string' } },
    required: ['attachmentId'],
  }
}

function openObjectSchema(): Readonly<Record<string, unknown>> {
  return { type: 'object', additionalProperties: true }
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
