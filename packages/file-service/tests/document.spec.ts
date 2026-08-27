import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import * as XLSX from 'xlsx'
import type { Agent, ToolExecution } from '@georesearch/dsh-compat-rc5'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readStructuredAttachment } from '../src/document.js'
import {
  DeepSeekVisionError,
  fileTools,
  type GeoResearchFileService,
  type ImageUnderstandingAnalyzer,
} from '../src/index.js'
import type { ImageTextAnalyzer } from '../src/ocr.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('structured attachment reading', () => {
  it('extracts DOCX body, header, table, and footnote text without executing content', async () => {
    const path = await fixturePath('paper.docx', zipBytes([
      {
        name: 'word/document.xml',
        data: xml(`<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Title</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`),
      },
      { name: 'word/header1.xml', data: xml(`<w:hdr xmlns:w="urn:w"><w:p><w:r><w:t>Header text</w:t></w:r></w:p></w:hdr>`) },
      { name: 'word/footnotes.xml', data: xml(`<w:footnotes xmlns:w="urn:w"><w:footnote><w:p><w:r><w:t>Footnote text</w:t></w:r></w:p></w:footnote></w:footnotes>`) },
      { name: 'word/media/figure.png', data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) },
    ]))
    const result = await readStructuredAttachment(path, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(result).toMatchObject({ format: 'docx', extractionTruncated: false })
    expect(result.text).toContain('# Word document\nTitle')
    expect(result.text).toContain('A')
    expect(result.text).toContain('B')
    expect(result.text).toContain('## Header 1\nHeader text')
    expect(result.text).toContain('## Footnotes\nFootnote text')
    expect(result.images).toEqual([expect.objectContaining({ path: 'word/media/figure.png', mediaType: 'image/png' })])
  })

  it('reads PPTX slides and speaker notes in numeric order', async () => {
    const path = await fixturePath('talk.pptx', zipBytes([
      { name: 'ppt/slides/slide2.xml', data: presentationXml('Second slide') },
      { name: 'ppt/slides/slide1.xml', data: presentationXml('First slide') },
      { name: 'ppt/notesSlides/notesSlide1.xml', data: presentationXml('Explain the first result') },
    ]))
    const result = await readStructuredAttachment(path, 'application/vnd.openxmlformats-officedocument.presentationml.presentation')
    expect(result.format).toBe('pptx')
    expect(result.text.indexOf('# Slide 1')).toBeLessThan(result.text.indexOf('# Slide 2'))
    expect(result.text).toContain('First slide')
    expect(result.text).toContain('## Speaker notes\nExplain the first result')
  })

  it('maps PPTX content images to slide text and excludes the package thumbnail', async () => {
    const path = await fixturePath('visual-talk.pptx', zipBytes([
      { name: 'ppt/slides/slide1.xml', data: presentationXml('Study area and input imagery') },
      { name: 'ppt/slides/_rels/slide1.xml.rels', data: presentationRelationships('image1.png', 'image2.png') },
      { name: 'ppt/slides/slide2.xml', data: presentationXml('Regional classification results') },
      { name: 'ppt/slides/_rels/slide2.xml.rels', data: presentationRelationships('image3.png', 'image4.png', 'image5.png', 'image6.png') },
      { name: 'ppt/media/image1.png', data: pngBytes(1) },
      { name: 'ppt/media/image2.png', data: pngBytes(2) },
      { name: 'ppt/media/image3.png', data: pngBytes(3) },
      { name: 'ppt/media/image4.png', data: pngBytes(4) },
      { name: 'ppt/media/image5.png', data: pngBytes(5) },
      { name: 'ppt/media/image6.png', data: pngBytes(6) },
      { name: 'docProps/thumbnail.jpeg', data: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]) },
    ]))

    const result = await readStructuredAttachment(path, 'application/vnd.openxmlformats-officedocument.presentationml.presentation')

    expect(result.images.map(image => image.path)).toEqual([
      'ppt/media/image1.png',
      'ppt/media/image2.png',
      'ppt/media/image3.png',
      'ppt/media/image4.png',
      'ppt/media/image5.png',
      'ppt/media/image6.png',
    ])
    expect(result.images).toContainEqual(expect.objectContaining({
      path: 'ppt/media/image5.png',
      contexts: [{ kind: 'slide', index: 2, label: 'Slide 2', text: 'Regional classification results' }],
    }))
    expect(result.text).toContain('## Embedded images\n- ppt/media/image3.png')
    expect(result.text).not.toContain('docProps/thumbnail.jpeg')
  })

  it('reads XLSX shared strings, sheet names, cached values, and formulas', async () => {
    const path = await fixturePath('data.xlsx', zipBytes([
      { name: 'xl/sharedStrings.xml', data: xml('<sst><si><t>Name</t></si><si><t>Alice</t></si></sst>') },
      { name: 'xl/workbook.xml', data: xml('<workbook><sheets><sheet name="Observations" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      {
        name: 'xl/worksheets/sheet1.xml',
        data: xml('<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>4</v></c><c r="B2"><f>A2*2</f><v>8</v></c></row></sheetData></worksheet>'),
      },
    ]))
    const result = await readStructuredAttachment(path, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(result.text).toContain('# Worksheet: Observations')
    expect(result.text).toContain('A1="Name" | B1="Alice"')
    expect(result.text).toContain('B2="8" formula="A2*2"')
    expect(result.warnings.join(' ')).toMatch(/never executed/)
  })

  it('reads ODT, ODS, ODP, and EPUB visible text', async () => {
    const odt = await fixturePath('notes.odt', zipBytes([
      { name: 'content.xml', data: xml('<office:document-content><office:body><office:text><text:h>Heading</text:h><text:p>Paragraph</text:p></office:text></office:body></office:document-content>') },
    ]))
    expect((await readStructuredAttachment(odt, 'application/vnd.oasis.opendocument.text')).text).toContain('Heading\nParagraph')

    const ods = await fixturePath('table.ods', zipBytes([
      { name: 'content.xml', data: xml('<office:document-content><table:table table:name="Sheet A"><table:table-row><table:table-cell><text:p>X</text:p></table:table-cell><table:table-cell><text:p>Y</text:p></table:table-cell></table:table-row></table:table></office:document-content>') },
    ]))
    expect((await readStructuredAttachment(ods, 'application/vnd.oasis.opendocument.spreadsheet')).text).toContain('# Worksheet: Sheet A')

    const odp = await fixturePath('slides.odp', zipBytes([
      { name: 'content.xml', data: xml('<office:document-content><draw:page draw:name="Overview"><text:p>Result</text:p></draw:page></office:document-content>') },
    ]))
    expect((await readStructuredAttachment(odp, 'application/vnd.oasis.opendocument.presentation')).text).toContain('# Slide 1: Overview\nResult')

    const epub = await fixturePath('book.epub', zipBytes([
      { name: 'OPS/chapter2.xhtml', data: xml('<html><body><h1>Second</h1><p>Later text</p></body></html>') },
      { name: 'OPS/chapter1.xhtml', data: xml('<html><head><style>hidden</style></head><body><h1>First</h1><p>Visible text</p></body></html>') },
    ]))
    const book = await readStructuredAttachment(epub, 'application/epub+zip')
    expect(book.text.indexOf('chapter1.xhtml')).toBeLessThan(book.text.indexOf('chapter2.xhtml'))
    expect(book.text).toContain('First\nVisible text')
    expect(book.text).not.toContain('hidden')
  })

  it('normalizes Jupyter markdown, source code, text output, and rich-output markers', async () => {
    const path = await fixturePath('analysis.ipynb', Buffer.from(JSON.stringify({
      metadata: { kernelspec: { display_name: 'Python 3' }, language_info: { name: 'python' } },
      cells: [
        { cell_type: 'markdown', source: ['# Finding\n', 'Observed signal'] },
        {
          cell_type: 'code',
          source: ['print(2 + 2)'],
          outputs: [
            { output_type: 'stream', name: 'stdout', text: ['4\n'] },
            { output_type: 'display_data', data: { 'text/plain': ['<Figure>'], 'image/png': 'iVBORw==' } },
          ],
        },
      ],
    })))
    const result = await readStructuredAttachment(path, 'application/x-ipynb+json')
    expect(result.text).toContain('# Jupyter Notebook: Python 3')
    expect(result.text).toContain('## Markdown cell 1\n# Finding')
    expect(result.text).toContain('## Code cell 2\nprint(2 + 2)')
    expect(result.text).toContain('[stdout] 4')
    expect(result.images).toEqual([expect.objectContaining({ path: 'cell-2-output-2.png', mediaType: 'image/png' })])
  })

  it('does not impose an image-count cap on approved Notebook outputs', async () => {
    const outputs = Array.from({ length: 15 }, (_, index) => ({
      output_type: 'display_data',
      data: { 'text/plain': [`<Figure ${index + 1}>`], 'image/png': 'iVBORw==' },
    }))
    const path = await fixturePath('many-images.ipynb', Buffer.from(JSON.stringify({
      metadata: {},
      cells: [{ cell_type: 'code', source: ['figures'], outputs }],
    })))

    const result = await readStructuredAttachment(path, 'application/x-ipynb+json')

    expect(result.images).toHaveLength(15)
    expect(result.images.at(-1)).toMatchObject({ path: 'cell-1-output-15.png', mediaType: 'image/png' })
    expect(result.warnings.join(' ')).not.toMatch(/images were bounded at/u)
  })

  it('reads SQLite schemas and bounded row samples in read-only mode', async () => {
    const path = await fixturePath('observations.sqlite', Buffer.alloc(0))
    const sqlite = await import('node:sqlite')
    const database = new sqlite.DatabaseSync(path)
    database.exec('CREATE TABLE observations (id INTEGER, value TEXT); INSERT INTO observations VALUES (1, \'alpha\'), (2, \'beta\');')
    database.close()
    const result = await readStructuredAttachment(path, 'application/vnd.sqlite3')
    expect(result.text).toContain('# SQLite database')
    expect(result.text).toContain('## Table: observations')
    expect(result.text).toContain('"value":"alpha"')
    expect(result.text).toContain('"value":"beta"')
  })

  it('reads legacy XLS worksheet values without executing workbook content', async () => {
    const worksheet = XLSX.utils.aoa_to_sheet([
      ['Station', 'Value'],
      ['A', 4],
      ['B', 8],
    ])
    worksheet.B3 = { t: 'n', v: 8, f: 'B2*2' }
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Observations')
    const path = await fixturePath('observations.xls', XLSX.write(workbook, { type: 'buffer', bookType: 'xls' }) as Buffer)
    const result = await readStructuredAttachment(path, 'application/vnd.ms-excel')
    expect(result.format).toBe('xls')
    expect(result.text).toContain('# Worksheet: Observations')
    expect(result.text).toContain('A2="A"')
    expect(result.text).toContain('B3="8"')
    expect(result.warnings.join(' ')).toMatch(/never executed/)
  })

  it('rejects XML documents containing a DOCTYPE', async () => {
    const path = await fixturePath('unsafe.docx', zipBytes([
      { name: 'word/document.xml', data: '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "boom">]><w:document><w:p><w:t>&e;</w:t></w:p></w:document>' },
    ]))
    await expect(readStructuredAttachment(path, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
      .rejects.toMatchObject({ code: 'ATTACHMENT_MEDIA_UNREADABLE' })
  })

  it('automatically interprets multiple embedded document images with DeepSeek vision', async () => {
    const path = await fixturePath('paper.docx', zipBytes([
      { name: 'word/document.xml', data: xml(`<w:document xmlns:w="urn:w"><w:p><w:r><w:t>${'result '.repeat(80)}</w:t></w:r></w:p></w:document>`) },
      { name: 'word/media/figure.png', data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) },
      { name: 'word/media/map.jpg', data: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]) },
    ]))
    let imageNumber = 0
    const analyzeVision = vi.fn(async () => visionResult(`Embedded visual ${imageNumber += 1}`))
    const service = {
      maxDirectReadBytes: 128,
      imageUnderstandingAnalyzer: { analyze: analyzeVision } as ImageUnderstandingAnalyzer,
      requireRecord: async () => ({
        path,
        record: {
          attachmentId: '00000000-0000-4000-8000-000000000088',
          name: 'paper.docx',
          size: 1_024,
          mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          contentKind: 'document',
          readStrategy: 'document',
        },
      }),
    } as unknown as GeoResearchFileService
    const saveImage = vi.fn(async () => ({ attachmentId: 'embedded-image', mediaType: 'image/png' as const }))
    const ctx = {
      get(name: string) {
        if (name === 'attachments') return {
          imageLimits: {
            mediaTypes: ['image/png'],
            maxImagesPerMessage: 4,
            maxImageBytes: 5 * 1024 * 1024,
            maxMessageImageBytes: 20 * 1024 * 1024,
            maxImagePixels: 4_000_000,
          },
          saveImage,
        }
        if (name === 'llm') return { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
        return undefined
      },
    } as unknown as Context
    const tool = fileTools(ctx, service).find(candidate => candidate.name === 'attachment_read')!
    const args = { attachmentId: '00000000-0000-4000-8000-000000000088', byteOffset: 0 }
    const value = await tool.execute(args, {
      agent: {
        id: 'agent-doc',
        options: { provider: 'fixture', model: 'vision-fixture' },
        session: { id: 'session-doc', requestHeader: () => undefined },
      } as unknown as Agent,
      signal: new AbortController().signal,
    } as ToolExecution)
    const blocks = tool.output.render(args, value)
    expect(value).toMatchObject({
      kind: 'structured',
      format: 'docx',
      byteOffset: 0,
      truncated: true,
      visionImages: [
        expect.objectContaining({ analysis: expect.objectContaining({ text: 'Embedded visual 1' }) }),
        expect.objectContaining({ analysis: expect.objectContaining({ text: 'Embedded visual 2' }) }),
      ],
    })
    expect(blocks).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('<georesearch-document'),
    }))
    expect(blocks.map(block => block.type)).not.toContain('image')
    expect(blocks.filter(block => block.type === 'text'
      && block.text.includes('<georesearch-document-image-analysis'))).toHaveLength(2)
    expect(analyzeVision).toHaveBeenCalledTimes(2)
    expect(saveImage).not.toHaveBeenCalled()
  })

  it('analyzes every approved PPTX content image without a plugin count cap', async () => {
    const imageNames = Array.from({ length: 15 }, (_, index) => `image${index + 1}.png`)
    const path = await fixturePath('visual-talk.pptx', zipBytes([
      { name: 'ppt/slides/slide1.xml', data: presentationXml('Study area and input imagery') },
      { name: 'ppt/slides/_rels/slide1.xml.rels', data: presentationRelationships('image1.png', 'image2.png') },
      { name: 'ppt/slides/slide2.xml', data: presentationXml('Regional classification results') },
      { name: 'ppt/slides/_rels/slide2.xml.rels', data: presentationRelationships(...imageNames.slice(2)) },
      ...imageNames.map((name, index) => ({ name: `ppt/media/${name}`, data: pngBytes(index + 1) })),
      { name: 'docProps/thumbnail.jpeg', data: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]) },
    ]))
    let imageNumber = 0
    let activeVisionCalls = 0
    let maxActiveVisionCalls = 0
    const analyzeVision = vi.fn(async () => {
      const currentImage = imageNumber += 1
      activeVisionCalls += 1
      maxActiveVisionCalls = Math.max(maxActiveVisionCalls, activeVisionCalls)
      await new Promise(resolve => setTimeout(resolve, 5))
      activeVisionCalls -= 1
      return visionResult(`Embedded visual ${currentImage}`)
    })
    const service = {
      maxDirectReadBytes: 128 * 1024,
      imageUnderstandingAnalyzer: { analyze: analyzeVision } as ImageUnderstandingAnalyzer,
      requireRecord: async () => ({
        path,
        record: {
          attachmentId: '00000000-0000-4000-8000-000000000089',
          name: 'visual-talk.pptx',
          size: 2_048,
          mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          contentKind: 'document',
          readStrategy: 'document',
        },
      }),
    } as unknown as GeoResearchFileService
    const saveImage = vi.fn(async () => ({ attachmentId: 'embedded-image', mediaType: 'image/png' as const }))
    const ctx = {
      get(name: string) {
        if (name === 'attachments') return {
          imageLimits: {
            mediaTypes: ['image/png'],
            maxImagesPerMessage: 4,
            maxImageBytes: 5 * 1024 * 1024,
            maxMessageImageBytes: 20 * 1024 * 1024,
            maxImagePixels: 4_000_000,
          },
          saveImage,
        }
        if (name === 'llm') return { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
        return undefined
      },
    } as unknown as Context
    const tool = fileTools(ctx, service).find(candidate => candidate.name === 'attachment_read')!
    const args = { attachmentId: '00000000-0000-4000-8000-000000000089', byteOffset: 0 }
    const value = await tool.execute(args, {
      agent: {
        id: 'agent-ppt-vision',
        options: { provider: 'fixture', model: 'vision-fixture' },
        session: { id: 'session-ppt-vision', requestHeader: () => undefined },
      } as unknown as Agent,
      signal: new AbortController().signal,
    } as ToolExecution)
    const blocks = tool.output.render(args, value)

    expect(value).toMatchObject({
      kind: 'structured',
      format: 'pptx',
      visionImages: expect.arrayContaining([
        expect.objectContaining({
          path: 'ppt/media/image13.png',
          contexts: [{ kind: 'slide', index: 2, label: 'Slide 2', text: 'Regional classification results' }],
        }),
      ]),
    })
    expect((value as { readonly visionImages: readonly unknown[] }).visionImages).toHaveLength(15)
    expect((value as { readonly warnings: readonly string[] }).warnings.join(' ')).not.toMatch(/bounded at \d+ of \d+ items/u)
    expect(analyzeVision).toHaveBeenCalledTimes(15)
    expect(maxActiveVisionCalls).toBe(3)
    expect(analyzeVision.mock.calls.some(([request]) => (
      typeof request === 'object'
      && request !== null
      && 'question' in request
      && String(request.question).includes('Slide 2')
      && String(request.question).includes('Regional classification results')
    ))).toBe(true)
    expect(blocks.filter(block => block.type === 'text'
      && block.text.includes('<georesearch-document-image-analysis'))).toHaveLength(15)
    expect(blocks).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('slides="2"'),
    }))
    expect(saveImage).not.toHaveBeenCalled()
  })

  it('OCRs bounded Office embedded images for a text-only model route', async () => {
    const path = await fixturePath('paper.docx', zipBytes([
      { name: 'word/document.xml', data: xml('<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Caption</w:t></w:r></w:p></w:body></w:document>') },
      { name: 'word/media/map.png', data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) },
    ]))
    const analyze = vi.fn(async () => ocrResult('North arrow and scale bar'))
    const saveImage = vi.fn()
    const service = {
      maxDirectReadBytes: 4_096,
      imageUnderstandingAnalyzer: unavailableVision(),
      imageTextAnalyzer: { analyze, dispose: async () => undefined } as ImageTextAnalyzer,
      requireRecord: async () => ({
        path,
        record: {
          attachmentId: '00000000-0000-4000-8000-000000000087',
          name: 'paper.docx',
          size: 1_024,
          mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          contentKind: 'document',
          readStrategy: 'document',
        },
      }),
    } as unknown as GeoResearchFileService
    const ctx = {
      get(name: string) {
        if (name === 'attachments') return {
          imageLimits: {
            mediaTypes: ['image/png'],
            maxImagesPerMessage: 4,
            maxImageBytes: 5 * 1024 * 1024,
            maxMessageImageBytes: 20 * 1024 * 1024,
            maxImagePixels: 4_000_000,
          },
          saveImage,
        }
        if (name === 'llm') return { resolveModelInfo: async () => ({ inputModalities: ['text'] }) }
        return undefined
      },
    } as unknown as Context
    const tool = fileTools(ctx, service).find(candidate => candidate.name === 'attachment_read')!
    const args = { attachmentId: '00000000-0000-4000-8000-000000000087', byteOffset: 0 }
    const value = await tool.execute(args, {
      agent: {
        id: 'agent-doc-text',
        options: { provider: 'fixture', model: 'deepseek-text-fixture' },
        session: { id: 'session-doc-text', requestHeader: () => undefined },
      } as unknown as Agent,
      signal: new AbortController().signal,
    } as ToolExecution)
    const blocks = tool.output.render(args, value)

    expect(value).toMatchObject({
      kind: 'structured',
      ocrImages: [expect.objectContaining({
        path: 'word/media/map.png',
        ocr: expect.objectContaining({ text: 'North arrow and scale bar' }),
      })],
    })
    expect(blocks.map(block => block.type)).not.toContain('image')
    expect(blocks).toContainEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('<georesearch-document-image-ocr'),
    }))
    expect(analyze).toHaveBeenCalledOnce()
    expect(saveImage).not.toHaveBeenCalled()
  })
})

async function fixturePath(name: string, bytes: Uint8Array): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'georesearch-document-'))
  roots.push(root)
  const path = join(root, name)
  await writeFile(path, bytes)
  return path
}

function xml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>${body}`
}

function presentationXml(text: string): string {
  return xml(`<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:cSld></p:sld>`)
}

function presentationRelationships(...images: readonly string[]): string {
  const relationships = images.map((image, index) => (
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${image}"/>`
  )).join('')
  return xml(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`)
}

function pngBytes(id: number): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, id])
}

interface ZipEntryInput {
  readonly name: string
  readonly data: string | Uint8Array
}

function zipBytes(entries: readonly ZipEntryInput[]): Buffer {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name)
    const data = Buffer.from(entry.data)
    const crc = crc32(data)
    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(data.byteLength, 18)
    localHeader.writeUInt32LE(data.byteLength, 22)
    localHeader.writeUInt16LE(name.byteLength, 26)
    local.push(localHeader, name, data)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(0x0314, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(data.byteLength, 20)
    centralHeader.writeUInt32LE(data.byteLength, 24)
    centralHeader.writeUInt16LE(name.byteLength, 28)
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    central.push(centralHeader, name)
    offset += localHeader.byteLength + name.byteLength + data.byteLength
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBytes.byteLength, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, centralBytes, end])
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function ocrResult(text: string) {
  return {
    engine: 'tesseract.js/7.0.0' as const,
    languages: ['eng', 'chi_sim'],
    confidence: 91,
    text,
    lines: [{ text, confidence: 91, bbox: { x0: 3, y0: 4, x1: 120, y1: 24 } }],
    warnings: [],
  }
}

function unavailableVision(): ImageUnderstandingAnalyzer {
  return {
    analyze: async () => {
      throw new DeepSeekVisionError('HTTP_ERROR', 'DeepSeek vision API returned HTTP 503', { status: 503 })
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
    requestId: 'fixture-document-vision',
    usage: {
      promptTokens: 384,
      completionTokens: 20,
      totalTokens: 404,
      promptCacheHitTokens: 0,
      promptCacheMissTokens: 384,
      reasoningTokens: 0,
    },
    input: { mediaType: 'image/png' as const, bytes: 4, purpose: 'document-image' as const, detail: 'high' as const },
    warnings: [],
  }
}
