import { PDFDocument, createCanvas } from '@napi-rs/canvas'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ToolExecution } from '@georesearch/dsh-compat-rc5'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DeepSeekVisionError,
  fileTools,
  type GeoResearchFileService,
  type ImageUnderstandingAnalyzer,
} from '../src/index.js'
import type { ImageTextAnalyzer } from '../src/ocr.js'
import { PDF_READ_LIMITS, readPdfDocument } from '../src/pdf.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('bounded PDF reading', () => {
  it('extracts paged text and renders the complete selected page as JPEG', async () => {
    const result = await readPdfDocument(testPdf(), {
      page: 1,
      maxPages: 1,
      renderImages: true,
    })

    expect(result).toMatchObject({
      pageCount: 2,
      pageStart: 1,
      pageEnd: 1,
      nextPage: 2,
    })
    expect(result.pages[0]?.text).toContain('GeoResearch page one')
    expect(result.pages[0]?.textBytes).toBeGreaterThan(0)
    expect(result.pages[0]?.image?.data.subarray(0, 2)).toEqual(Uint8Array.from([0xff, 0xd8]))
    expect(result.pages[0]?.image?.width).toBeGreaterThan(0)
    expect(result.pages[0]?.image?.height).toBeGreaterThan(0)
  })

  it('automatically interprets multiple rendered PDF pages with DeepSeek vision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'georesearch-pdf-tool-'))
    roots.push(root)
    const path = join(root, 'paper.pdf')
    const bytes = testPdf()
    await writeFile(path, bytes)
    const saveImage = vi.fn(async (input: { readonly data: Uint8Array; readonly name?: string }) => ({
      attachmentId: 'image-attachment-1',
      mediaType: 'image/jpeg' as const,
      bytes: input.data.byteLength,
      width: 560,
      height: 385,
      ...(input.name === undefined ? {} : { name: input.name }),
    }))
    const ctx = {
      get(name: string) {
        if (name === 'attachments') {
          return {
            imageLimits: {
              mediaTypes: ['image/jpeg'],
              maxImagesPerMessage: 20,
              maxImageBytes: 5 * 1024 * 1024,
              maxMessageImageBytes: 100 * 1024 * 1024,
              maxImagePixels: 40_000_000,
            },
            saveImage,
          }
        }
        if (name === 'llm') return { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
        return undefined
      },
    } as unknown as Context
    let visualPage = 0
    const analyzeVision = vi.fn(async () => visionResult(`Visual interpretation for page ${visualPage += 1}`))
    const service = {
      imageUnderstandingAnalyzer: { analyze: analyzeVision } as ImageUnderstandingAnalyzer,
      requireRecord: async () => ({
        path,
        record: {
          attachmentId: '00000000-0000-4000-8000-000000000099',
          name: 'paper.pdf',
          size: bytes.byteLength,
          mediaType: 'application/pdf',
          contentKind: 'document',
          readStrategy: 'document',
        },
      }),
    } as unknown as GeoResearchFileService
    const tool = fileTools(ctx, service).find(candidate => candidate.name === 'attachment_read')!
    const args = { attachmentId: '00000000-0000-4000-8000-000000000099', page: 1, maxPages: 2 }
    const agent = {
      id: 'agent-pdf',
      options: { provider: 'fixture', model: 'vision-fixture' },
      session: { id: 'session-pdf', requestHeader: () => undefined },
    } as unknown as Agent

    const value = await tool.execute(args, {
      agent,
      signal: new AbortController().signal,
    } as ToolExecution)
    const blocks = tool.output.render(args, value)

    expect(value).toMatchObject({
      kind: 'pdf',
      pageCount: 2,
      pageStart: 1,
      pageEnd: 2,
      nextPage: null,
      pages: [
        expect.objectContaining({ analysis: expect.objectContaining({ text: 'Visual interpretation for page 1' }) }),
        expect.objectContaining({ analysis: expect.objectContaining({ text: 'Visual interpretation for page 2' }) }),
      ],
    })
    expect(blocks.map(block => block.type)).not.toContain('image')
    expect(blocks).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('GeoResearch page one'),
    }))
    expect(blocks.filter(block => block.type === 'text'
      && block.text.includes('<georesearch-pdf-page-analysis'))).toHaveLength(2)
    expect(analyzeVision).toHaveBeenCalledTimes(2)
    expect(saveImage).not.toHaveBeenCalled()
  })

  it('returns PDF page OCR instead of failing on a text-only model route', async () => {
    const root = await mkdtemp(join(tmpdir(), 'georesearch-pdf-ocr-tool-'))
    roots.push(root)
    const path = join(root, 'paper.pdf')
    const bytes = testPdf()
    await writeFile(path, bytes)
    const saveImage = vi.fn()
    const analyze = vi.fn(async () => ocrResult('Map legend: study area'))
    const ctx = {
      get(name: string) {
        if (name === 'attachments') {
          return {
            imageLimits: {
              mediaTypes: ['image/jpeg'],
              maxImagesPerMessage: 20,
              maxImageBytes: 5 * 1024 * 1024,
              maxMessageImageBytes: 100 * 1024 * 1024,
              maxImagePixels: 40_000_000,
            },
            saveImage,
          }
        }
        if (name === 'llm') return { resolveModelInfo: async () => ({ inputModalities: ['text'] }) }
        return undefined
      },
    } as unknown as Context
    const service = {
      imageUnderstandingAnalyzer: unavailableVision(),
      imageTextAnalyzer: { analyze, dispose: async () => undefined } as ImageTextAnalyzer,
      requireRecord: async () => ({
        path,
        record: {
          attachmentId: '00000000-0000-4000-8000-000000000098',
          name: 'paper.pdf',
          size: bytes.byteLength,
          mediaType: 'application/pdf',
          contentKind: 'document',
          readStrategy: 'document',
        },
      }),
    } as unknown as GeoResearchFileService
    const tool = fileTools(ctx, service).find(candidate => candidate.name === 'attachment_read')!
    const args = { attachmentId: '00000000-0000-4000-8000-000000000098', page: 1, maxPages: 1 }
    const value = await tool.execute(args, {
      agent: {
        id: 'agent-pdf-text',
        options: { provider: 'fixture', model: 'deepseek-text-fixture' },
        session: { id: 'session-pdf-text', requestHeader: () => undefined },
      } as unknown as Agent,
      signal: new AbortController().signal,
    } as ToolExecution)
    const blocks = tool.output.render(args, value)

    expect(value).toMatchObject({
      kind: 'pdf',
      pages: [expect.objectContaining({ ocr: expect.objectContaining({ text: 'Map legend: study area' }) })],
    })
    expect(blocks.map(block => block.type)).not.toContain('image')
    expect(blocks).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('<georesearch-pdf-page-ocr'),
    }))
    expect(analyze).toHaveBeenCalledOnce()
    expect(saveImage).not.toHaveBeenCalled()
  })

  it('continues from a 1-based page cursor and closes pagination at the document end', async () => {
    const result = await readPdfDocument(testPdf(), {
      page: 2,
      maxPages: 2,
      renderImages: false,
    })

    expect(result).toMatchObject({ pageCount: 2, pageStart: 2, pageEnd: 2, nextPage: null })
    expect(result.pages.map(page => page.text)).toEqual([expect.stringContaining('GeoResearch page two')])
    expect(result.pages[0]?.image).toBeUndefined()
  })

  it('fails closed for malformed and over-limit PDF input', async () => {
    await expect(readPdfDocument(Buffer.from('%PDF-1.7\nnot-a-document'), {
      renderImages: false,
    })).rejects.toThrow()
    await expect(readPdfDocument(testPdf(), {
      maxInputBytes: 32,
      renderImages: false,
    })).rejects.toThrow(/exceeds/i)
    expect(PDF_READ_LIMITS.maxPagesPerCall).toBeGreaterThanOrEqual(1)
  })
})

function testPdf(): Uint8Array {
  const document = new PDFDocument({ title: 'GeoResearch fixture' })
  const marker = createCanvas(48, 48)
  const markerContext = marker.getContext('2d')
  markerContext.fillStyle = '#c2410c'
  markerContext.fillRect(0, 0, 48, 48)
  markerContext.fillStyle = '#ffffff'
  markerContext.fillRect(14, 14, 20, 20)

  const first = document.beginPage(320, 220)
  first.fillStyle = '#ffffff'
  first.fillRect(0, 0, 320, 220)
  first.fillStyle = '#111827'
  first.font = '20px Arial'
  first.fillText('GeoResearch page one', 24, 42)
  first.drawImage(marker, 24, 72)
  document.endPage()

  const second = document.beginPage(320, 220)
  second.fillStyle = '#ffffff'
  second.fillRect(0, 0, 320, 220)
  second.fillStyle = '#111827'
  second.font = '20px Arial'
  second.fillText('GeoResearch page two', 24, 42)
  document.endPage()
  return document.close()
}

function ocrResult(text: string) {
  return {
    engine: 'tesseract.js/7.0.0' as const,
    languages: ['eng', 'chi_sim'],
    confidence: 94,
    text,
    lines: [{ text, confidence: 94, bbox: { x0: 1, y0: 2, x1: 100, y1: 20 } }],
    warnings: [],
  }
}

function unavailableVision(): ImageUnderstandingAnalyzer {
  return {
    analyze: async () => {
      throw new DeepSeekVisionError('TRANSPORT', 'DeepSeek vision request failed')
    },
  }
}

function visionResult(text: string) {
  return {
    engine: 'deepseek-api/chat-completions' as const,
    provider: 'deepseek' as const,
    model: 'deepseek-v4-flash-vision-exp' as const,
    releaseDate: '2026-08-21' as const,
    text,
    finishReason: 'stop',
    requestId: 'fixture-pdf-vision',
    usage: {
      promptTokens: 384,
      completionTokens: 20,
      totalTokens: 404,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 384,
      reasoningTokens: 0,
    },
    input: { mediaType: 'image/jpeg' as const, bytes: 1_024, purpose: 'pdf-page' as const, detail: 'high' as const },
    warnings: [],
  }
}
