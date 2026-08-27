import {
  createCanvas,
  DOMMatrix as CanvasDOMMatrix,
  ImageData as CanvasImageData,
  Path2D as CanvasPath2D,
  type Canvas,
} from '@napi-rs/canvas'
import type { PDFPageProxy } from 'pdfjs-dist/types/src/display/api.js'

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
type PdfJsWorkerModule = typeof import('pdfjs-dist/legacy/build/pdf.worker.mjs')

let pdfJsModule: Promise<PdfJsModule> | undefined

export const PDF_READ_LIMITS = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024,
  maxDocumentPages: 2_000,
  maxPagesPerCall: 4,
  maxPageTextBytes: 1024 * 1024,
  maxResultTextBytes: 2 * 1024 * 1024,
  maxPagePixels: 4_000_000,
  maxPageImageBytes: 5 * 1024 * 1024,
} as const)

export const PDFJS_PARSER_VERSION = '6.2.108'

export interface PdfRenderedPage {
  readonly data: Uint8Array
  readonly mediaType: 'image/jpeg'
  readonly width: number
  readonly height: number
}

export interface PdfPageRead {
  readonly page: number
  readonly text: string
  readonly textBytes: number
  readonly image?: PdfRenderedPage
  readonly imageWarning?: string
}

export interface PdfDocumentRead {
  readonly pageCount: number
  readonly pageStart: number
  readonly pageEnd: number
  readonly nextPage: number | null
  readonly pages: readonly PdfPageRead[]
  readonly metadata: {
    readonly title: string | null
    readonly author: string | null
    readonly subject: string | null
    readonly creator: string | null
    readonly producer: string | null
  }
}

export interface PdfReadOptions {
  readonly page?: number
  readonly maxPages?: number
  readonly renderImages?: boolean
  readonly maxInputBytes?: number
  readonly maxDocumentPages?: number
  readonly maxPageTextBytes?: number
  readonly maxResultTextBytes?: number
  readonly maxPagePixels?: number
  readonly maxPageImageBytes?: number
}

interface CanvasEntry {
  canvas: Canvas
  context: ReturnType<Canvas['getContext']>
}

class NapiCanvasFactory {
  create(width: number, height: number): CanvasEntry {
    assertCanvasDimensions(width, height)
    const canvas = createCanvas(width, height)
    return { canvas, context: canvas.getContext('2d') }
  }

  reset(entry: CanvasEntry, width: number, height: number): void {
    assertCanvasDimensions(width, height)
    entry.canvas.width = width
    entry.canvas.height = height
  }

  destroy(entry: CanvasEntry): void {
    entry.canvas.width = 0
    entry.canvas.height = 0
  }
}

export async function readPdfDocument(
  source: Uint8Array,
  options: PdfReadOptions = {},
  signal?: AbortSignal,
): Promise<PdfDocumentRead> {
  const limits = resolvedLimits(options)
  if (source.byteLength === 0) throw new Error('PDF input is empty')
  if (source.byteLength > limits.maxInputBytes) {
    throw new Error(`PDF input exceeds ${limits.maxInputBytes} bytes`)
  }
  throwIfAborted(signal)
  const { getDocument } = await loadPdfJs()
  const loadingTask = getDocument({
    data: Uint8Array.from(source),
    CanvasFactory: NapiCanvasFactory,
    useWorkerFetch: false,
    stopAtErrors: true,
    maxImageSize: limits.maxPagePixels,
    canvasMaxAreaInBytes: limits.maxPagePixels * 4,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
  })
  const abortLoading = (): void => { void loadingTask.destroy() }
  signal?.addEventListener('abort', abortLoading, { once: true })
  try {
    const document = await loadingTask.promise
    throwIfAborted(signal)
    if (document.numPages < 1) throw new Error('PDF contains no pages')
    if (document.numPages > limits.maxDocumentPages) {
      throw new Error(`PDF page count exceeds ${limits.maxDocumentPages}`)
    }
    const pageStart = positiveInteger(options.page ?? 1, 'page')
    if (pageStart > document.numPages) throw new Error(`PDF page ${pageStart} is outside the document`)
    const requestedPages = positiveInteger(options.maxPages ?? PDF_READ_LIMITS.maxPagesPerCall, 'maxPages')
    if (requestedPages > PDF_READ_LIMITS.maxPagesPerCall) {
      throw new Error(`maxPages exceeds ${PDF_READ_LIMITS.maxPagesPerCall}`)
    }
    const pageEnd = Math.min(document.numPages, pageStart + requestedPages - 1)
    const pages: PdfPageRead[] = []
    const metadata = await boundedMetadata(document)
    let resultTextBytes = 0
    for (let pageNumber = pageStart; pageNumber <= pageEnd; pageNumber += 1) {
      throwIfAborted(signal)
      const page = await document.getPage(pageNumber)
      try {
        const textContent = await page.getTextContent({ disableNormalization: false })
        const text = textFromItems(textContent.items)
        const textBytes = Buffer.byteLength(text, 'utf8')
        if (textBytes > limits.maxPageTextBytes) {
          throw new Error(`PDF page ${pageNumber} text exceeds ${limits.maxPageTextBytes} bytes`)
        }
        resultTextBytes += textBytes
        if (resultTextBytes > limits.maxResultTextBytes) {
          throw new Error(`PDF result text exceeds ${limits.maxResultTextBytes} bytes`)
        }
        let image: PdfRenderedPage | undefined
        let imageWarning: string | undefined
        if (options.renderImages !== false) {
          try {
            image = await renderPage(page, limits.maxPagePixels, limits.maxPageImageBytes, signal)
          } catch (error) {
            if (signal?.aborted === true) throw abortReason(signal)
            imageWarning = error instanceof Error ? error.message : 'PDF page rendering failed'
          }
        }
        pages.push({
          page: pageNumber,
          text,
          textBytes,
          ...(image === undefined ? {} : { image }),
          ...(imageWarning === undefined ? {} : { imageWarning }),
        })
      } finally {
        page.cleanup()
      }
    }
    return {
      pageCount: document.numPages,
      pageStart,
      pageEnd,
      nextPage: pageEnd < document.numPages ? pageEnd + 1 : null,
      pages,
      metadata,
    }
  } finally {
    signal?.removeEventListener('abort', abortLoading)
    await loadingTask.destroy().catch(() => undefined)
  }
}

async function boundedMetadata(document: Awaited<ReturnType<PdfJsModule['getDocument']>['promise']>): Promise<PdfDocumentRead['metadata']> {
  let info: Record<string, unknown> = {}
  try {
    const metadata = await document.getMetadata()
    if (typeof metadata.info === 'object' && metadata.info !== null) info = metadata.info as Record<string, unknown>
  } catch {
    return { title: null, author: null, subject: null, creator: null, producer: null }
  }
  let total = 0
  const field = (name: string): string | null => {
    const value = info[name]
    if (typeof value !== 'string' || value.trim().length === 0) return null
    const normalized = value.normalize('NFC').trim()
    const bytes = Buffer.byteLength(normalized, 'utf8')
    if (bytes > 4_096 || total + bytes > 16_384) return null
    total += bytes
    return normalized
  }
  return {
    title: field('Title'),
    author: field('Author'),
    subject: field('Subject'),
    creator: field('Creator'),
    producer: field('Producer'),
  }
}

async function renderPage(
  page: PDFPageProxy,
  maxPixels: number,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<PdfRenderedPage> {
  const base = page.getViewport({ scale: 1 })
  const basePixels = base.width * base.height
  if (!Number.isFinite(basePixels) || basePixels <= 0) throw new Error(`PDF page ${page.pageNumber} has invalid dimensions`)
  let scale = Math.min(1.75, Math.sqrt(maxPixels / basePixels))
  if (!Number.isFinite(scale) || scale <= 0) throw new Error(`PDF page ${page.pageNumber} cannot be bounded for rendering`)
  for (const quality of [85, 72, 60, 48]) {
    throwIfAborted(signal)
    const viewport = page.getViewport({ scale })
    const width = Math.max(1, Math.ceil(viewport.width))
    const height = Math.max(1, Math.ceil(viewport.height))
    if (width * height > maxPixels) throw new Error(`PDF page ${page.pageNumber} exceeds the render pixel limit`)
    const canvas = createCanvas(width, height)
    const context = canvas.getContext('2d')
    const renderTask = page.render({
      canvas: null,
      canvasContext: context as never,
      viewport,
      background: '#ffffff',
    })
    const abortRender = (): void => { renderTask.cancel() }
    signal?.addEventListener('abort', abortRender, { once: true })
    try {
      await renderTask.promise
    } catch (error) {
      if (signal?.aborted === true) throw abortReason(signal)
      throw error
    } finally {
      signal?.removeEventListener('abort', abortRender)
    }
    const data = canvas.toBuffer('image/jpeg', quality)
    if (data.byteLength <= maxBytes) {
      return { data: Uint8Array.from(data), mediaType: 'image/jpeg', width, height }
    }
    scale *= 0.75
  }
  throw new Error(`PDF page ${page.pageNumber} image exceeds ${maxBytes} bytes`)
}

function loadPdfJs(): Promise<PdfJsModule> {
  installCanvasGlobals()
  pdfJsModule ??= Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
  ]).then(([pdf, worker]: [PdfJsModule, PdfJsWorkerModule]) => {
    const globals = globalThis as unknown as Record<string, unknown>
    globals.pdfjsWorker = { WorkerMessageHandler: worker.WorkerMessageHandler }
    return pdf
  })
  return pdfJsModule
}

function installCanvasGlobals(): void {
  const globals = globalThis as unknown as Record<string, unknown>
  globals.DOMMatrix ??= CanvasDOMMatrix
  globals.Path2D ??= CanvasPath2D
  globals.ImageData ??= CanvasImageData
}

function textFromItems(items: readonly unknown[]): string {
  let text = ''
  for (const item of items) {
    if (typeof item !== 'object' || item === null || !('str' in item)) continue
    const value = String((item as { readonly str: unknown }).str)
    if (value === '') continue
    if (text !== '' && needsAsciiWordSpace(text, value)) text += ' '
    text += value
    if ((item as { readonly hasEOL?: unknown }).hasEOL === true) text += '\n'
  }
  return text.replace(/[ \t]+\n/gu, '\n').trim()
}

function needsAsciiWordSpace(left: string, right: string): boolean {
  return /[A-Za-z0-9]$/u.test(left) && /^[A-Za-z0-9]/u.test(right)
}

function resolvedLimits(options: PdfReadOptions): {
  readonly maxInputBytes: number
  readonly maxDocumentPages: number
  readonly maxPageTextBytes: number
  readonly maxResultTextBytes: number
  readonly maxPagePixels: number
  readonly maxPageImageBytes: number
} {
  return {
    maxInputBytes: boundedLimit(options.maxInputBytes, PDF_READ_LIMITS.maxInputBytes, 'maxInputBytes'),
    maxDocumentPages: boundedLimit(options.maxDocumentPages, PDF_READ_LIMITS.maxDocumentPages, 'maxDocumentPages'),
    maxPageTextBytes: boundedLimit(options.maxPageTextBytes, PDF_READ_LIMITS.maxPageTextBytes, 'maxPageTextBytes'),
    maxResultTextBytes: boundedLimit(options.maxResultTextBytes, PDF_READ_LIMITS.maxResultTextBytes, 'maxResultTextBytes'),
    maxPagePixels: boundedLimit(options.maxPagePixels, PDF_READ_LIMITS.maxPagePixels, 'maxPagePixels'),
    maxPageImageBytes: boundedLimit(options.maxPageImageBytes, PDF_READ_LIMITS.maxPageImageBytes, 'maxPageImageBytes'),
  }
}

function boundedLimit(value: number | undefined, fallback: number, field: string): number {
  const selected = value ?? fallback
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > fallback) {
    throw new TypeError(`${field} must be an integer between 1 and ${fallback}`)
  }
  return selected
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer`)
  return value
}

function assertCanvasDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw new Error('PDF renderer requested invalid canvas dimensions')
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortReason(signal)
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('PDF read aborted')
}
