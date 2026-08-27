import { useEffect, useRef, useSyncExternalStore, type ChangeEvent } from 'react'
import Check from 'lucide-react/dist/esm/icons/check.js'
import Database from 'lucide-react/dist/esm/icons/database.js'
import File from 'lucide-react/dist/esm/icons/file.js'
import FileArchive from 'lucide-react/dist/esm/icons/file-archive.js'
import FileCode from 'lucide-react/dist/esm/icons/file-code.js'
import FileImage from 'lucide-react/dist/esm/icons/file-image.js'
import FileText from 'lucide-react/dist/esm/icons/file-text.js'
import LoaderCircle from 'lucide-react/dist/esm/icons/loader-circle.js'
import Paperclip from 'lucide-react/dist/esm/icons/paperclip.js'
import RotateCcw from 'lucide-react/dist/esm/icons/rotate-ccw.js'
import X from 'lucide-react/dist/esm/icons/x.js'
import {
  Tooltip,
  type ClientContext,
  type ComposerAttachment,
  type DraftAttachmentId,
  type InputTriggerSource,
  type SessionId,
} from '@georesearch/dsh-compat-rc5/client'
import {
  GeoResearchSteeringMessageView,
  GeoResearchUserMessageView,
  attachmentFormat,
  type AttachmentDisplayMetadata,
} from './message-presentation.js'

export const inject = ['slots', 'sessions', 'conversation', 'inputTriggers']

const FILE_API_PATH = '/api/georesearch/files/v1'
const SOURCE_NAME = 'georesearch-file'
const COMPOSER_LEDGER_KEY_PREFIX = 'georesearch.file-service.composer.v1.'
const COMPOSER_PLACEHOLDER = '\uFFFC'
const LEGACY_DRAFT_SETTLE_MS = 100
const DRAFT_SIGNAL_PREFIX = 'georesearch-file-service:'
const DRAFT_SIGNAL_PREVIEW = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=#georesearch-file-service'
const MAX_FILES_PER_BATCH = 32
const MAX_FILE_BYTES = 256 * 1024 * 1024
const MAX_BATCH_BYTES = 512 * 1024 * 1024
const MAX_CONCURRENT_UPLOADS = 4
const EMPTY_UPLOADS: readonly UploadView[] = Object.freeze([])

interface GenericAttachmentRef {
  readonly schemaVersion: 1
  readonly attachmentId: string
  readonly artifactId: string
  readonly digest: string
  readonly name: string
  readonly size: number
  readonly mediaType: string
  readonly contentKind: string
  readonly readStrategy: string
}

export interface UploadView {
  readonly attachmentId: string
  readonly sessionId: SessionId
  readonly name: string
  readonly mediaType: string
  readonly loaded: number
  readonly total: number
  readonly status: 'restoring' | 'queued' | 'uploading' | 'complete' | 'failed' | 'restore-failed'
  readonly error?: string
}

interface UploadTaskBase {
  readonly attachmentId: string
  readonly sessionId: SessionId
  readonly fileIdentity: string | undefined
  name: string
  mediaType: string
  loaded: number
  total: number
  status: UploadView['status']
  error: string | undefined
  removed: boolean
}

interface LocalUploadTask extends UploadTaskBase {
  readonly origin: 'local'
  readonly file: File
  readonly batchCount: number
  readonly batchBytes: number
  readonly deferred: Deferred<GenericAttachmentRef>
  xhr: XMLHttpRequest | undefined
}

interface RestoredUploadTask extends UploadTaskBase {
  readonly origin: 'restored'
  lookupController: AbortController | undefined
}

type UploadTask = LocalUploadTask | RestoredUploadTask

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
}

interface ComposerAttachmentRecord {
  readonly attachmentId: string
  readonly name: string
  readonly mediaType: string
  readonly fileIdentity?: string
  readonly legacyRef?: string
  readonly legacyOffset?: number
}

interface ComposerAttachmentPayload {
  readonly schemaVersion: 2
  readonly attachments: readonly ComposerAttachmentRecord[]
}

type ComposerStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** Persists Composer attachments independently from the editable draft. */
export class ComposerReferenceLedger {
  private readonly memory = new Map<string, readonly ComposerAttachmentRecord[]>()

  constructor(private readonly storage: ComposerStorage | undefined = browserStorage()) {}

  read(sessionId: SessionId): readonly ComposerAttachmentRecord[] {
    const key = composerLedgerKey(sessionId)
    try {
      const raw = this.storage?.getItem(key)
      if (raw !== undefined && raw !== null) {
        const parsed = parseComposerAttachmentPayload(JSON.parse(raw) as unknown)
        if (parsed !== undefined) {
          this.memory.set(key, parsed.attachments)
          return parsed.attachments
        }
        this.storage?.removeItem(key)
      }
    } catch {
      // Storage and malformed JSON failures degrade to the current in-memory ledger.
    }
    return this.memory.get(key) ?? []
  }

  write(sessionId: SessionId, attachments: readonly ComposerAttachmentRecord[]): void {
    const key = composerLedgerKey(sessionId)
    const normalized = attachments.map(attachment => ({
      attachmentId: attachment.attachmentId,
      name: attachment.name,
      mediaType: attachment.mediaType,
      ...(attachment.fileIdentity === undefined ? {} : { fileIdentity: attachment.fileIdentity }),
    }))
    if (normalized.length === 0) this.memory.delete(key)
    else this.memory.set(key, normalized)
    try {
      if (normalized.length === 0) this.storage?.removeItem(key)
      else this.storage?.setItem(key, JSON.stringify({ schemaVersion: 2, attachments: normalized } satisfies ComposerAttachmentPayload))
    } catch {
      // A private-mode or quota failure must not block Composer input.
    }
  }
}

interface AttachmentButtonProps {
  readonly manager: UploadManager
  readonly sessionId: SessionId
  readonly input: { readonly phase: string }
}

interface UploadDockProps {
  readonly manager: UploadManager
  readonly sessionId: SessionId
  readonly input: {
    readonly draftRev: number
    readonly phase: string
  }
}

export class UploadManager {
  private readonly tasks = new Map<string, UploadTask>()
  private readonly queue: string[] = []
  private readonly settlements = new Map<string, Promise<GenericAttachmentRef>>()
  private readonly completed = new Map<string, GenericAttachmentRef>()
  private readonly snapshots = new Map<SessionId, readonly UploadView[]>()
  private readonly listeners = new Set<() => void>()
  private readonly draftSignals = new Map<SessionId, ComposerAttachment>()
  private readonly draftSignalSessions = new Set<SessionId>()
  private readonly submissionControllers = new Set<AbortController>()
  private readonly legacyDraftTimers = new Map<SessionId, number>()
  private active = 0
  private disposed = false

  constructor(
    private readonly ctx: ClientContext,
    private readonly composerLedger = new ComposerReferenceLedger(),
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  snapshot = (sessionId: SessionId): readonly UploadView[] => this.snapshots.get(sessionId) ?? EMPTY_UPLOADS

  isGeoResearchSession(sessionId: SessionId): boolean {
    return this.ctx.sessions.list.getSnapshot().byId[sessionId]?.agentPreset === 'georesearch'
  }

  isCurrentGeoResearchSession(): boolean {
    const current = this.ctx.sessions.list.getSnapshot().current
    return current !== undefined && this.isGeoResearchSession(current)
  }

  enqueueCurrent(files: readonly File[]): void {
    const current = this.ctx.sessions.list.getSnapshot().current
    if (current === undefined || !this.isGeoResearchSession(current)) return
    this.enqueue(current, files)
  }

  enqueue(sessionId: SessionId, files: readonly File[]): void {
    if (this.disposed || files.length === 0 || !this.isGeoResearchSession(sessionId)) return
    const actx = this.ctx.sessions.scope(sessionId)
    if (actx === undefined) return
    const input = this.ctx.conversation.input.for(actx)
    const phase = input.state.getSnapshot().phase
    if (phase !== 'plain' && phase !== 'claimed') {
      input.notify('error', '当前正在发送消息，请等待发送完成后再添加文件。')
      return
    }
    const acceptedFiles: Array<{ readonly file: File; readonly fileIdentity: string }> = []
    const duplicateNames: string[] = []
    const presentIdentities = new Set(
      [...this.tasks.values()]
        .filter(task => task.sessionId === sessionId && !task.removed && task.fileIdentity !== undefined)
        .map(task => task.fileIdentity as string),
    )
    for (const file of files) {
      const fileIdentity = browserFileIdentity(file)
      if (presentIdentities.has(fileIdentity)) {
        duplicateNames.push(displayName(file))
        continue
      }
      presentIdentities.add(fileIdentity)
      acceptedFiles.push({ file, fileIdentity })
    }
    if (duplicateNames.length > 0) input.notify('info', duplicateFileNotice(duplicateNames))
    if (acceptedFiles.length === 0) return
    try {
      validateBatch(acceptedFiles.map(candidate => candidate.file))
    } catch (error) {
      input.notify('error', error instanceof Error ? error.message : String(error))
      return
    }
    const batchBytes = acceptedFiles.reduce((sum, candidate) => sum + candidate.file.size, 0)
    for (const { file, fileIdentity } of acceptedFiles) {
      const attachmentId = crypto.randomUUID().toLowerCase()
      const deferred = createDeferred<GenericAttachmentRef>()
      void deferred.promise.catch(() => undefined)
      const task: LocalUploadTask = {
        attachmentId,
        sessionId,
        origin: 'local',
        fileIdentity,
        name: displayName(file),
        mediaType: file.type,
        loaded: 0,
        total: file.size,
        status: 'queued',
        error: undefined,
        file,
        batchCount: acceptedFiles.length,
        batchBytes,
        deferred,
        xhr: undefined,
        removed: false,
      }
      this.tasks.set(attachmentId, task)
      this.settlements.set(attachmentId, deferred.promise)
      this.queue.push(attachmentId)
    }
    this.persistSession(sessionId)
    this.syncDraftSignal(sessionId)
    this.publish(sessionId)
    this.pump()
  }

  cancel(attachmentId: string): void {
    this.remove(attachmentId)
  }

  remove(attachmentId: string): void {
    const task = this.tasks.get(attachmentId)
    if (task === undefined) return
    this.discard(task)
    this.persistSession(task.sessionId)
    this.syncDraftSignal(task.sessionId)
  }

  reconcile(sessionId: SessionId): void {
    this.reconcileState(sessionId, false)
  }

  private reconcileState(sessionId: SessionId, legacyDraftSettled: boolean): void {
    if (this.disposed || !this.isGeoResearchSession(sessionId)) return
    const actx = this.ctx.sessions.scope(sessionId)
    if (actx === undefined) return
    const input = this.ctx.conversation.input.for(actx)
    const persistedRecords = this.composerLedger.read(sessionId)
    const hasLegacyDraftOffsets = persistedRecords.some(attachment => attachment.legacyOffset !== undefined)
    if (hasLegacyDraftOffsets && input.state.getSnapshot().draft === '' && !legacyDraftSettled) {
      if (!this.legacyDraftTimers.has(sessionId)) {
        const timer = window.setTimeout(() => {
          this.legacyDraftTimers.delete(sessionId)
          this.reconcileState(sessionId, true)
        }, LEGACY_DRAFT_SETTLE_MS)
        this.legacyDraftTimers.set(sessionId, timer)
      }
      return
    }
    this.cancelLegacyDraftTimer(sessionId)
    const persisted = this.recoverLegacyAttachments(sessionId, input, persistedRecords)
    const persistedByAttachment = new Map(persisted.map(attachment => [attachment.attachmentId, attachment]))
    for (const task of [...this.tasks.values()]) {
      if (task.sessionId === sessionId && !persistedByAttachment.has(task.attachmentId)) this.discard(task, false)
    }
    for (const [attachmentId, attachment] of persistedByAttachment) {
      if (this.tasks.has(attachmentId)) continue
      const task: RestoredUploadTask = {
        attachmentId,
        sessionId,
        origin: 'restored',
        fileIdentity: attachment.fileIdentity,
        name: attachment.name,
        mediaType: attachment.mediaType,
        loaded: 0,
        total: 0,
        status: 'restoring',
        error: undefined,
        removed: false,
        lookupController: undefined,
      }
      this.tasks.set(attachmentId, task)
      this.publish(sessionId)
      this.hydrate(task)
    }
    this.persistSession(sessionId)
    this.syncDraftSignal(sessionId)
    this.publish(sessionId)
  }

  retry(attachmentId: string): void {
    const prior = this.tasks.get(attachmentId)
    if (prior === undefined || prior.origin !== 'local' || prior.status !== 'failed' || this.disposed) return
    const deferred = createDeferred<GenericAttachmentRef>()
    void deferred.promise.catch(() => undefined)
    const next: LocalUploadTask = {
      ...prior,
      loaded: 0,
      status: 'queued',
      deferred,
      removed: false,
    }
    next.error = undefined
    next.xhr = undefined
    this.tasks.set(attachmentId, next)
    this.settlements.set(attachmentId, deferred.promise)
    this.queue.push(attachmentId)
    this.publish(next.sessionId)
    this.pump()
  }

  async serialize(ref: string, signal: AbortSignal): Promise<string> {
    const identity = parseReference(ref)
    const cached = this.completed.get(identity.attachmentId)
    const attachment = cached ?? await this.resolveReference(identity, signal)
    if (attachment.attachmentId !== identity.attachmentId) throw new Error('上传响应的附件身份不一致')
    return attachmentXml(attachment)
  }

  async serializeSession(sessionId: SessionId): Promise<{
    readonly attachmentIds: readonly string[]
    readonly text: string
  }> {
    const tasks = [...this.tasks.values()].filter(task => task.sessionId === sessionId && !task.removed)
    if (tasks.length === 0) return { attachmentIds: [], text: '' }
    const controller = new AbortController()
    this.submissionControllers.add(controller)
    try {
      const attachments = await Promise.all(tasks.map(task => this.resolveReference({
        sessionId,
        attachmentId: task.attachmentId,
      }, controller.signal)))
      return {
        attachmentIds: tasks.map(task => task.attachmentId),
        text: attachments.map(attachmentXml).join('\n'),
      }
    } catch (error) {
      const actx = this.ctx.sessions.scope(sessionId)
      if (actx !== undefined && !controller.signal.aborted) {
        const message = error instanceof Error ? error.message : String(error)
        this.ctx.conversation.input.for(actx).notify('error', `附件无法发送：${message}`)
      }
      throw error
    } finally {
      this.submissionControllers.delete(controller)
    }
  }

  commitSubmitted(sessionId: SessionId, attachmentIds: readonly string[]): void {
    const submitted = new Set(attachmentIds)
    for (const task of [...this.tasks.values()]) {
      if (task.sessionId === sessionId && submitted.has(task.attachmentId)) this.discard(task, false)
    }
    this.persistSession(sessionId)
    this.syncDraftSignal(sessionId)
    this.publish(sessionId)
  }

  hasAttachments(sessionId: SessionId): boolean {
    return [...this.tasks.values()].some(task => task.sessionId === sessionId && !task.removed)
  }

  isDraftSignal(id: DraftAttachmentId): boolean {
    return String(id).startsWith(DRAFT_SIGNAL_PREFIX)
  }

  draftSignalAttachment(id: DraftAttachmentId): ComposerAttachment | undefined {
    if (!this.isDraftSignal(id)) return undefined
    const sessionId = String(id).slice(DRAFT_SIGNAL_PREFIX.length) as SessionId
    if (!this.hasAttachments(sessionId)) return undefined
    let attachment = this.draftSignals.get(sessionId)
    if (attachment === undefined) {
      attachment = {
        kind: 'image',
        id,
        file: new globalThis.File([], 'GeoResearch files', { type: 'image/gif' }),
        previewUrl: DRAFT_SIGNAL_PREVIEW,
      }
      this.draftSignals.set(sessionId, attachment)
    }
    return attachment
  }

  ensureDraftSignal(sessionId: SessionId): void {
    this.syncDraftSignal(sessionId)
  }

  async resolveAttachment(
    sessionId: SessionId,
    attachmentId: string,
    signal: AbortSignal,
  ): Promise<GenericAttachmentRef> {
    const cached = this.completed.get(attachmentId)
    if (cached !== undefined) return cached
    const attachment = await this.resolveReference({ sessionId, attachmentId }, signal)
    if (attachment.attachmentId !== attachmentId) throw new Error('附件状态响应的身份不一致')
    return attachment
  }

  clipboardText(ref: string): string {
    const identity = parseReference(ref)
    return `@file:${identity.attachmentId}`
  }

  dispose(): void {
    this.disposed = true
    for (const timer of this.legacyDraftTimers.values()) window.clearTimeout(timer)
    this.legacyDraftTimers.clear()
    for (const controller of this.submissionControllers) controller.abort()
    this.submissionControllers.clear()
    for (const task of this.tasks.values()) {
      task.removed = true
      if (task.origin === 'local') task.xhr?.abort()
      else task.lookupController?.abort()
    }
    for (const sessionId of this.draftSignalSessions) this.removeDraftSignal(sessionId)
    this.draftSignals.clear()
    this.draftSignalSessions.clear()
    this.listeners.clear()
  }

  private async resolveReference(
    identity: { readonly sessionId: SessionId; readonly attachmentId: string },
    signal: AbortSignal,
  ): Promise<GenericAttachmentRef> {
    const pending = this.settlements.get(identity.attachmentId)
    if (pending !== undefined) return await abortable(pending, signal)
    const response = await fetch(`${FILE_API_PATH}/${encodeURIComponent(identity.attachmentId)}`, {
      method: 'GET',
      headers: { 'x-georesearch-session-id': String(identity.sessionId) },
      cache: 'no-store',
      signal,
    })
    const payload = await response.json() as GenericAttachmentRef | { readonly error?: { readonly message?: string } }
    if (!response.ok) throw new Error(errorMessage(payload, `附件状态读取失败 (${response.status})`))
    const attachment = payload as GenericAttachmentRef
    this.completed.set(attachment.attachmentId, attachment)
    return attachment
  }

  private pump(): void {
    while (!this.disposed && this.active < MAX_CONCURRENT_UPLOADS) {
      const attachmentId = this.queue.shift()
      if (attachmentId === undefined) return
      const task = this.tasks.get(attachmentId)
      if (task === undefined || task.origin !== 'local' || task.status !== 'queued') continue
      this.active += 1
      this.upload(task)
    }
  }

  private upload(task: LocalUploadTask): void {
    const xhr = new XMLHttpRequest()
    task.xhr = xhr
    task.status = 'uploading'
    this.publish(task.sessionId)
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      task.xhr = undefined
      this.active -= 1
      this.pump()
    }
    const fail = (error: Error): void => {
      if (settled) return
      this.fail(task, error)
      finish()
    }
    xhr.open('POST', FILE_API_PATH)
    xhr.responseType = 'json'
    xhr.timeout = 10 * 60 * 1_000
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.setRequestHeader('x-georesearch-session-id', String(task.sessionId))
    xhr.setRequestHeader('x-georesearch-attachment-id', task.attachmentId)
    xhr.setRequestHeader('x-georesearch-file-name', encodeFileName(task.name))
    xhr.setRequestHeader('x-georesearch-browser-media-type', task.file.type)
    xhr.setRequestHeader('x-georesearch-batch-count', String(task.batchCount))
    xhr.setRequestHeader('x-georesearch-batch-bytes', String(task.batchBytes))
    xhr.upload.onprogress = (event) => {
      task.loaded = event.lengthComputable ? Math.min(event.loaded, task.total) : event.loaded
      this.publish(task.sessionId)
    }
    xhr.onerror = () => { fail(new Error('网络错误导致上传失败')) }
    xhr.ontimeout = () => { fail(new Error('上传超时')) }
    xhr.onabort = () => {
      if (task.removed || this.disposed) {
        task.deferred.reject(new Error('上传已取消'))
        finish()
        return
      }
      fail(new Error('上传已取消'))
    }
    xhr.onload = () => {
      if (settled) return
      if (task.removed || this.disposed) {
        task.deferred.reject(new Error('上传已取消'))
        finish()
        return
      }
      const payload = responsePayload(xhr)
      if (xhr.status < 200 || xhr.status >= 300) {
        fail(new Error(errorMessage(payload, `上传失败 (${xhr.status})`)))
        return
      }
      const attachment = payload as GenericAttachmentRef
      if (attachment.attachmentId !== task.attachmentId) {
        fail(new Error('上传响应的附件身份不一致'))
        return
      }
      task.status = 'complete'
      task.loaded = task.total
      task.mediaType = attachment.mediaType
      this.completed.set(task.attachmentId, attachment)
      task.deferred.resolve(attachment)
      this.persistSession(task.sessionId)
      this.publish(task.sessionId)
      finish()
    }
    xhr.send(task.file)
  }

  private fail(task: LocalUploadTask, error: Error): void {
    if (task.removed) return
    task.status = 'failed'
    task.error = error.message
    task.xhr = undefined
    task.deferred.reject(error)
    this.publish(task.sessionId)
    const actx = this.ctx.sessions.scope(task.sessionId)
    if (actx !== undefined) this.ctx.conversation.input.for(actx).notify('error', `${task.name}: ${error.message}`)
  }

  private discard(task: UploadTask, publishNow = true): void {
    if (task.removed) return
    task.removed = true
    this.tasks.delete(task.attachmentId)
    this.settlements.delete(task.attachmentId)
    this.completed.delete(task.attachmentId)
    if (task.origin === 'local') task.deferred.reject(new Error('上传已取消'))
    else task.lookupController?.abort()
    if (publishNow) this.publish(task.sessionId)
    if (task.origin === 'local' && task.xhr !== undefined) task.xhr.abort()
    else this.pump()
  }

  private hydrate(task: RestoredUploadTask): void {
    const controller = new AbortController()
    task.lookupController = controller
    void this.resolveReference({ sessionId: task.sessionId, attachmentId: task.attachmentId }, controller.signal)
      .then(attachment => {
        if (this.disposed || task.removed || this.tasks.get(task.attachmentId) !== task) {
          this.completed.delete(task.attachmentId)
          return
        }
        task.lookupController = undefined
        task.name = attachment.name
        task.mediaType = attachment.mediaType
        task.loaded = attachment.size
        task.total = attachment.size
        task.status = 'complete'
        task.error = undefined
        this.persistSession(task.sessionId)
        this.publish(task.sessionId)
      })
      .catch(error => {
        if (this.disposed || task.removed || controller.signal.aborted || this.tasks.get(task.attachmentId) !== task) return
        task.lookupController = undefined
        task.status = 'restore-failed'
        task.error = error instanceof Error ? error.message : String(error)
        this.publish(task.sessionId)
      })
  }

  private recoverLegacyAttachments(
    sessionId: SessionId,
    input: ReturnType<ClientContext['conversation']['input']['for']>,
    persisted: readonly ComposerAttachmentRecord[],
  ): readonly ComposerAttachmentRecord[] {
    const attachments = new Map(persisted.map(attachment => [attachment.attachmentId, attachment]))
    const state = input.state.getSnapshot()
    for (const occurrence of state.occurrences) {
      if (occurrence.source !== SOURCE_NAME) continue
      try {
        const identity = parseReference(occurrence.ref)
        if (identity.sessionId !== sessionId || attachments.has(identity.attachmentId)) continue
        attachments.set(identity.attachmentId, {
          attachmentId: identity.attachmentId,
          name: restoredDisplayName(occurrence.label, identity.attachmentId),
          mediaType: 'application/octet-stream',
          legacyRef: occurrence.ref,
          legacyOffset: occurrence.offset,
        })
      } catch {
        // A damaged legacy chip cannot identify an attachment and stays visible for manual removal.
      }
    }
    this.removeLegacyDraftCells(input, sessionId, persisted)
    return [...attachments.values()]
  }

  private removeLegacyDraftCells(
    input: ReturnType<ClientContext['conversation']['input']['for']>,
    sessionId: SessionId,
    persisted: readonly ComposerAttachmentRecord[],
  ): void {
    const liveOffsets: number[] = []
    for (const occurrence of input.state.getSnapshot().occurrences) {
      if (occurrence.source !== SOURCE_NAME) continue
      try {
        if (parseReference(occurrence.ref).sessionId === sessionId) liveOffsets.push(occurrence.offset)
      } catch {
        // Damaged chips are not deleted automatically because ownership cannot be established.
      }
    }
    const offsets = [...new Set([
      ...liveOffsets,
      ...persisted.flatMap(attachment => attachment.legacyOffset === undefined ? [] : [attachment.legacyOffset]),
    ])].sort((left, right) => right - left)
    const preciseInput = input as typeof input & {
      setDraft(
        text: string,
        editRange: { readonly start: number; readonly end: number; readonly insertedLength: number },
      ): void
    }
    for (const offset of offsets) {
      const current = input.state.getSnapshot()
      if (current.draft[offset] !== COMPOSER_PLACEHOLDER) continue
      const end = current.draft[offset + 1] === ' ' ? offset + 2 : offset + 1
      preciseInput.setDraft(`${current.draft.slice(0, offset)}${current.draft.slice(end)}`, {
        start: offset,
        end,
        insertedLength: 0,
      })
    }
  }

  private persistSession(sessionId: SessionId): void {
    this.composerLedger.write(sessionId, [...this.tasks.values()]
      .filter(task => task.sessionId === sessionId && !task.removed)
      .map(task => ({
        attachmentId: task.attachmentId,
        name: task.name,
        mediaType: task.mediaType,
        ...(task.fileIdentity === undefined ? {} : { fileIdentity: task.fileIdentity }),
      })))
  }

  private cancelLegacyDraftTimer(sessionId: SessionId): void {
    const timer = this.legacyDraftTimers.get(sessionId)
    if (timer === undefined) return
    window.clearTimeout(timer)
    this.legacyDraftTimers.delete(sessionId)
  }

  private syncDraftSignal(sessionId: SessionId): void {
    const actx = this.ctx.sessions.scope(sessionId)
    if (actx === undefined) return
    const input = this.ctx.conversation.input.for(actx)
    const signalId = draftSignalId(sessionId)
    const present = input.state.getSnapshot().imageIds.includes(signalId)
    if (this.hasAttachments(sessionId)) {
      if (!present && input.addImages([signalId])) this.draftSignalSessions.add(sessionId)
      return
    }
    if (present) input.removeImage(signalId)
    this.draftSignalSessions.delete(sessionId)
    this.draftSignals.delete(sessionId)
  }

  private removeDraftSignal(sessionId: SessionId): void {
    const actx = this.ctx.sessions.scope(sessionId)
    if (actx !== undefined) this.ctx.conversation.input.for(actx).removeImage(draftSignalId(sessionId))
  }

  private publish(sessionId: SessionId): void {
    const next = [...this.tasks.values()]
      .filter(task => task.sessionId === sessionId)
      .map(task => ({
        attachmentId: task.attachmentId,
        sessionId: task.sessionId,
        name: task.name,
        mediaType: task.mediaType,
        loaded: task.loaded,
        total: task.total,
        status: task.status,
        ...(task.error === undefined ? {} : { error: task.error }),
      } satisfies UploadView))
    this.snapshots.set(sessionId, next)
    for (const listener of this.listeners) listener()
  }
}

interface ConversationSubmissionFace {
  draftImages: (ids: readonly DraftAttachmentId[]) => readonly ComposerAttachment[]
  sendSession: (
    session: { readonly sessionId: SessionId },
    text: string,
    imageIds: readonly DraftAttachmentId[],
    mode: 'queue' | 'steer',
  ) => Promise<void>
}

/** Adds GeoResearch attachments to the send transaction without writing into the Composer draft. */
export function installConversationSubmissionBridge(ctx: ClientContext, manager: UploadManager): () => void {
  const conversation = ctx.get('conversation') as ConversationSubmissionFace | undefined
  if (conversation === undefined) throw new Error('georesearch-file-service: conversation service unavailable')
  const originalDraftImages = conversation.draftImages
  const originalSendSession = conversation.sendSession
  const draftImages = (ids: readonly DraftAttachmentId[]): readonly ComposerAttachment[] => {
    const native = originalDraftImages.call(conversation, ids.filter(id => !manager.isDraftSignal(id)))
    const nativeById = new Map(native.map(attachment => [attachment.id, attachment]))
    return ids.flatMap((id) => {
      const signal = manager.draftSignalAttachment(id)
      if (signal !== undefined) return [signal]
      const attachment = nativeById.get(id)
      return attachment === undefined ? [] : [attachment]
    })
  }
  const sendSession: ConversationSubmissionFace['sendSession'] = async (session, text, imageIds, mode) => {
    const nativeImageIds = imageIds.filter(id => !manager.isDraftSignal(id))
    if (!manager.hasAttachments(session.sessionId)) {
      await originalSendSession.call(conversation, session, text, nativeImageIds, mode)
      return
    }
    try {
      const submission = await manager.serializeSession(session.sessionId)
      if (submission.attachmentIds.length === 0) {
        await originalSendSession.call(conversation, session, text, nativeImageIds, mode)
        return
      }
      const serializedText = text === '' ? submission.text : `${text}\n\n${submission.text}`
      await originalSendSession.call(conversation, session, serializedText, nativeImageIds, mode)
      manager.commitSubmitted(session.sessionId, submission.attachmentIds)
    } catch (error) {
      manager.ensureDraftSignal(session.sessionId)
      throw error
    }
  }
  conversation.draftImages = draftImages
  conversation.sendSession = sendSession
  return () => {
    if (conversation.draftImages === draftImages) conversation.draftImages = originalDraftImages
    if (conversation.sendSession === sendSession) conversation.sendSession = originalSendSession
  }
}

export function apply(ctx: ClientContext): void {
  const manager = new UploadManager(ctx)
  ctx.effect(() => () => { manager.dispose() }, 'georesearch-file-service: upload manager')
  ctx.effect(
    () => installConversationSubmissionBridge(ctx, manager),
    'georesearch-file-service: Composer submission bridge',
  )
  ctx.effect(() => installStyles(), 'georesearch-file-service: styles')
  ctx.effect(() => installDocumentDrop(ctx, manager), 'georesearch-file-service: document drop')
  ctx.effect(() => installMessagePresentation(ctx, manager), 'georesearch-file-service: message presentation')
  const source: InputTriggerSource = {
    trigger: '@',
    name: SOURCE_NAME,
    order: 1_000,
    candidates: async () => [],
    onPick: () => undefined,
    codec: {
      clipboardText: ref => manager.clipboardText(ref),
      serialize: (ref, signal) => manager.serialize(ref, signal),
    },
  }
  ctx.effect(() => ctx.inputTriggers.registerSource(source), 'georesearch-file-service: reference codec')

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'georesearch-files',
    order: 40,
    inject: (sessionId): Pick<AttachmentButtonProps, 'manager' | 'sessionId'> => ({ manager, sessionId }),
  }, AttachmentButton))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'georesearch-file-progress',
    order: 40,
    inject: (sessionId): Pick<UploadDockProps, 'manager' | 'sessionId'> => ({ manager, sessionId }),
  }, UploadDock))
}

function installMessagePresentation(ctx: ClientContext, manager: UploadManager): () => void {
  let disposeRenderers: (() => void) | undefined
  const sync = (): void => {
    const active = manager.isCurrentGeoResearchSession()
    if (active && disposeRenderers === undefined) {
      disposeRenderers = ctx.slots.inject('conversation.chat.node', function* () {
        const inject = (sessionId: SessionId): {
          readonly resolveAttachment: (
            attachmentId: string,
            signal: AbortSignal,
          ) => Promise<AttachmentDisplayMetadata>
        } => ({
          resolveAttachment: (attachmentId, signal) => manager.resolveAttachment(sessionId, attachmentId, signal),
        })
        yield ctx.slots.register({
          name: 'conversation.chat.node',
          key: 'user',
          priority: -100,
          locale: 'conversation',
          inject,
        }, GeoResearchUserMessageView)
        yield ctx.slots.register({
          name: 'conversation.chat.node',
          key: 'steering',
          priority: -100,
          locale: 'conversation',
          inject,
        }, GeoResearchSteeringMessageView)
      })
      return
    }
    if (!active && disposeRenderers !== undefined) {
      disposeRenderers()
      disposeRenderers = undefined
    }
  }
  const unsubscribe = ctx.sessions.list.subscribe(sync)
  sync()
  return () => {
    unsubscribe()
    disposeRenderers?.()
    disposeRenderers = undefined
  }
}

function AttachmentButton({ manager, sessionId, input }: AttachmentButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const uploads = useSyncExternalStore(manager.subscribe, () => manager.snapshot(sessionId), () => EMPTY_UPLOADS)
  if (!manager.isGeoResearchSession(sessionId)) return null
  const disabled = input.phase !== 'plain' && input.phase !== 'claimed'
  const active = uploads.filter(upload => upload.status === 'queued' || upload.status === 'uploading').length
  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    manager.enqueue(sessionId, files)
  }
  return (
    <Tooltip label="上传文件" side="bottom" delayMs={500}>
      <span className="georesearch-file-button-wrap">
        <button
          type="button"
          className="georesearch-file-button"
          aria-label="上传文件"
          disabled={disabled}
          onClick={() => { inputRef.current?.click() }}
        >
          <Paperclip size={16} strokeWidth={1.8} />
          {active > 0 && <span className="georesearch-file-badge">{active}</span>}
        </button>
        <input ref={inputRef} className="georesearch-file-input" type="file" multiple onChange={onChange} />
      </span>
    </Tooltip>
  )
}

function UploadDock({ manager, sessionId, input }: UploadDockProps) {
  const uploads = useSyncExternalStore(manager.subscribe, () => manager.snapshot(sessionId), () => EMPTY_UPLOADS)
  useEffect(() => {
    manager.reconcile(sessionId)
  }, [input.draftRev, input.phase, manager, sessionId])
  if (uploads.length === 0) return null
  return (
    <div className="georesearch-upload-dock" aria-live="polite">
      {uploads.map(upload => {
        const percent = upload.total === 0 ? 100 : Math.min(100, Math.round(upload.loaded / upload.total * 100))
        const format = attachmentFormat(upload.name, upload.mediaType)
        const tone = uploadTone(format, upload.mediaType)
        const FileIcon = uploadIcon(tone)
        const status = upload.status === 'failed'
          ? '上传失败'
          : upload.status === 'restore-failed'
            ? '恢复失败'
            : upload.status === 'complete'
              ? '上传成功'
              : upload.status === 'restoring'
                ? '正在恢复'
                : upload.status === 'queued'
                  ? '等待上传'
                  : `正在上传 ${percent}%`
        return (
          <div
            className={`georesearch-upload-row georesearch-upload-${upload.status}`}
            data-tone={tone}
            key={upload.attachmentId}
          >
            <span className="georesearch-upload-file-icon" aria-hidden="true">
              <FileIcon size={18} strokeWidth={1.8} />
            </span>
            <span className="georesearch-upload-details">
              <span className="georesearch-upload-name" title={upload.name}>{upload.name}</span>
              <span className="georesearch-upload-meta">
                <span className="georesearch-upload-format">{format}</span>
                <span className="georesearch-upload-state" title={upload.error}>
                  <span className="georesearch-upload-state-icon" aria-hidden="true">
                    {upload.status === 'complete'
                      ? <Check size={13} />
                      : upload.status === 'failed' || upload.status === 'restore-failed'
                        ? <X size={13} />
                        : <LoaderCircle size={13} className={upload.status === 'uploading' || upload.status === 'restoring' ? 'georesearch-upload-spin' : ''} />}
                  </span>
                  <span className="georesearch-upload-status">{status}</span>
                </span>
              </span>
            </span>
            {(upload.status === 'queued' || upload.status === 'uploading' || upload.status === 'restoring') && (
              <span className="georesearch-upload-track" aria-hidden="true">
                <span style={{ width: `${percent}%` }} />
              </span>
            )}
            <span className="georesearch-upload-actions">
              {upload.status === 'failed' && (
                <Tooltip label="重试" side="bottom" delayMs={400}>
                  <button type="button" className="georesearch-upload-action" aria-label={`重试 ${upload.name}`} onClick={() => { manager.retry(upload.attachmentId) }}>
                    <RotateCcw size={14} />
                  </button>
                </Tooltip>
              )}
              <Tooltip label="删除附件" side="bottom" delayMs={400}>
                <button type="button" className="georesearch-upload-action" aria-label={`删除 ${upload.name}`} onClick={() => { manager.remove(upload.attachmentId) }}>
                  <X size={14} />
                </button>
              </Tooltip>
            </span>
          </div>
        )
      })}
    </div>
  )
}

function uploadTone(format: string, mediaType: string): 'pdf' | 'archive' | 'data' | 'image' | 'code' | 'document' {
  const normalized = format.toLowerCase()
  if (normalized === 'pdf') return 'pdf'
  if (['zip', 'tar', 'tar.gz', 'tar.bz2', 'tar.xz', '7z', 'rar', 'gz', 'bz2', 'xz'].includes(normalized)) return 'archive'
  if (mediaType.startsWith('image/')) return 'image'
  if (['csv', 'tsv', 'xls', 'xlsx', 'sqlite', 'db', 'h5', 'hdf5', 'nc', 'netcdf', 'parquet'].includes(normalized)) return 'data'
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
  ].includes(normalized)) return 'code'
  return 'document'
}

function uploadIcon(tone: ReturnType<typeof uploadTone>): typeof File {
  switch (tone) {
    case 'archive': return FileArchive
    case 'data': return Database
    case 'image': return FileImage
    case 'code': return FileCode
    case 'pdf':
    case 'document': return FileText
  }
}

export function shouldUseNativeImageHandling(_files: readonly Pick<File, 'type'>[]): boolean {
  return false
}

export function shouldInterceptDataTransfer(transfer: DataTransfer): boolean {
  const items = Array.from(transfer.items).filter(item => item.kind === 'file')
  if (items.length === 0) return Array.from(transfer.types).includes('Files')
  return true
}

/** Installs GeoResearch file-drop routing on this Harness document and returns its disposer. */
export function installDocumentDrop(ctx: ClientContext, manager: UploadManager): () => void {
  const overlay = document.createElement('div')
  overlay.className = 'georesearch-drop-overlay'
  overlay.textContent = '释放以上传文件'
  overlay.hidden = true
  document.body.appendChild(overlay)
  let depth = 0
  const show = (): void => { overlay.hidden = false }
  const hide = (): void => { depth = 0; overlay.hidden = true }
  const dragenter = (event: DragEvent): void => {
    if (!manager.isCurrentGeoResearchSession()
      || event.dataTransfer === null
      || !shouldInterceptDataTransfer(event.dataTransfer)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    depth += 1
    show()
  }
  const dragover = (event: DragEvent): void => {
    if (!manager.isCurrentGeoResearchSession()
      || event.dataTransfer === null
      || !shouldInterceptDataTransfer(event.dataTransfer)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    event.dataTransfer.dropEffect = 'copy'
  }
  const dragleave = (event: DragEvent): void => {
    if (!manager.isCurrentGeoResearchSession()
      || event.dataTransfer === null
      || !shouldInterceptDataTransfer(event.dataTransfer)) return
    event.stopImmediatePropagation()
    if (overlay.hidden) return
    depth = Math.max(0, depth - 1)
    if (depth === 0) overlay.hidden = true
  }
  const drop = (event: DragEvent): void => {
    hide()
    if (!manager.isCurrentGeoResearchSession()) return
    const files = Array.from(event.dataTransfer?.files ?? [])
    if (files.length === 0) return
    event.preventDefault()
    event.stopImmediatePropagation()
    window.dispatchEvent(new Event('dragend'))
    manager.enqueueCurrent(files)
  }
  document.addEventListener('dragenter', dragenter, true)
  document.addEventListener('dragover', dragover, true)
  document.addEventListener('dragleave', dragleave, true)
  document.addEventListener('drop', drop, true)
  window.addEventListener('dragend', hide)
  return () => {
    document.removeEventListener('dragenter', dragenter, true)
    document.removeEventListener('dragover', dragover, true)
    document.removeEventListener('dragleave', dragleave, true)
    document.removeEventListener('drop', drop, true)
    window.removeEventListener('dragend', hide)
    overlay.remove()
    void ctx
  }
}

function installStyles(): () => void {
  const style = document.createElement('style')
  style.dataset.plugin = '@georesearch/dsh-file-service'
  style.textContent = `
[data-composer-card] [role="group"]>div:has(>button>img[src$="#georesearch-file-service"]){display:none!important}
[data-composer-card]>div:has(>div>[role="group"]>div:only-child>button>img[src$="#georesearch-file-service"]){display:none!important}
.georesearch-file-button-wrap{position:relative;display:inline-flex;width:28px;height:28px;flex:0 0 28px}
.georesearch-file-button{position:relative;display:inline-grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--text-secondary,#667085);cursor:pointer}
.georesearch-file-button:hover:not(:disabled){background:var(--bg-hover,rgba(16,24,40,.06));color:var(--text-primary,#101828)}
.georesearch-file-button:focus-visible{outline:2px solid var(--color-primary,#2563eb);outline-offset:2px}
.georesearch-file-button:disabled{opacity:.42;cursor:not-allowed}
.georesearch-file-input{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.georesearch-file-badge{position:absolute;top:-3px;right:-4px;display:grid;place-items:center;min-width:14px;height:14px;padding:0 3px;border:2px solid var(--bg-primary,#fff);border-radius:7px;background:#2563eb;color:#fff;font:600 9px/1 system-ui;letter-spacing:0}
.georesearch-upload-dock{box-sizing:border-box;display:flex;flex:none;flex-wrap:nowrap;align-self:center;align-items:flex-start;gap:6px;width:calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px));max-width:var(--dsh-composer-card-max-width,780px);margin:0 auto;padding:0 0 5px;overflow-x:auto;overflow-y:hidden;overscroll-behavior-inline:contain;scrollbar-width:thin;scrollbar-color:var(--text-tertiary,rgba(102,112,133,.55)) transparent}
.georesearch-upload-dock::-webkit-scrollbar{height:6px}
.georesearch-upload-dock::-webkit-scrollbar-track{background:transparent}
.georesearch-upload-dock::-webkit-scrollbar-thumb{border-radius:3px;background:var(--text-tertiary,rgba(102,112,133,.55))}
.georesearch-upload-row{position:relative;display:grid;grid-template-columns:32px minmax(0,1fr);align-items:center;column-gap:8px;flex:0 0 260px;width:260px;max-width:100%;min-width:0;height:52px;box-sizing:border-box;padding:7px 30px 7px 8px;border:1px solid var(--border-subtle,rgba(16,24,40,.12));border-radius:7px;background:var(--bg-primary,#fff);font-size:12px;letter-spacing:0}
.georesearch-upload-failed{padding-right:54px}
.georesearch-upload-file-icon{display:grid;place-items:center;width:32px;height:32px;border-radius:6px;background:rgba(71,84,103,.09);color:#475467}
.georesearch-upload-row[data-tone="pdf"] .georesearch-upload-file-icon{background:rgba(180,35,24,.09);color:#b42318}
.georesearch-upload-row[data-tone="archive"] .georesearch-upload-file-icon{background:rgba(181,71,8,.1);color:#b54708}
.georesearch-upload-row[data-tone="data"] .georesearch-upload-file-icon{background:rgba(6,118,71,.09);color:#067647}
.georesearch-upload-row[data-tone="code"] .georesearch-upload-file-icon{background:rgba(23,92,211,.09);color:#175cd3}
.georesearch-upload-row[data-tone="image"] .georesearch-upload-file-icon{background:rgba(105,65,198,.09);color:#6941c6}
.georesearch-upload-details{display:grid;grid-template-rows:18px 16px;align-content:center;min-width:0}
.georesearch-upload-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-primary,#101828);font-weight:500;line-height:18px}
.georesearch-upload-meta{display:flex;align-items:center;gap:6px;min-width:0;color:var(--text-secondary,#667085);font-size:11px;line-height:16px}
.georesearch-upload-format{flex:0 0 auto;color:inherit;font:600 10px/16px system-ui;letter-spacing:0}
.georesearch-upload-state{display:inline-flex;align-items:center;gap:3px;min-width:0;color:#2563eb}
.georesearch-upload-complete .georesearch-upload-state{color:#15803d}
.georesearch-upload-failed .georesearch-upload-state,.georesearch-upload-restore-failed .georesearch-upload-state{color:#b42318}
.georesearch-upload-state-icon{display:grid;place-items:center;width:13px;height:13px;flex:0 0 13px}
.georesearch-upload-status{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:inherit;font-variant-numeric:tabular-nums}
.georesearch-upload-track{position:absolute;right:8px;bottom:3px;left:8px;display:block;height:2px;overflow:hidden;border-radius:1px;background:rgba(102,112,133,.18)}
.georesearch-upload-track>span{display:block;height:100%;background:#2563eb;transition:width .15s linear}
.georesearch-upload-complete .georesearch-upload-track>span{background:#15803d}
.georesearch-upload-failed .georesearch-upload-track>span,.georesearch-upload-restore-failed .georesearch-upload-track>span{background:#b42318}
.georesearch-upload-actions{position:absolute;top:4px;right:4px;display:flex;align-items:center;justify-content:flex-end;gap:1px}
.georesearch-upload-action{display:grid;place-items:center;width:22px;height:22px;padding:0;border:0;border-radius:5px;background:transparent;color:var(--text-secondary,#667085);cursor:pointer}
.georesearch-upload-action:hover{background:var(--bg-hover,rgba(16,24,40,.06));color:var(--text-primary,#101828)}
.georesearch-upload-spin{animation:georesearch-upload-spin .9s linear infinite}
.georesearch-drop-overlay{position:fixed;inset:12px;z-index:2147483000;display:grid;place-items:center;border:2px dashed #2563eb;border-radius:8px;background:rgba(255,255,255,.92);color:#1d4ed8;font:600 16px/1.4 system-ui;letter-spacing:0;pointer-events:none}
.georesearch-drop-overlay[hidden]{display:none}
.georesearch-message-row{display:flex;flex-direction:column;align-items:flex-end;gap:6px;min-width:0}
.georesearch-message-stack{display:flex;flex-direction:column;align-items:flex-end;gap:8px;min-width:0;max-width:min(525px,82%)}
.georesearch-message-files{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:6px;width:100%}
.georesearch-message-file{display:grid;grid-template-columns:32px minmax(0,1fr) auto;align-items:center;gap:9px;width:min(360px,100%);min-height:48px;padding:7px 9px;border:1px solid var(--dsw-alias-stroke-subtle,rgba(16,24,40,.14));border-radius:8px;background:var(--dsw-alias-bg-layer-1,var(--bg-primary,#fff));color:var(--dsw-alias-label-primary,var(--text-primary,#101828));font:500 13px/18px system-ui;letter-spacing:0}
.georesearch-message-file-icon{display:grid;place-items:center;width:32px;height:32px;border-radius:6px;background:rgba(71,84,103,.09);color:#475467}
.georesearch-message-file[data-tone="pdf"] .georesearch-message-file-icon{background:rgba(180,35,24,.09);color:#b42318}
.georesearch-message-file[data-tone="archive"] .georesearch-message-file-icon{background:rgba(181,71,8,.1);color:#b54708}
.georesearch-message-file[data-tone="data"] .georesearch-message-file-icon{background:rgba(6,118,71,.09);color:#067647}
.georesearch-message-file[data-tone="code"] .georesearch-message-file-icon{background:rgba(23,92,211,.09);color:#175cd3}
.georesearch-message-file[data-tone="image"] .georesearch-message-file-icon,.georesearch-message-file[data-tone="media"] .georesearch-message-file-icon{background:rgba(105,65,198,.09);color:#6941c6}
.georesearch-message-file-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.georesearch-message-file-format{display:inline-grid;place-items:center;min-width:34px;height:20px;padding:0 5px;border:1px solid var(--dsw-alias-stroke-subtle,rgba(16,24,40,.12));border-radius:5px;color:var(--dsw-alias-label-tertiary,var(--text-secondary,#667085));font:600 10px/1 system-ui;letter-spacing:0}
.georesearch-message-bubble{max-width:100%;padding:10px 16px;border-radius:22px;background:var(--dsw-specific-bubble,rgba(16,24,40,.06));color:var(--dsw-alias-label-primary,var(--text-primary,#101828));font-size:16px;line-height:24px}
.georesearch-message-actions{display:flex;align-items:center;justify-content:flex-end;gap:5px;min-height:24px;color:var(--dsw-alias-label-tertiary,var(--text-secondary,#667085))}
.georesearch-message-time{font-size:12px;line-height:18px;opacity:0;transition:opacity .12s ease}
.georesearch-message-row:hover .georesearch-message-time,.georesearch-message-row:focus-within .georesearch-message-time{opacity:1}
.georesearch-message-copy{display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer}
.georesearch-message-copy:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(16,24,40,.06));color:var(--dsw-alias-label-primary,var(--text-primary,#101828))}
.georesearch-message-copy:focus-visible{outline:2px solid var(--dsw-alias-button-info-fill,#2563eb);outline-offset:1px}
@media (max-width:640px){.georesearch-message-stack{max-width:88%}.georesearch-message-file{width:100%}}
@media (prefers-color-scheme:dark){.georesearch-drop-overlay{background:rgba(17,24,39,.92);color:#93c5fd}.georesearch-file-badge{border-color:#111827}}
@keyframes georesearch-upload-spin{to{transform:rotate(360deg)}}
`
  document.head.appendChild(style)
  return () => { style.remove() }
}

function validateBatch(files: readonly File[]): void {
  if (files.length > MAX_FILES_PER_BATCH) throw new Error(`一次最多上传 ${MAX_FILES_PER_BATCH} 个文件。`)
  let total = 0
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) throw new Error(`${displayName(file)} 超过 256 MiB。`)
    total += file.size
    if (!Number.isSafeInteger(total) || total > MAX_BATCH_BYTES) throw new Error('本批文件总大小超过 512 MiB。')
  }
}

function browserStorage(): ComposerStorage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

function composerLedgerKey(sessionId: SessionId): string {
  return `${COMPOSER_LEDGER_KEY_PREFIX}${String(sessionId)}`
}

function parseComposerAttachmentPayload(value: unknown): ComposerAttachmentPayload | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const payload = value as {
    readonly schemaVersion?: unknown
    readonly attachments?: unknown
    readonly references?: unknown
  }
  if (payload.schemaVersion === 1 && Array.isArray(payload.references)) {
    const attachments: ComposerAttachmentRecord[] = []
    for (const candidate of payload.references) {
      if (typeof candidate !== 'object' || candidate === null) return undefined
      const reference = candidate as {
        readonly attachmentId?: unknown
        readonly ref?: unknown
        readonly label?: unknown
        readonly offset?: unknown
        readonly fileIdentity?: unknown
      }
      if (typeof reference.attachmentId !== 'string'
        || typeof reference.ref !== 'string'
        || typeof reference.label !== 'string'
        || typeof reference.offset !== 'number'
        || !Number.isSafeInteger(reference.offset)
        || reference.offset < 0
        || (reference.fileIdentity !== undefined && typeof reference.fileIdentity !== 'string')) return undefined
      attachments.push({
        attachmentId: reference.attachmentId,
        name: restoredDisplayName(reference.label, reference.attachmentId),
        mediaType: 'application/octet-stream',
        legacyRef: reference.ref,
        legacyOffset: reference.offset,
        ...(reference.fileIdentity === undefined ? {} : { fileIdentity: reference.fileIdentity }),
      })
    }
    return { schemaVersion: 2, attachments }
  }
  if (payload.schemaVersion !== 2 || !Array.isArray(payload.attachments)) return undefined
  const attachments: ComposerAttachmentRecord[] = []
  for (const candidate of payload.attachments) {
    if (typeof candidate !== 'object' || candidate === null) return undefined
    const attachment = candidate as {
      readonly attachmentId?: unknown
      readonly name?: unknown
      readonly mediaType?: unknown
      readonly fileIdentity?: unknown
    }
    if (typeof attachment.attachmentId !== 'string'
      || typeof attachment.name !== 'string'
      || typeof attachment.mediaType !== 'string'
      || (attachment.fileIdentity !== undefined && typeof attachment.fileIdentity !== 'string')) return undefined
    attachments.push({
      attachmentId: attachment.attachmentId,
      name: restoredDisplayName(attachment.name, attachment.attachmentId),
      mediaType: attachment.mediaType,
      ...(attachment.fileIdentity === undefined ? {} : { fileIdentity: attachment.fileIdentity }),
    })
  }
  return { schemaVersion: 2, attachments }
}

function draftSignalId(sessionId: SessionId): DraftAttachmentId {
  return `${DRAFT_SIGNAL_PREFIX}${String(sessionId)}` as DraftAttachmentId
}

function parseReference(value: string): { readonly sessionId: SessionId; readonly attachmentId: string } {
  try {
    const json = new TextDecoder().decode(base64UrlDecode(value))
    const parsed = JSON.parse(json) as { readonly sessionId?: unknown; readonly attachmentId?: unknown }
    if (typeof parsed.sessionId !== 'string' || typeof parsed.attachmentId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(parsed.attachmentId)) {
      throw new Error('invalid reference')
    }
    return { sessionId: parsed.sessionId as SessionId, attachmentId: parsed.attachmentId }
  } catch (error) {
    throw new Error('文件引用已损坏，无法发送。', { cause: error })
  }
}

function encodeFileName(value: string): string {
  return base64Url(new TextEncoder().encode(value))
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)
  const binary = atob(padded)
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function displayName(file: Pick<File, 'name'>): string {
  return file.name.trim() === '' ? 'unnamed-file' : file.name
}

function browserFileIdentity(file: Pick<File, 'name' | 'size' | 'lastModified'>): string {
  return JSON.stringify([
    displayName(file).normalize('NFC').toLowerCase(),
    file.size,
    file.lastModified,
  ])
}

function duplicateFileNotice(names: readonly string[]): string {
  const uniqueNames = [...new Set(names)]
  return `已跳过重复文件：${uniqueNames.join('、')}。相同文件在当前输入中只需上传一次。`
}

function restoredDisplayName(label: string | undefined, attachmentId: string): string {
  const normalized = label?.trim()
  return normalized === undefined || normalized === '' ? `附件 ${attachmentId.slice(0, 8)}` : normalized
}

function attachmentXml(attachment: Pick<GenericAttachmentRef, 'attachmentId' | 'name' | 'mediaType'>): string {
  return `<georesearch-file attachment-id="${attachment.attachmentId}" name="${xmlAttribute(attachment.name)}" media-type="${xmlAttribute(attachment.mediaType)}"/>`
}

function xmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const aborted = (): void => { reject(signal.reason) }
    signal.addEventListener('abort', aborted, { once: true })
    void promise.then(
      value => { signal.removeEventListener('abort', aborted); resolve(value) },
      error => { signal.removeEventListener('abort', aborted); reject(error) },
    )
  })
}

function responsePayload(xhr: XMLHttpRequest): unknown {
  if (xhr.response !== null && xhr.response !== undefined) return xhr.response
  try {
    return JSON.parse(xhr.responseText) as unknown
  } catch {
    return {}
  }
}

function errorMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'object' || value === null) return fallback
  const error = (value as { readonly error?: unknown }).error
  if (typeof error !== 'object' || error === null) return fallback
  const message = (error as { readonly message?: unknown }).message
  return typeof message === 'string' && message !== '' ? message : fallback
}
