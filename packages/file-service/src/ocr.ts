import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type Tesseract from 'tesseract.js'

export const OCR_LIMITS = Object.freeze({
  maxInputBytes: 20 * 1024 * 1024,
  maxTextBytes: 256 * 1024,
  maxLines: 500,
  maxLineBytes: 4 * 1024,
} as const)

export const OCR_LANGUAGES = ['eng', 'chi_sim'] as const

export interface OcrBoundingBox {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

export interface OcrLine {
  readonly text: string
  readonly confidence: number | null
  readonly bbox: OcrBoundingBox | null
}

export interface ImageTextAnalysis {
  readonly engine: 'tesseract.js/7.0.0'
  readonly languages: readonly string[]
  readonly confidence: number | null
  readonly text: string
  readonly lines: readonly OcrLine[]
  readonly warnings: readonly string[]
}

export interface ImageTextAnalyzer {
  analyze(data: Uint8Array, signal?: AbortSignal): Promise<ImageTextAnalysis>
  dispose(): Promise<void>
}

export class LocalImageOcr implements ImageTextAnalyzer {
  private workerPromise: Promise<Tesseract.Worker> | undefined
  private queue: Promise<void> = Promise.resolve()
  private disposed = false
  private readonly tesseract: typeof Tesseract

  constructor(private readonly assetRoot = defaultAssetRoot()) {
    this.tesseract = createRequire(join(this.assetRoot, 'loader.cjs'))('tesseract.js') as typeof Tesseract
  }

  analyze(data: Uint8Array, signal?: AbortSignal): Promise<ImageTextAnalysis> {
    if (data.byteLength === 0) return Promise.reject(new Error('OCR input is empty'))
    if (data.byteLength > OCR_LIMITS.maxInputBytes) {
      return Promise.reject(new Error(`OCR input exceeds ${OCR_LIMITS.maxInputBytes} bytes`))
    }
    return this.enqueue(async () => {
      abortIfNeeded(signal)
      if (this.disposed) throw new Error('OCR service is disposed')
      const workerPromise = this.worker()
      const worker = await abortable(workerPromise, signal, () => this.resetWorker(workerPromise))
      try {
        const result = await abortable(
          worker.recognize(Buffer.from(data), { rotateAuto: true }, { text: true, blocks: true }),
          signal,
          () => this.resetWorker(workerPromise),
        )
        return normalizeOcrPage(result.data)
      } catch (error) {
        this.resetWorker(workerPromise)
        throw error
      }
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.resetWorker(this.workerPromise)
    await this.queue.catch(() => undefined)
  }

  private worker(): Promise<Tesseract.Worker> {
    if (this.disposed) return Promise.reject(new Error('OCR service is disposed'))
    this.workerPromise ??= this.tesseract.createWorker(
      [...OCR_LANGUAGES],
      this.tesseract.OEM.LSTM_ONLY,
      {
        workerPath: join(this.assetRoot, 'worker.cjs'),
        langPath: join(this.assetRoot, 'lang'),
        cacheMethod: 'none',
        gzip: true,
        logger: () => undefined,
        errorHandler: () => undefined,
      },
    ).then(async worker => {
      await worker.setParameters({
        tessedit_pageseg_mode: this.tesseract.PSM.SPARSE_TEXT,
        preserve_interword_spaces: '1',
      })
      return worker
    })
    return this.workerPromise
  }

  private resetWorker(workerPromise: Promise<Tesseract.Worker> | undefined): void {
    if (workerPromise === undefined) return
    if (this.workerPromise === workerPromise) this.workerPromise = undefined
    void workerPromise.then(worker => worker.terminate()).catch(() => undefined)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const running = this.queue.then(operation, operation)
    this.queue = running.then(() => undefined, () => undefined)
    return running
  }
}

export function normalizeOcrPage(value: unknown): ImageTextAnalysis {
  const record = objectValue(value)
  const warnings: string[] = []
  const rawText = typeof record?.text === 'string' ? normalizeText(record.text) : ''
  const text = boundedUtf8(rawText, OCR_LIMITS.maxTextBytes)
  if (Buffer.byteLength(text, 'utf8') < Buffer.byteLength(rawText, 'utf8')) {
    warnings.push(`OCR text was bounded at ${OCR_LIMITS.maxTextBytes} bytes.`)
  }
  const lines: OcrLine[] = []
  for (const block of arrayValue(record?.blocks)) {
    for (const paragraph of arrayValue(objectValue(block)?.paragraphs)) {
      for (const line of arrayValue(objectValue(paragraph)?.lines)) {
        if (lines.length >= OCR_LIMITS.maxLines) break
        const lineRecord = objectValue(line)
        const rawLine = typeof lineRecord?.text === 'string' ? normalizeText(lineRecord.text) : ''
        if (rawLine.length === 0) continue
        lines.push({
          text: boundedUtf8(rawLine, OCR_LIMITS.maxLineBytes),
          confidence: confidenceValue(lineRecord?.confidence),
          bbox: boundingBox(lineRecord?.bbox),
        })
      }
      if (lines.length >= OCR_LIMITS.maxLines) break
    }
    if (lines.length >= OCR_LIMITS.maxLines) break
  }
  if (lines.length >= OCR_LIMITS.maxLines) warnings.push(`OCR layout was bounded at ${OCR_LIMITS.maxLines} lines.`)
  if (text.length === 0 && lines.length === 0) warnings.push('No OCR text was detected in the image.')
  return {
    engine: 'tesseract.js/7.0.0',
    languages: [...OCR_LANGUAGES],
    confidence: confidenceValue(record?.confidence),
    text,
    lines,
    warnings,
  }
}

function defaultAssetRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'assets', 'ocr')
}

function normalizeText(value: string): string {
  return value.normalize('NFC').replaceAll('\u0000', '').replace(/\r\n?/gu, '\n').trim()
}

function boundedUtf8(value: string, maxBytes: number): string {
  const source = Buffer.from(value, 'utf8')
  if (source.byteLength <= maxBytes) return value
  let end = maxBytes
  while (end > 0 && (source[end] ?? 0) >= 0x80 && (source[end] ?? 0) < 0xc0) end -= 1
  return source.subarray(0, end).toString('utf8').trimEnd()
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function arrayValue(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : []
}

function confidenceValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(100, value))
    : null
}

function boundingBox(value: unknown): OcrBoundingBox | null {
  const record = objectValue(value)
  if (record === undefined) return null
  const coordinates = [record.x0, record.y0, record.x1, record.y1]
  if (!coordinates.every(item => typeof item === 'number' && Number.isFinite(item))) return null
  const [x0, y0, x1, y1] = coordinates as [number, number, number, number]
  if (x0 < 0 || y0 < 0 || x1 < x0 || y1 < y0) return null
  return { x0, y0, x1, y1 }
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal | undefined, onAbort: () => void): Promise<T> {
  if (signal === undefined) return operation
  abortIfNeeded(signal)
  let listener: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => {
      onAbort()
      reject(abortReason(signal))
    }
    signal.addEventListener('abort', listener, { once: true })
  })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    if (listener !== undefined) signal.removeEventListener('abort', listener)
  }
}

function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortReason(signal)
}

function abortReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error('OCR operation aborted')
  error.name = 'AbortError'
  return error
}
