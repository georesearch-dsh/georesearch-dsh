import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ComposerReferenceLedger,
  installConversationSubmissionBridge,
  installDocumentDrop,
  UploadManager,
  shouldInterceptDataTransfer,
  shouldUseNativeImageHandling,
} from '../src/client/index.js'
import {
  attachmentFormat,
  projectGeoResearchMessage,
} from '../src/client/message-presentation.js'

const sessionId = 'session-client' as SessionId
const timerCallbacks: Array<() => void> = []

beforeEach(() => {
  FakeXMLHttpRequest.instances.length = 0
  timerCallbacks.length = 0
  vi.stubGlobal('XMLHttpRequest', FakeXMLHttpRequest)
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    setTimeout: (handler: TimerHandler) => {
      if (typeof handler === 'function') timerCallbacks.push(handler)
      return timerCallbacks.length
    },
    clearTimeout: () => undefined,
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('full-page mixed file routing', () => {
  it('routes native image batches through GeoResearch visual analysis', () => {
    expect(shouldUseNativeImageHandling([
      { type: 'image/png' },
      { type: 'image/jpeg' },
    ])).toBe(false)
    expect(shouldUseNativeImageHandling([
      { type: 'image/png' },
      { type: 'application/pdf' },
    ])).toBe(false)
    expect(shouldInterceptDataTransfer(transfer(['image/png', 'image/webp']))).toBe(true)
    expect(shouldInterceptDataTransfer(transfer(['image/png', 'application/zip']))).toBe(true)
    expect(shouldInterceptDataTransfer(transfer(['']))).toBe(true)
  })

  it('activates document-wide handling only for the current GeoResearch session', () => {
    const fixture = clientFixture()
    const manager = new UploadManager(fixture.ctx)
    expect(manager.isCurrentGeoResearchSession()).toBe(true)
    fixture.setCurrentPreset('general')
    expect(manager.isCurrentGeoResearchSession()).toBe(false)
    manager.dispose()
  })

  it('finishes a non-image drop without leaving the native image overlay active', () => {
    const fixture = clientFixture()
    const manager = new UploadManager(fixture.ctx)
    const documentFixture = new FakeDocument()
    vi.stubGlobal('document', documentFixture as unknown as Document)
    const enqueue = vi.spyOn(manager, 'enqueueCurrent').mockImplementation(() => undefined)
    let nativeOverlayActive = false
    const nativeIntake = vi.fn()
    documentFixture.addEventListener('dragenter', () => { nativeOverlayActive = true })
    documentFixture.addEventListener('drop', event => {
      nativeOverlayActive = false
      nativeIntake(Array.from(event.dataTransfer?.files ?? []))
    })
    window.addEventListener('dragend', () => { nativeOverlayActive = false })
    const dispose = installDocumentDrop(fixture.ctx, manager)
    const pdf = new File(['payload'], 'paper.pdf', { type: 'application/pdf' })
    const dataTransfer = dragTransfer([pdf])

    documentFixture.dispatchFromBody('dragenter', dataTransfer)
    documentFixture.dispatchFromBody('drop', dataTransfer)

    expect(enqueue).toHaveBeenCalledWith([pdf])
    expect(nativeIntake).not.toHaveBeenCalled()
    expect(nativeOverlayActive).toBe(false)
    expect(documentFixture.appended[0]?.hidden).toBe(true)
    dispose()
    manager.dispose()
  })

  it('intercepts an all-image drag/drop batch for GeoResearch visual analysis', () => {
    const fixture = clientFixture()
    const manager = new UploadManager(fixture.ctx)
    const documentFixture = new FakeDocument()
    vi.stubGlobal('document', documentFixture as unknown as Document)
    const enqueue = vi.spyOn(manager, 'enqueueCurrent').mockImplementation(() => undefined)
    let nativeOverlayActive = false
    const nativeIntake = vi.fn()
    documentFixture.addEventListener('dragenter', () => { nativeOverlayActive = true })
    documentFixture.addEventListener('drop', event => {
      nativeOverlayActive = false
      nativeIntake(Array.from(event.dataTransfer?.files ?? []))
    })
    const dispose = installDocumentDrop(fixture.ctx, manager)
    const image = new File(['payload'], 'map.png', { type: 'image/png' })
    const dataTransfer = dragTransfer([image])

    documentFixture.dispatchFromBody('dragenter', dataTransfer)
    expect(nativeOverlayActive).toBe(false)
    expect(documentFixture.appended[0]?.hidden).toBe(false)
    documentFixture.dispatchFromBody('drop', dataTransfer)

    expect(enqueue).toHaveBeenCalledWith([image])
    expect(nativeIntake).not.toHaveBeenCalled()
    expect(nativeOverlayActive).toBe(false)
    dispose()
    manager.dispose()
  })

  it('stops intercepting this Harness document after the plugin effect is disposed', () => {
    const fixture = clientFixture()
    const manager = new UploadManager(fixture.ctx)
    const documentFixture = new FakeDocument()
    vi.stubGlobal('document', documentFixture as unknown as Document)
    const enqueue = vi.spyOn(manager, 'enqueueCurrent').mockImplementation(() => undefined)
    const dispose = installDocumentDrop(fixture.ctx, manager)
    const pdf = new File(['payload'], 'paper.pdf', { type: 'application/pdf' })

    dispose()
    const event = documentFixture.dispatchFromBody('drop', dragTransfer([pdf]))

    expect(event.defaultPrevented).toBe(false)
    expect(enqueue).not.toHaveBeenCalled()
    expect(documentFixture.appended[0]?.removed).toBe(true)
    manager.dispose()
  })
})

describe('upload-backed attachment submission', () => {
  it('leaves the Composer draft byte-for-byte unchanged when files are enqueued', () => {
    const fixture = clientFixture()
    fixture.setDraft('请审阅这份材料')
    const before = fixture.inputSnapshot()
    const manager = new UploadManager(fixture.ctx)

    manager.enqueue(sessionId, [
      new File(['payload'], 'paper.pdf', { type: 'application/pdf' }),
      new File(['notes'], 'notes.txt', { type: 'text/plain' }),
    ])

    expect(fixture.inputSnapshot()).toEqual(before)
    expect(fixture.references).toEqual([])
    expect(manager.snapshot(sessionId)).toHaveLength(2)
    manager.dispose()
  })

  it('keeps each completed upload in the Composer until that file is removed', () => {
    const fixture = clientFixture()
    const manager = new UploadManager(fixture.ctx)
    manager.enqueue(sessionId, [new File(['payload'], 'paper.pdf', { type: 'application/pdf' })])
    const view = manager.snapshot(sessionId)[0]!

    FakeXMLHttpRequest.instances[0]!.succeed(reference(view.attachmentId, 'paper.pdf', 'application/pdf', 'document'))
    expect(manager.snapshot(sessionId)[0]).toMatchObject({ status: 'complete', name: 'paper.pdf' })

    expect(fixture.imageIds()).toHaveLength(1)

    manager.remove(view.attachmentId)
    expect(manager.snapshot(sessionId)).toEqual([])
    expect(fixture.inputSnapshot().occurrences).toEqual([])
    expect(fixture.imageIds()).toEqual([])
    manager.dispose()
  })

  it('restores one completed card per persisted Composer attachment after reload', async () => {
    const fixture = clientFixture()
    const ledger = new ComposerReferenceLedger(new MemoryStorage())
    const firstManager = new UploadManager(fixture.ctx, ledger)
    firstManager.enqueue(sessionId, [new File(['payload'], 'restored.pdf', { type: 'application/pdf' })])
    const uploaded = firstManager.snapshot(sessionId)[0]!
    const restoredAttachment = reference(
      uploaded.attachmentId,
      'restored.pdf',
      'application/pdf',
      'document',
    )
    FakeXMLHttpRequest.instances[0]!.succeed(restoredAttachment)
    firstManager.dispose()

    const fetchMock = vi.fn(async () => new Response(JSON.stringify(restoredAttachment), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const restoredManager = new UploadManager(fixture.ctx, ledger)

    restoredManager.reconcile(sessionId)

    await vi.waitFor(() => {
      expect(restoredManager.snapshot(sessionId)).toEqual([
        expect.objectContaining({
          attachmentId: uploaded.attachmentId,
          name: 'restored.pdf',
          mediaType: 'application/pdf',
          status: 'complete',
        }),
      ])
    })
    expect(fetchMock).toHaveBeenCalledWith(
      `${'/api/georesearch/files/v1'}/${uploaded.attachmentId}`,
      expect.objectContaining({
        method: 'GET',
        headers: { 'x-georesearch-session-id': String(sessionId) },
      }),
    )
    restoredManager.dispose()
  })

  it('migrates legacy references and removes their placeholders plus generated spaces', async () => {
    const fixture = clientFixture()
    const firstId = 'bb09246d-79cf-4776-9d49-d6c9fca9b187'
    const secondId = 'cc09246d-79cf-4776-9d49-d6c9fca9b188'
    const firstRef = encodedReference(firstId)
    const secondRef = encodedReference(secondId)
    fixture.seedLegacyDraft('\uFFFC \uFFFC 请审阅', [
      legacyOccurrence(1, firstRef, 'first.pdf', 0),
      legacyOccurrence(2, secondRef, 'second.txt', 2),
    ])
    const storage = new MemoryStorage()
    const storageKey = `georesearch.file-service.composer.v1.${String(sessionId)}`
    storage.setItem(storageKey, JSON.stringify({
      schemaVersion: 1,
      references: [
        { attachmentId: firstId, ref: firstRef, label: 'first.pdf', offset: 0 },
        { attachmentId: secondId, ref: secondRef, label: 'second.txt', offset: 2 },
      ],
    }))
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
      const attachmentId = String(url).split('/').at(-1)!
      const restored = attachmentId === firstId
        ? reference(firstId, 'first.pdf', 'application/pdf', 'document')
        : reference(secondId, 'second.txt')
      return new Response(JSON.stringify(restored), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))
    const restoredManager = new UploadManager(fixture.ctx, new ComposerReferenceLedger(storage))

    restoredManager.reconcile(sessionId)

    expect(fixture.inputSnapshot()).toMatchObject({ draft: '请审阅', occurrences: [] })
    expect(fixture.imageIds()).toHaveLength(1)
    expect(JSON.parse(storage.getItem(storageKey)!)).toMatchObject({
      schemaVersion: 2,
      attachments: [
        { attachmentId: firstId, name: 'first.pdf' },
        { attachmentId: secondId, name: 'second.txt' },
      ],
    })
    await vi.waitFor(() => {
      expect(restoredManager.snapshot(sessionId).every(upload => upload.status === 'complete')).toBe(true)
    })
    restoredManager.dispose()
  })

  it('removes a raw legacy placeholder when Harness lost occurrence metadata', async () => {
    const fixture = clientFixture()
    const attachmentId = 'bb09246d-79cf-4776-9d49-d6c9fca9b187'
    const ref = encodedReference(attachmentId)
    fixture.seedLegacyDraft('\uFFFC 继续分析', [])
    const storage = new MemoryStorage()
    const storageKey = `georesearch.file-service.composer.v1.${String(sessionId)}`
    storage.setItem(storageKey, JSON.stringify({
      schemaVersion: 1,
      references: [{ attachmentId, ref, label: 'restored.pdf', offset: 0 }],
    }))
    const restoredAttachment = reference(attachmentId, 'restored.pdf', 'application/pdf', 'document')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(restoredAttachment), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })))
    const restoredManager = new UploadManager(fixture.ctx, new ComposerReferenceLedger(storage))

    restoredManager.reconcile(sessionId)

    expect(fixture.inputSnapshot()).toMatchObject({ draft: '继续分析', occurrences: [] })
    await vi.waitFor(() => {
      expect(restoredManager.snapshot(sessionId)[0]).toMatchObject({ status: 'complete', name: 'restored.pdf' })
    })
    restoredManager.dispose()
  })

  it('waits for Harness draft hydration before committing a legacy migration', () => {
    const fixture = clientFixture()
    const attachmentId = 'bb09246d-79cf-4776-9d49-d6c9fca9b187'
    const ref = encodedReference(attachmentId)
    const storage = new MemoryStorage()
    const storageKey = `georesearch.file-service.composer.v1.${String(sessionId)}`
    storage.setItem(storageKey, JSON.stringify({
      schemaVersion: 1,
      references: [{ attachmentId, ref, label: 'delayed.pdf', offset: 0 }],
    }))
    const manager = new UploadManager(fixture.ctx, new ComposerReferenceLedger(storage))

    manager.reconcile(sessionId)

    expect(manager.snapshot(sessionId)).toEqual([])
    expect(JSON.parse(storage.getItem(storageKey)!)).toMatchObject({ schemaVersion: 1 })
    expect(timerCallbacks).toHaveLength(1)

    fixture.seedLegacyDraft('\uFFFC 继续', [legacyOccurrence(1, ref, 'delayed.pdf', 0)])
    timerCallbacks[0]!()

    expect(fixture.inputSnapshot()).toMatchObject({ draft: '继续', occurrences: [] })
    expect(JSON.parse(storage.getItem(storageKey)!)).toMatchObject({ schemaVersion: 2 })
    manager.dispose()
  })

  it('tracks success and failure independently for every file in one batch', () => {
    const fixture = clientFixture()
    const manager = new UploadManager(fixture.ctx)
    manager.enqueue(sessionId, [
      new File(['alpha'], 'alpha.txt', { type: 'text/plain' }),
      new File(['beta'], 'beta.zip', { type: 'application/zip' }),
    ])
    const [alpha, beta] = manager.snapshot(sessionId)

    FakeXMLHttpRequest.instances[0]!.succeed(reference(alpha!.attachmentId, 'alpha.txt'))
    FakeXMLHttpRequest.instances[1]!.failNetwork()

    expect(manager.snapshot(sessionId)).toEqual([
      expect.objectContaining({ attachmentId: alpha!.attachmentId, status: 'complete' }),
      expect.objectContaining({ attachmentId: beta!.attachmentId, status: 'failed' }),
    ])
    manager.dispose()
  })

  it('uploads one card and reports a duplicate when the same file is selected twice', () => {
    const fixture = clientFixture()
    const manager = new UploadManager(fixture.ctx)
    const first = new File(['payload'], 'paper.pdf', {
      type: 'application/pdf',
      lastModified: 1_700_000_000_000,
    })
    const duplicate = new File(['payload'], 'paper.pdf', {
      type: 'application/pdf',
      lastModified: 1_700_000_000_000,
    })

    manager.enqueue(sessionId, [first, duplicate])

    expect(manager.snapshot(sessionId)).toHaveLength(1)
    expect(FakeXMLHttpRequest.instances).toHaveLength(1)
    expect(fixture.inputSnapshot().occurrences).toEqual([])
    expect(fixture.notifications).toContainEqual([
      'info',
      '已跳过重复文件：paper.pdf。相同文件在当前输入中只需上传一次。',
    ])

    manager.enqueue(sessionId, [duplicate])

    expect(manager.snapshot(sessionId)).toHaveLength(1)
    expect(FakeXMLHttpRequest.instances).toHaveLength(1)
    expect(fixture.inputSnapshot().occurrences).toEqual([])
    manager.dispose()
  })

  it('remembers duplicate identity when a Composer attachment is restored', () => {
    const fixture = clientFixture()
    const ledger = new ComposerReferenceLedger(undefined)
    const firstManager = new UploadManager(fixture.ctx, ledger)
    const file = new File(['payload'], 'restored.pdf', {
      type: 'application/pdf',
      lastModified: 1_700_000_000_000,
    })
    firstManager.enqueue(sessionId, [file])
    firstManager.dispose()

    const restoredManager = new UploadManager(fixture.ctx, ledger)
    restoredManager.reconcile(sessionId)
    restoredManager.enqueue(sessionId, [file])

    expect(restoredManager.snapshot(sessionId)).toHaveLength(1)
    expect(FakeXMLHttpRequest.instances).toHaveLength(1)
    expect(fixture.inputSnapshot().occurrences).toEqual([])
    expect(fixture.notifications).toContainEqual([
      'info',
      '已跳过重复文件：restored.pdf。相同文件在当前输入中只需上传一次。',
    ])
    restoredManager.dispose()
  })

  it('deleting an active upload aborts only that file and preserves the other attachment', () => {
    const fixture = clientFixture()
    const manager = new UploadManager(fixture.ctx)
    manager.enqueue(sessionId, [
      new File(['alpha'], 'alpha.txt', { type: 'text/plain' }),
      new File(['beta'], 'beta.txt', { type: 'text/plain' }),
    ])
    const [alpha, beta] = manager.snapshot(sessionId)

    manager.remove(alpha!.attachmentId)

    expect(FakeXMLHttpRequest.instances[0]!.aborted).toBe(true)
    expect(FakeXMLHttpRequest.instances[1]!.aborted).toBe(false)
    expect(manager.snapshot(sessionId)).toEqual([
      expect.objectContaining({ attachmentId: beta!.attachmentId, status: 'uploading' }),
    ])
    expect(fixture.inputSnapshot().occurrences).toEqual([])
    expect(fixture.imageIds()).toHaveLength(1)
    manager.dispose()
  })

  it('waits for the upload before serializing the attachment batch', async () => {
    const fixture = clientFixture()
    const manager = new UploadManager(fixture.ctx)
    manager.enqueue(sessionId, [new File(['payload'], 'notes.txt', { type: 'text/plain' })])
    const view = manager.snapshot(sessionId)[0]!
    const pending = manager.serializeSession(sessionId)
    let settled = false
    void pending.finally(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    FakeXMLHttpRequest.instances[0]!.succeed(reference(view.attachmentId, 'notes.txt'))
    await expect(pending).resolves.toEqual({
      attachmentIds: [view.attachmentId],
      text: `<georesearch-file attachment-id="${view.attachmentId}" name="notes.txt" media-type="text/plain"/>`,
    })
    expect(fixture.notifications).not.toContainEqual(['info', '正在上传 1 个文件。'])
    manager.dispose()
  })

  it('blocks serialization on failure and lets the same reference succeed after retry', async () => {
    const fixture = clientFixture()
    const manager = new UploadManager(fixture.ctx)
    manager.enqueue(sessionId, [new File(['payload'], 'data.zip', { type: 'application/zip' })])
    const view = manager.snapshot(sessionId)[0]!
    const first = manager.serializeSession(sessionId)
    FakeXMLHttpRequest.instances[0]!.failNetwork()
    await expect(first).rejects.toThrow('网络错误导致上传失败')
    expect(manager.snapshot(sessionId)[0]).toMatchObject({ status: 'failed' })

    manager.retry(view.attachmentId)
    expect(FakeXMLHttpRequest.instances).toHaveLength(2)
    const retried = manager.serializeSession(sessionId)
    FakeXMLHttpRequest.instances[1]!.succeed(reference(view.attachmentId, 'data.zip'))
    await expect(retried).resolves.toMatchObject({ attachmentIds: [view.attachmentId] })
    expect(manager.snapshot(sessionId)[0]).toMatchObject({ status: 'complete' })
    manager.dispose()
  })

  it('adds attachment XML only to the submitted message and supports a file-only send', async () => {
    const fixture = clientFixture()
    const manager = new UploadManager(fixture.ctx)
    const disposeBridge = installConversationSubmissionBridge(fixture.ctx, manager)
    manager.enqueue(sessionId, [new File(['payload'], 'paper.pdf', { type: 'application/pdf' })])
    const upload = manager.snapshot(sessionId)[0]!
    const draftBeforeSend = fixture.inputSnapshot().draft
    const pending = fixture.send('')

    expect(fixture.draftImages()).toHaveLength(1)
    FakeXMLHttpRequest.instances[0]!.succeed(reference(upload.attachmentId, 'paper.pdf', 'application/pdf', 'document'))
    await pending

    expect(fixture.sentMessages).toEqual([{
      text: `<georesearch-file attachment-id="${upload.attachmentId}" name="paper.pdf" media-type="application/pdf"/>`,
      imageIds: [],
      mode: 'queue',
    }])
    expect(fixture.inputSnapshot().draft).toBe(draftBeforeSend)
    expect(manager.snapshot(sessionId)).toEqual([])
    expect(fixture.imageIds()).toEqual([])
    disposeBridge()
    manager.dispose()
  })

  it('preserves every attachment and its send signal when host submission fails', async () => {
    const fixture = clientFixture()
    const manager = new UploadManager(fixture.ctx)
    const disposeBridge = installConversationSubmissionBridge(fixture.ctx, manager)
    manager.enqueue(sessionId, [new File(['payload'], 'notes.txt', { type: 'text/plain' })])
    const upload = manager.snapshot(sessionId)[0]!
    FakeXMLHttpRequest.instances[0]!.succeed(reference(upload.attachmentId, 'notes.txt'))
    fixture.setSendFailure(new Error('host rejected'))

    await expect(fixture.send('请分析')).rejects.toThrow('host rejected')

    expect(manager.snapshot(sessionId)).toEqual([
      expect.objectContaining({ attachmentId: upload.attachmentId, status: 'complete' }),
    ])
    expect(fixture.imageIds()).toHaveLength(1)
    disposeBridge()
    manager.dispose()
  })
})

describe('historical attachment presentation', () => {
  it('projects model-only XML into a named file card without exposing the tag', () => {
    const attachmentId = 'bb09246d-79cf-4776-9d49-d6c9fca9b187'
    const projection = projectGeoResearchMessage(
      `请分析\n\uFFFC <georesearch-file attachment-id="${attachmentId}" name="field &amp; notes.pdf" media-type="application/pdf"/>`,
    )

    expect(projection.text).toBe('请分析')
    expect(projection.text).not.toContain('georesearch-file')
    expect(projection.files).toEqual([{
      attachmentId,
      name: 'field & notes.pdf',
      mediaType: 'application/pdf',
    }])
    expect(attachmentFormat(projection.files[0]?.name, projection.files[0]?.mediaType)).toBe('PDF')
  })

  it('keeps legacy id-only references resolvable without showing their XML', () => {
    const attachmentId = 'bb09246d-79cf-4776-9d49-d6c9fca9b187'
    expect(projectGeoResearchMessage(
      `<georesearch-file attachment-id="${attachmentId}"/>`,
    )).toEqual({
      text: '',
      files: [{ attachmentId }],
    })
  })
})

function clientFixture(): {
  readonly ctx: ClientContext
  readonly references: Array<{ readonly ref: string }>
  readonly notifications: Array<[string, string]>
  readonly sentMessages: Array<{ readonly text: string; readonly imageIds: readonly string[]; readonly mode: string }>
  readonly inputSnapshot: () => {
    readonly draft: string
    readonly draftRev: number
    readonly occurrences: readonly FixtureOccurrence[]
  }
  readonly imageIds: () => readonly string[]
  readonly draftImages: () => readonly unknown[]
  readonly send: (text: string) => Promise<void>
  readonly seedLegacyDraft: (draft: string, occurrences: readonly FixtureOccurrence[]) => void
  readonly setDraft: (draft: string) => void
  readonly setSendFailure: (error: Error | undefined) => void
  readonly setCurrentPreset: (preset: string) => void
} {
  const references: Array<{ readonly ref: string }> = []
  const notifications: Array<[string, string]> = []
  const sentMessages: Array<{ text: string; imageIds: readonly string[]; mode: string }> = []
  let currentPreset = 'georesearch'
  let draft = ''
  let draftRev = 1
  let occurrenceId = 0
  let occurrences: FixtureOccurrence[] = []
  let draftImageIds: string[] = []
  let sendFailure: Error | undefined
  const input = {
    state: { getSnapshot: () => ({ draft, draftRev, occurrences, imageIds: draftImageIds, phase: 'plain' }) },
    insertReference: (value: FixtureReference, span: { readonly start: number; readonly end?: number }) => {
      const offset = span.start
      const end = span.end ?? offset
      const tail = draft.slice(end)
      const gap = tail.length === 0 || tail[0] !== ' ' ? ' ' : ''
      const inserted = `\uFFFC${gap}`
      const delta = inserted.length - (end - offset)
      draft = `${draft.slice(0, offset)}${inserted}${tail}`
      occurrences = [
        ...occurrences
          .filter(item => item.offset < offset || item.offset >= end)
          .map(item => item.offset >= end ? { ...item, offset: item.offset + delta } : item),
        {
          occurrenceId: ++occurrenceId,
          source: value.source,
          ref: value.ref,
          label: value.label,
          clipboardText: value.clipboardText,
          offset,
        },
      ].sort((left, right) => left.offset - right.offset)
      draftRev += 1
      references.push(value)
      return true
    },
    setDraft: (next: string, editRange?: { readonly start: number; readonly end: number }) => {
      const previous = draft
      if (editRange !== undefined) {
        const delta = next.length - previous.length
        occurrences = occurrences
          .filter(item => item.offset < editRange.start || item.offset >= editRange.end)
          .map(item => item.offset >= editRange.end ? { ...item, offset: item.offset + delta } : item)
      } else if (next === '') {
        occurrences = []
      }
      draft = next
      draftRev += 1
    },
    addImages: (ids: readonly string[]) => {
      for (const id of ids) {
        if (!draftImageIds.includes(id)) draftImageIds.push(id)
      }
      return true
    },
    removeImage: (id: string) => {
      draftImageIds = draftImageIds.filter(candidate => candidate !== id)
    },
    notify: (level: string, message: string) => { notifications.push([level, message]) },
  }
  const conversation = {
    input: { for: () => input },
    draftImages: (_ids: readonly string[]) => [],
    sendSession: async (
      _session: { readonly sessionId: SessionId },
      text: string,
      imageIds: readonly string[],
      mode: string,
    ) => {
      if (sendFailure !== undefined) throw sendFailure
      sentMessages.push({ text, imageIds: [...imageIds], mode })
    },
  }
  const ctx = {
    sessions: {
      list: {
        getSnapshot: () => ({
          current: sessionId,
          byId: { [sessionId]: { agentPreset: currentPreset } },
        }),
      },
      scope: () => ({}),
    },
    conversation,
    get: (name: string) => name === 'conversation' ? conversation : undefined,
  } as unknown as ClientContext
  return {
    ctx,
    references,
    notifications,
    sentMessages,
    inputSnapshot: () => ({ draft, draftRev, occurrences }),
    imageIds: () => [...draftImageIds],
    draftImages: () => conversation.draftImages(draftImageIds),
    send: text => conversation.sendSession({ sessionId }, text, draftImageIds, 'queue'),
    seedLegacyDraft: (next, nextOccurrences) => {
      draft = next
      occurrences = [...nextOccurrences]
      occurrenceId = nextOccurrences.reduce((maximum, occurrence) => Math.max(maximum, occurrence.occurrenceId), 0)
      draftRev += 1
    },
    setDraft: next => {
      draft = next
      draftRev += 1
    },
    setSendFailure: error => { sendFailure = error },
    setCurrentPreset: preset => { currentPreset = preset },
  }
}

interface FixtureReference {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly clipboardText: string
}

interface FixtureOccurrence extends FixtureReference {
  readonly occurrenceId: number
  readonly offset: number
}

function encodedReference(attachmentId: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ sessionId: String(sessionId), attachmentId }))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function legacyOccurrence(
  occurrenceId: number,
  ref: string,
  label: string,
  offset: number,
): FixtureOccurrence {
  return {
    occurrenceId,
    source: 'georesearch-file',
    ref,
    label,
    clipboardText: `@file:${label}`,
    offset,
  }
}

class MemoryStorage {
  private readonly values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }
}

function transfer(types: readonly string[]): DataTransfer {
  return {
    items: types.map(type => ({ kind: 'file', type })),
    types: ['Files'],
  } as unknown as DataTransfer
}

function dragTransfer(files: readonly File[]): DataTransfer {
  return {
    items: files.map(file => ({ kind: 'file', type: file.type })),
    types: ['Files'],
    files,
    dropEffect: 'none',
  } as unknown as DataTransfer
}

function reference(
  attachmentId: string,
  name: string,
  mediaType = 'text/plain',
  readStrategy = 'direct-text',
) {
  return {
    schemaVersion: 1,
    attachmentId,
    artifactId: `artifact-${'a'.repeat(64)}`,
    digest: `sha256:${'a'.repeat(64)}`,
    name,
    size: 7,
    mediaType,
    contentKind: readStrategy === 'document' ? 'document' : 'text',
    readStrategy,
  }
}

class FakeXMLHttpRequest {
  static readonly instances: FakeXMLHttpRequest[] = []
  readonly upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null }
  readonly headers = new Map<string, string>()
  status = 0
  response: unknown = null
  responseText = ''
  responseType = ''
  timeout = 0
  onerror: (() => void) | null = null
  ontimeout: (() => void) | null = null
  onabort: (() => void) | null = null
  onload: (() => void) | null = null
  body: unknown
  aborted = false

  constructor() {
    FakeXMLHttpRequest.instances.push(this)
  }

  open(): void {}

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name, value)
  }

  send(body: unknown): void {
    this.body = body
  }

  abort(): void {
    this.aborted = true
    this.onabort?.()
  }

  succeed(value: unknown): void {
    this.status = 201
    this.response = value
    this.onload?.()
  }

  failNetwork(): void {
    this.onerror?.()
  }
}

interface FakeElement {
  className: string
  textContent: string
  hidden: boolean
  removed: boolean
  readonly remove: () => void
}

type FakeDragListener = (event: FakeDragEvent) => void

class FakeDragEvent {
  propagationStopped = false
  immediatePropagationStopped = false
  defaultPrevented = false

  constructor(readonly dataTransfer: DataTransfer) {}

  preventDefault(): void {
    this.defaultPrevented = true
  }

  stopPropagation(): void {
    this.propagationStopped = true
  }

  stopImmediatePropagation(): void {
    this.immediatePropagationStopped = true
    this.propagationStopped = true
  }
}

class FakeDocument {
  readonly appended: FakeElement[] = []
  readonly body = { appendChild: (element: FakeElement) => { this.appended.push(element) } }
  private readonly captures = new Map<string, FakeDragListener[]>()
  private readonly bubbles = new Map<string, FakeDragListener[]>()

  createElement(): FakeElement {
    const element: FakeElement = {
      className: '',
      textContent: '',
      hidden: false,
      removed: false,
      remove: () => { element.removed = true },
    }
    return element
  }

  addEventListener(
    type: string,
    listener: FakeDragListener,
    options?: boolean | { readonly capture?: boolean },
  ): void {
    const capture = typeof options === 'boolean' ? options : options?.capture === true
    const listeners = capture ? this.captures : this.bubbles
    listeners.set(type, [...(listeners.get(type) ?? []), listener])
  }

  removeEventListener(
    type: string,
    listener: FakeDragListener,
    options?: boolean | { readonly capture?: boolean },
  ): void {
    const capture = typeof options === 'boolean' ? options : options?.capture === true
    const listeners = capture ? this.captures : this.bubbles
    listeners.set(type, (listeners.get(type) ?? []).filter(candidate => candidate !== listener))
  }

  dispatchFromBody(type: string, dataTransfer: DataTransfer): FakeDragEvent {
    const event = new FakeDragEvent(dataTransfer)
    this.invoke(this.captures.get(type) ?? [], event)
    if (!event.propagationStopped) this.invoke(this.bubbles.get(type) ?? [], event)
    return event
  }

  private invoke(listeners: readonly FakeDragListener[], event: FakeDragEvent): void {
    for (const listener of listeners) {
      listener(event)
      if (event.immediatePropagationStopped) return
    }
  }
}
