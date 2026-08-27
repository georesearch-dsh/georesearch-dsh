import { readFile, stat } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path/posix'
import { SaxesParser } from 'saxes'
import WordExtractor from 'word-extractor'
import * as XLSX from 'xlsx'
import type { CellObject } from 'xlsx'
import { GeoResearchError } from '@georesearch/dsh-contracts'
import { readZipEntries } from './archive.js'
import { decodeTextBytes } from './media.js'
import { readScientificAttachment } from './scientific-data.js'

export const STRUCTURED_READ_LIMITS = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024,
  maxSelectedZipBytes: 64 * 1024 * 1024,
  maxExtractedTextBytes: 8 * 1024 * 1024,
  maxNotebookCells: 10_000,
  maxSpreadsheetCells: 100_000,
  maxSqliteTables: 100,
  maxSqliteRowsPerTable: 50,
  maxLegacyOfficeSheets: 100,
  maxLegacyOfficeRowsPerSheet: 1_000,
  maxLegacyOfficeSlides: 1_000,
  maxEmbeddedImageBytes: 5 * 1024 * 1024,
  maxEmbeddedImageTotalBytes: 20 * 1024 * 1024,
  maxEmbeddedImageContextBytes: 32 * 1024,
} as const)

export type StructuredImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export interface StructuredImageContext {
  readonly kind: 'slide'
  readonly index: number
  readonly label: string
  readonly text: string
}

export interface StructuredEmbeddedImage {
  readonly path: string
  readonly mediaType: StructuredImageMediaType
  readonly data: Uint8Array
  readonly contexts?: readonly StructuredImageContext[]
}

export interface StructuredAttachmentRead {
  readonly format: string
  readonly text: string
  readonly extractedTextBytes: number
  readonly extractionTruncated: boolean
  readonly warnings: readonly string[]
  readonly images: readonly StructuredEmbeddedImage[]
}

interface XmlTag {
  readonly name: string
  readonly attributes: Readonly<Record<string, unknown>>
}

interface XmlHandlers {
  readonly open?: (tag: XmlTag) => void
  readonly text?: (text: string) => void
  readonly close?: (tag: XmlTag) => void
}

export async function readStructuredAttachment(
  path: string,
  mediaType: string,
  signal?: AbortSignal,
): Promise<StructuredAttachmentRead> {
  abortIfNeeded(signal)
  const size = (await stat(path)).size
  if (size > STRUCTURED_READ_LIMITS.maxInputBytes) {
    throw new GeoResearchError('ATTACHMENT_TOO_LARGE', `structured input exceeds ${STRUCTURED_READ_LIMITS.maxInputBytes} bytes`)
  }
  switch (mediaType) {
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return readDocx(path, signal)
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return readXlsx(path, signal)
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return readPptx(path, signal)
    case 'application/vnd.oasis.opendocument.text':
    case 'application/vnd.oasis.opendocument.spreadsheet':
    case 'application/vnd.oasis.opendocument.presentation':
      return readOpenDocument(path, mediaType, signal)
    case 'application/epub+zip':
      return readEpub(path, signal)
    case 'application/x-ipynb+json':
      return readNotebook(path, signal)
    case 'application/vnd.sqlite3':
      return readSqlite(path, signal)
    case 'application/msword':
      return readLegacyDoc(path, signal)
    case 'application/vnd.ms-excel':
      return readLegacyXls(path, signal)
    case 'application/vnd.ms-powerpoint':
      return readLegacyPpt(path, signal)
    case 'application/x-hdf5':
    case 'application/x-netcdf':
    case 'application/vnd.apache.parquet':
      return readScientificAttachment(path, mediaType, signal)
    default:
      throw new GeoResearchError('ATTACHMENT_MEDIA_UNREADABLE', `${mediaType} has no approved structured reader`)
  }
}

async function readDocx(path: string, signal?: AbortSignal): Promise<StructuredAttachmentRead> {
  const selected = await readZipEntries(path, structuredZipSelector(docxXmlPath), STRUCTURED_READ_LIMITS.maxSelectedZipBytes, signal)
  const document = selected.files.get('word/document.xml')
  if (document === undefined) throw unreadable('DOCX is missing word/document.xml')
  const sink = new TextSink()
  sink.line('# Word document')
  extractWordXml(document, 'word/document.xml', sink)
  for (const [entryPath, bytes] of sortedEntries(selected.files)) {
    if (entryPath === 'word/document.xml' || !docxXmlPath(entryPath)) continue
    sink.line()
    sink.line(`## ${documentPartLabel(entryPath)}`)
    extractWordXml(bytes, entryPath, sink)
  }
  const images = embeddedImages(selected.files)
  return result('docx', sink, structuredDocumentWarnings(selected.listing.entries, images), images)
}

async function readPptx(path: string, signal?: AbortSignal): Promise<StructuredAttachmentRead> {
  const selected = await readZipEntries(
    path,
    structuredZipSelector(pptxXmlPath, pptxEmbeddedImageMediaType),
    STRUCTURED_READ_LIMITS.maxSelectedZipBytes,
    signal,
  )
  const slides = sortedEntries(selected.files).filter(([entryPath]) => /^ppt\/slides\/slide[0-9]+\.xml$/u.test(entryPath))
  if (slides.length === 0) throw unreadable('PPTX contains no readable slides')
  const sink = new TextSink()
  const imageContexts = new Map<string, StructuredImageContext[]>()
  for (const [entryPath, bytes] of slides) {
    abortIfNeeded(signal)
    const slideNumber = numericSuffix(entryPath)
    const slideText = presentationText(bytes, entryPath)
    sink.line(`# Slide ${slideNumber}`)
    if (slideText !== '') sink.line(slideText)
    const notesPath = `ppt/notesSlides/notesSlide${slideNumber}.xml`
    const notes = selected.files.get(notesPath)
    const notesText = notes === undefined ? '' : presentationText(notes, notesPath)
    if (notes !== undefined) {
      sink.line('## Speaker notes')
      if (notesText !== '') sink.line(notesText)
    }
    const imagePaths = presentationSlideImages(selected.files, entryPath)
    if (imagePaths.length > 0) {
      sink.line('## Embedded images')
      for (const imagePath of imagePaths) sink.line(`- ${imagePath}`)
      const context: StructuredImageContext = {
        kind: 'slide',
        index: slideNumber,
        label: `Slide ${slideNumber}`,
        text: presentationContextText(slideText, notesText),
      }
      for (const imagePath of imagePaths) {
        const contexts = imageContexts.get(imagePath) ?? []
        contexts.push(context)
        imageContexts.set(imagePath, contexts)
      }
    }
    sink.line()
  }
  const images = embeddedImages(selected.files, pptxEmbeddedImageMediaType).map((image) => ({
    ...image,
    contexts: imageContexts.get(image.path) ?? [],
  }))
  return result(
    'pptx',
    sink,
    structuredDocumentWarnings(selected.listing.entries, images, pptxEmbeddedImageMediaType),
    images,
  )
}

async function readXlsx(path: string, signal?: AbortSignal): Promise<StructuredAttachmentRead> {
  const selected = await readZipEntries(path, structuredZipSelector(xlsxXmlPath), STRUCTURED_READ_LIMITS.maxSelectedZipBytes, signal)
  const sheets = sortedEntries(selected.files).filter(([entryPath]) => /^xl\/worksheets\/sheet[0-9]+\.xml$/u.test(entryPath))
  if (sheets.length === 0) throw unreadable('XLSX contains no readable worksheets')
  const sharedStrings = selected.files.get('xl/sharedStrings.xml')
  const strings = sharedStrings === undefined ? [] : parseSharedStrings(sharedStrings, 'xl/sharedStrings.xml')
  const workbook = selected.files.get('xl/workbook.xml')
  const sheetNames = workbook === undefined ? [] : parseWorkbookSheetNames(workbook)
  const sink = new TextSink()
  let cellCount = 0
  const warnings: string[] = []
  for (let index = 0; index < sheets.length; index += 1) {
    abortIfNeeded(signal)
    const [entryPath, bytes] = sheets[index] as [string, Uint8Array]
    sink.line(`# Worksheet: ${sheetNames[index] ?? `Sheet ${index + 1}`}`)
    cellCount += extractWorksheetXml(bytes, entryPath, strings, sink, STRUCTURED_READ_LIMITS.maxSpreadsheetCells - cellCount)
    sink.line()
    if (cellCount >= STRUCTURED_READ_LIMITS.maxSpreadsheetCells) {
      warnings.push(`Workbook cell extraction stopped at ${STRUCTURED_READ_LIMITS.maxSpreadsheetCells} cells.`)
      break
    }
  }
  warnings.push('Excel formulas are shown with cached values; workbook formulas and macros are never executed.')
  const images = embeddedImages(selected.files)
  warnings.push(...structuredDocumentWarnings(selected.listing.entries, images))
  return result('xlsx', sink, warnings, images)
}

async function readOpenDocument(
  path: string,
  mediaType: string,
  signal?: AbortSignal,
): Promise<StructuredAttachmentRead> {
  const selected = await readZipEntries(path, structuredZipSelector(entryPath => entryPath === 'content.xml'), STRUCTURED_READ_LIMITS.maxSelectedZipBytes, signal)
  const content = selected.files.get('content.xml')
  if (content === undefined) throw unreadable('OpenDocument file is missing content.xml')
  const sink = new TextSink()
  const kind = mediaType.endsWith('.spreadsheet') ? 'ods' : mediaType.endsWith('.presentation') ? 'odp' : 'odt'
  extractOpenDocumentXml(content, kind, sink)
  const warnings = kind === 'ods' ? ['Spreadsheet formulas are not executed; stored text and values are returned.'] : []
  const images = embeddedImages(selected.files)
  warnings.push(...structuredDocumentWarnings(selected.listing.entries, images))
  return result(kind, sink, warnings, images)
}

async function readEpub(path: string, signal?: AbortSignal): Promise<StructuredAttachmentRead> {
  const selected = await readZipEntries(
    path,
    structuredZipSelector(entryPath => /\.(?:xhtml|html|htm)$/iu.test(entryPath)),
    STRUCTURED_READ_LIMITS.maxSelectedZipBytes,
    signal,
  )
  const chapters = sortedEntries(selected.files).filter(([entryPath]) => /\.(?:xhtml|html|htm)$/iu.test(entryPath))
  if (chapters.length === 0) throw unreadable('EPUB contains no readable XHTML or HTML chapters')
  const sink = new TextSink()
  for (const [entryPath, bytes] of chapters) {
    abortIfNeeded(signal)
    sink.line(`# Chapter: ${entryPath}`)
    extractXhtml(bytes, entryPath, sink)
    sink.line()
  }
  const images = embeddedImages(selected.files)
  return result('epub', sink, structuredDocumentWarnings(selected.listing.entries, images), images)
}

async function readNotebook(path: string, signal?: AbortSignal): Promise<StructuredAttachmentRead> {
  abortIfNeeded(signal)
  const source = await readFile(path, { signal })
  let parsed: unknown
  try {
    parsed = JSON.parse(source.toString('utf8')) as unknown
  } catch (error) {
    throw unreadable('Jupyter Notebook is not valid JSON', error)
  }
  const notebook = objectValue(parsed)
  if (notebook === undefined) throw unreadable('Jupyter Notebook root is not an object')
  const cells = Array.isArray(notebook.cells) ? notebook.cells : undefined
  if (cells === undefined) throw unreadable('Jupyter Notebook has no cells array')
  if (cells.length > STRUCTURED_READ_LIMITS.maxNotebookCells) {
    throw new GeoResearchError('ATTACHMENT_TOO_LARGE', `Notebook exceeds ${STRUCTURED_READ_LIMITS.maxNotebookCells} cells`)
  }
  const sink = new TextSink()
  const metadata = objectValue(notebook.metadata, false)
  const kernel = objectValue(metadata?.kernelspec, false)
  const language = objectValue(metadata?.language_info, false)
  const images: StructuredEmbeddedImage[] = []
  const warnings = ['Notebook code, widgets, JavaScript, and rich outputs are never executed.']
  sink.line(`# Jupyter Notebook${textValue(kernel?.display_name) === undefined ? '' : `: ${textValue(kernel?.display_name)}`}`)
  if (textValue(language?.name) !== undefined) sink.line(`Language: ${textValue(language?.name)}`)
  for (let index = 0; index < cells.length; index += 1) {
    abortIfNeeded(signal)
    const cell = objectValue(cells[index], false)
    if (cell === undefined) continue
    const type = textValue(cell.cell_type) ?? 'unknown'
    sink.line()
    sink.line(`## ${titleCase(type)} cell ${index + 1}`)
    sink.line(joinText(cell.source))
    if (type === 'code') appendNotebookOutputs(cell.outputs, sink, images, warnings, index + 1)
  }
  return result('ipynb', sink, warnings, images)
}

async function readSqlite(path: string, signal?: AbortSignal): Promise<StructuredAttachmentRead> {
  abortIfNeeded(signal)
  const sqlite = await import('node:sqlite')
  const database = new sqlite.DatabaseSync(path, { readOnly: true, allowExtension: false })
  const sink = new TextSink()
  const warnings: string[] = []
  try {
    database.exec('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;')
    const rows = database.prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT ?",
    ).all(STRUCTURED_READ_LIMITS.maxSqliteTables + 1) as Array<Record<string, unknown>>
    if (rows.length > STRUCTURED_READ_LIMITS.maxSqliteTables) {
      warnings.push(`Database table listing stopped at ${STRUCTURED_READ_LIMITS.maxSqliteTables} tables.`)
    }
    const tables = rows.slice(0, STRUCTURED_READ_LIMITS.maxSqliteTables)
    sink.line('# SQLite database')
    if (tables.length === 0) sink.line('No user tables found.')
    for (const table of tables) {
      abortIfNeeded(signal)
      const name = textValue(table.name)
      if (name === undefined) continue
      const schema = textValue(table.sql) ?? ''
      sink.line()
      sink.line(`## Table: ${name}`)
      sink.line(`Schema: ${schema}`)
      if (/^CREATE\s+VIRTUAL\s+TABLE/iu.test(schema)) {
        sink.line('[Virtual table rows skipped]')
        continue
      }
      const sample = database.prepare(
        `SELECT * FROM ${quoteIdentifier(name)} LIMIT ${STRUCTURED_READ_LIMITS.maxSqliteRowsPerTable + 1}`,
      ).all() as Array<Record<string, unknown>>
      for (const row of sample.slice(0, STRUCTURED_READ_LIMITS.maxSqliteRowsPerTable)) {
        sink.line(JSON.stringify(sqliteJsonRow(row)))
      }
      if (sample.length > STRUCTURED_READ_LIMITS.maxSqliteRowsPerTable) sink.line('[More rows omitted]')
    }
  } catch (error) {
    throw unreadable('SQLite content could not be read safely', error)
  } finally {
    database.close()
  }
  return result('sqlite', sink, warnings)
}

async function readLegacyDoc(path: string, signal?: AbortSignal): Promise<StructuredAttachmentRead> {
  abortIfNeeded(signal)
  let document: Awaited<ReturnType<WordExtractor['extract']>>
  try {
    document = await new WordExtractor().extract(path)
  } catch (error) {
    throw unreadable('legacy Word content could not be read safely', error)
  }
  abortIfNeeded(signal)
  const sink = new TextSink()
  sink.line('# Word 97-2003 document')
  appendLegacySection(sink, 'Body', document.getBody())
  appendLegacySection(sink, 'Headers', document.getHeaders({ includeFooters: false }))
  appendLegacySection(sink, 'Footers', document.getFooters())
  appendLegacySection(sink, 'Footnotes', document.getFootnotes())
  appendLegacySection(sink, 'Endnotes', document.getEndnotes())
  appendLegacySection(sink, 'Comments', document.getAnnotations())
  appendLegacySection(sink, 'Text boxes', document.getTextboxes())
  return result('doc', sink, ['Macros, embedded objects, fields, and active content are never executed.'])
}

async function readLegacyXls(path: string, signal?: AbortSignal): Promise<StructuredAttachmentRead> {
  const source = await readFile(path, { signal })
  abortIfNeeded(signal)
  let workbook: XLSX.WorkBook
  try {
    workbook = XLSX.read(source, {
      type: 'buffer',
      WTF: false,
      bookDeps: false,
      bookFiles: false,
      bookProps: false,
      bookSheets: false,
      bookVBA: false,
      cellFormula: true,
      cellHTML: false,
      cellNF: false,
      cellText: true,
      sheetRows: STRUCTURED_READ_LIMITS.maxLegacyOfficeRowsPerSheet + 1,
    })
  } catch (error) {
    throw unreadable('legacy Excel content could not be read safely', error)
  }
  if (workbook.SheetNames.length === 0) throw unreadable('legacy Excel workbook contains no worksheets')
  const sink = new TextSink()
  const warnings = ['Excel formulas are shown with stored values; formulas, macros, links, and active content are never executed.']
  let cells = 0
  const sheets = workbook.SheetNames.slice(0, STRUCTURED_READ_LIMITS.maxLegacyOfficeSheets)
  for (const sheetName of sheets) {
    abortIfNeeded(signal)
    sink.line(`# Worksheet: ${sheetName}`)
    const sheet = workbook.Sheets[sheetName]
    if (sheet === undefined) {
      sink.line('[Worksheet data is missing]')
      continue
    }
    const addresses = Object.keys(sheet).filter(key => !key.startsWith('!')).sort(compareCellAddresses)
    for (const address of addresses) {
      if (cells >= STRUCTURED_READ_LIMITS.maxSpreadsheetCells) break
      const cell = sheet[address] as CellObject | undefined
      if (cell === undefined || typeof cell !== 'object') continue
      cells += 1
      sink.line(`${address}=${JSON.stringify(legacyCellValue(cell))}${cell.f === undefined ? '' : ` formula=${JSON.stringify(cell.f)}`}`)
    }
    sink.line()
    if (cells >= STRUCTURED_READ_LIMITS.maxSpreadsheetCells) {
      warnings.push(`Workbook cell extraction stopped at ${STRUCTURED_READ_LIMITS.maxSpreadsheetCells} cells.`)
      break
    }
  }
  if (workbook.SheetNames.length > sheets.length) {
    warnings.push(`Workbook worksheet extraction stopped at ${STRUCTURED_READ_LIMITS.maxLegacyOfficeSheets} sheets.`)
  }
  return result('xls', sink, warnings)
}

async function readLegacyPpt(path: string, signal?: AbortSignal): Promise<StructuredAttachmentRead> {
  const source = await readFile(path, { signal })
  abortIfNeeded(signal)
  let slides: string[]
  try {
    const globals = globalThis as typeof globalThis & {
      CFB?: unknown
      cptable?: { readonly utils: { readonly decode: (codepage: number, bytes: Uint8Array) => string } }
    }
    if (globals.CFB === undefined) globals.CFB = XLSX.CFB
    if (globals.cptable === undefined) {
      globals.cptable = {
        utils: {
          decode(codepage, bytes) {
            if (codepage !== 1200) throw new TypeError(`legacy PowerPoint requested unsupported codepage ${codepage}`)
            return Buffer.from(bytes).toString('utf16le')
          },
        },
      }
    }
    const { default: PPT } = await import('ppt-to-text')
    abortIfNeeded(signal)
    slides = PPT.utils.to_text(PPT.readBuffer(source, { WTF: false }))
  } catch (error) {
    throw unreadable('legacy PowerPoint content could not be read safely', error)
  }
  const sink = new TextSink()
  const warnings = ['Macros, embedded OLE objects, links, transitions, and active content are never executed.']
  const selected = slides.slice(0, STRUCTURED_READ_LIMITS.maxLegacyOfficeSlides)
  if (selected.length === 0) sink.line('# PowerPoint 97-2003 presentation\nNo readable slide text found.')
  for (let index = 0; index < selected.length; index += 1) {
    abortIfNeeded(signal)
    sink.line(`# Slide ${index + 1}`)
    sink.line(cleanLegacyText(selected[index] ?? ''))
    sink.line()
  }
  if (slides.length > selected.length) {
    warnings.push(`Presentation extraction stopped at ${STRUCTURED_READ_LIMITS.maxLegacyOfficeSlides} slides.`)
  }
  return result('ppt', sink, warnings)
}

function appendLegacySection(sink: TextSink, heading: string, value: string): void {
  const text = cleanLegacyText(value).trim()
  if (text === '') return
  sink.line()
  sink.line(`## ${heading}`)
  sink.line(text)
}

function cleanLegacyText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
}

function compareCellAddresses(left: string, right: string): number {
  try {
    const a = XLSX.utils.decode_cell(left)
    const b = XLSX.utils.decode_cell(right)
    return a.r - b.r || a.c - b.c
  } catch {
    return left.localeCompare(right, 'en')
  }
}

function legacyCellValue(cell: CellObject): string | number | boolean | null {
  if (cell.w !== undefined) return cell.w
  if (cell.v instanceof Date) return cell.v.toISOString()
  if (typeof cell.v === 'string' || typeof cell.v === 'number' || typeof cell.v === 'boolean') return cell.v
  return null
}

function extractWordXml(bytes: Uint8Array, entryPath: string, sink: TextSink): void {
  let capture = 0
  parseXml(bytes, entryPath, {
    open: (tag) => {
      const name = localName(tag.name)
      if (name === 't') capture += 1
      else if (name === 'tab') sink.append('\t')
      else if (name === 'br' || name === 'cr') sink.line()
    },
    text: text => { if (capture > 0) sink.append(text) },
    close: (tag) => {
      const name = localName(tag.name)
      if (name === 't') capture = Math.max(0, capture - 1)
      else if (name === 'p' || name === 'tr') sink.line()
      else if (name === 'tc') sink.append('\t')
    },
  })
}

function extractPresentationXml(bytes: Uint8Array, entryPath: string, sink: TextSink): void {
  let capture = 0
  parseXml(bytes, entryPath, {
    open: (tag) => { if (localName(tag.name) === 't') capture += 1 },
    text: text => { if (capture > 0) sink.append(text) },
    close: (tag) => {
      const name = localName(tag.name)
      if (name === 't') capture = Math.max(0, capture - 1)
      else if (name === 'p') sink.line()
    },
  })
}

function presentationText(bytes: Uint8Array, entryPath: string): string {
  const sink = new TextSink(STRUCTURED_READ_LIMITS.maxEmbeddedImageContextBytes)
  extractPresentationXml(bytes, entryPath, sink)
  return sink.finish()
}

function presentationContextText(slideText: string, notesText: string): string {
  const sink = new TextSink(STRUCTURED_READ_LIMITS.maxEmbeddedImageContextBytes)
  if (slideText !== '') sink.line(slideText)
  if (notesText !== '') {
    sink.line('Speaker notes:')
    sink.line(notesText)
  }
  return sink.finish()
}

function parseSharedStrings(bytes: Uint8Array, entryPath: string): string[] {
  const values: string[] = []
  let insideItem = false
  let capture = 0
  let current = ''
  parseXml(bytes, entryPath, {
    open: (tag) => {
      const name = localName(tag.name)
      if (name === 'si') {
        insideItem = true
        current = ''
      } else if (insideItem && name === 't') capture += 1
    },
    text: text => { if (capture > 0) current += text },
    close: (tag) => {
      const name = localName(tag.name)
      if (name === 't') capture = Math.max(0, capture - 1)
      else if (name === 'si') {
        values.push(current)
        insideItem = false
      }
    },
  })
  return values
}

function parseWorkbookSheetNames(bytes: Uint8Array): string[] {
  const names: string[] = []
  parseXml(bytes, 'xl/workbook.xml', {
    open: (tag) => {
      if (localName(tag.name) !== 'sheet') return
      const name = attribute(tag, 'name')
      if (name !== undefined) names.push(name)
    },
  })
  return names
}

function extractWorksheetXml(
  bytes: Uint8Array,
  entryPath: string,
  sharedStrings: readonly string[],
  sink: TextSink,
  remainingCells: number,
): number {
  let cells = 0
  let cellRef = ''
  let cellType = ''
  let value = ''
  let formula = ''
  let inlineText = ''
  let capture: 'value' | 'formula' | 'inline' | undefined
  let rowValues: string[] = []
  parseXml(bytes, entryPath, {
    open: (tag) => {
      const name = localName(tag.name)
      if (name === 'row') rowValues = []
      else if (name === 'c') {
        cellRef = attribute(tag, 'r') ?? `cell-${cells + 1}`
        cellType = attribute(tag, 't') ?? ''
        value = ''
        formula = ''
        inlineText = ''
      } else if (name === 'v') capture = 'value'
      else if (name === 'f') capture = 'formula'
      else if (name === 't' && cellType === 'inlineStr') capture = 'inline'
    },
    text: (text) => {
      if (capture === 'value') value += text
      else if (capture === 'formula') formula += text
      else if (capture === 'inline') inlineText += text
    },
    close: (tag) => {
      const name = localName(tag.name)
      if (name === 'v' || name === 'f' || name === 't') capture = undefined
      else if (name === 'c' && cells < remainingCells) {
        cells += 1
        const rendered = spreadsheetValue(cellType, value, inlineText, sharedStrings)
        rowValues.push(`${cellRef}=${JSON.stringify(rendered)}${formula === '' ? '' : ` formula=${JSON.stringify(formula)}`}`)
      } else if (name === 'row' && rowValues.length > 0) sink.line(rowValues.join(' | '))
    },
  })
  return cells
}

function extractOpenDocumentXml(bytes: Uint8Array, kind: 'odt' | 'ods' | 'odp', sink: TextSink): void {
  let capture = 0
  let slide = 0
  parseXml(bytes, 'content.xml', {
    open: (tag) => {
      const qualified = tag.name.toLowerCase()
      const name = localName(qualified)
      if (kind === 'odp' && qualified === 'draw:page') {
        slide += 1
        sink.line(`# Slide ${slide}${attribute(tag, 'draw:name') === undefined ? '' : `: ${attribute(tag, 'draw:name')}`}`)
      } else if (kind === 'ods' && qualified === 'table:table') {
        sink.line(`# Worksheet: ${attribute(tag, 'table:name') ?? 'Unnamed'}`)
      }
      if (name === 'p' || name === 'h' || name === 'span' || name === 'a') capture += 1
      else if (name === 'tab') sink.append('\t')
      else if (name === 'line-break') sink.line()
      else if (kind === 'ods' && qualified === 'table:table-cell') sink.append('\t')
    },
    text: text => { if (capture > 0) sink.append(text) },
    close: (tag) => {
      const qualified = tag.name.toLowerCase()
      const name = localName(qualified)
      if (name === 'p' || name === 'h' || name === 'span' || name === 'a') {
        capture = Math.max(0, capture - 1)
        if (name === 'p' || name === 'h') sink.line()
      } else if (kind === 'ods' && qualified === 'table:table-row') sink.line()
      else if ((kind === 'odp' && qualified === 'draw:page') || (kind === 'ods' && qualified === 'table:table')) sink.line()
    },
  })
}

function extractXhtml(bytes: Uint8Array, entryPath: string, sink: TextSink): void {
  const blocked: string[] = []
  parseXml(bytes, entryPath, {
    open: (tag) => {
      const name = localName(tag.name).toLowerCase()
      if (name === 'script' || name === 'style' || name === 'head' || name === 'svg') blocked.push(name)
      else if (name === 'br') sink.line()
    },
    text: text => { if (blocked.length === 0) sink.append(text) },
    close: (tag) => {
      const name = localName(tag.name).toLowerCase()
      if (blocked.at(-1) === name) blocked.pop()
      if (blocked.length === 0 && BLOCK_ELEMENTS.has(name)) sink.line()
    },
  })
}

function parseXml(bytes: Uint8Array, entryPath: string, handlers: XmlHandlers): void {
  const decoded = decodeTextBytes(bytes)
  if (decoded === undefined) throw unreadable(`${entryPath} is not UTF-8/UTF-16 XML`)
  const parser = new SaxesParser({ xmlns: false, position: true, fileName: entryPath })
  parser.ENTITIES.nbsp = '\u00a0'
  parser.ENTITIES.copy = '\u00a9'
  parser.ENTITIES.reg = '\u00ae'
  parser.on('doctype', () => { throw unreadable(`${entryPath} contains a forbidden DOCTYPE`) })
  parser.on('error', error => { throw unreadable(`${entryPath} is malformed XML`, error) })
  parser.on('opentag', tag => handlers.open?.(tag as unknown as XmlTag))
  parser.on('text', text => handlers.text?.(text))
  parser.on('cdata', text => handlers.text?.(text))
  parser.on('closetag', tag => handlers.close?.(tag as unknown as XmlTag))
  parser.write(decoded.text).close()
}

function appendNotebookOutputs(
  value: unknown,
  sink: TextSink,
  images: StructuredEmbeddedImage[],
  warnings: string[],
  cellNumber: number,
): void {
  if (!Array.isArray(value)) return
  for (let outputIndex = 0; outputIndex < value.length; outputIndex += 1) {
    const candidate = value[outputIndex]
    const output = objectValue(candidate, false)
    if (output === undefined) continue
    const type = textValue(output.output_type) ?? 'output'
    if (type === 'stream') sink.line(`[${textValue(output.name) ?? 'stream'}] ${joinText(output.text)}`)
    else if (type === 'error') sink.line(`[error ${textValue(output.ename) ?? ''}] ${textValue(output.evalue) ?? ''}\n${joinText(output.traceback)}`)
    else {
      const data = objectValue(output.data, false)
      const plain = data === undefined ? undefined : joinText(data['text/plain'])
      if (plain !== '') sink.line(`[${type}] ${plain}`)
      if (data !== undefined) appendNotebookImages(data, images, warnings, cellNumber, outputIndex + 1)
      const rich = data === undefined ? [] : Object.keys(data).filter(key => key !== 'text/plain' && embeddedImageMediaType(`output.${key.split('/').at(-1) ?? ''}`) === undefined)
      if (rich.length > 0) sink.line(`[rich output omitted: ${rich.join(', ')}]`)
    }
  }
}

function appendNotebookImages(
  data: Record<string, unknown>,
  images: StructuredEmbeddedImage[],
  warnings: string[],
  cellNumber: number,
  outputNumber: number,
): void {
  for (const mediaType of ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const) {
    const encoded = joinText(data[mediaType]).replace(/\s+/gu, '')
    if (encoded === '') continue
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
      warnings.push(`Notebook cell ${cellNumber} output ${outputNumber} contains invalid ${mediaType} data.`)
      continue
    }
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.byteLength > STRUCTURED_READ_LIMITS.maxEmbeddedImageBytes
      || embeddedImageBytes(images) + bytes.byteLength > STRUCTURED_READ_LIMITS.maxEmbeddedImageTotalBytes) {
      warnings.push(`Notebook cell ${cellNumber} output ${outputNumber} image exceeds the bounded image budget.`)
      continue
    }
    images.push({
      path: `cell-${cellNumber}-output-${outputNumber}.${mediaType.split('/')[1]}`,
      mediaType,
      data: bytes,
    })
  }
}

function spreadsheetValue(type: string, value: string, inlineText: string, sharedStrings: readonly string[]): string {
  if (type === 's') return sharedStrings[Number.parseInt(value, 10)] ?? value
  if (type === 'b') return value === '1' ? 'TRUE' : 'FALSE'
  if (type === 'inlineStr' || type === 'str') return inlineText || value
  if (type === 'e') return `#ERROR:${value}`
  return value
}

function sqliteJsonRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, sqliteJsonValue(value)]))
}

function sqliteJsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString()
  if (value instanceof Uint8Array) return `<binary:${value.byteLength} bytes>`
  return value
}

function result(
  format: string,
  sink: TextSink,
  warnings: readonly string[] = [],
  images: readonly StructuredEmbeddedImage[] = [],
): StructuredAttachmentRead {
  const text = sink.finish()
  return {
    format,
    text,
    extractedTextBytes: Buffer.byteLength(text),
    extractionTruncated: sink.truncated,
    warnings: [...warnings, ...(sink.truncated ? [`Extracted text was bounded at ${STRUCTURED_READ_LIMITS.maxExtractedTextBytes} bytes.`] : [])],
    images,
  }
}

type EmbeddedImageMediaType = (path: string) => StructuredImageMediaType | undefined

function structuredZipSelector(
  content: (path: string) => boolean,
  imageMediaType: EmbeddedImageMediaType = embeddedImageMediaType,
): (entry: SafeArchiveEntryLike) => boolean {
  let imageBytes = 0
  return (entry) => {
    if (content(entry.path)) return true
    if (imageMediaType(entry.path) === undefined
      || entry.size > STRUCTURED_READ_LIMITS.maxEmbeddedImageBytes
      || imageBytes + entry.size > STRUCTURED_READ_LIMITS.maxEmbeddedImageTotalBytes) return false
    imageBytes += entry.size
    return true
  }
}

interface SafeArchiveEntryLike {
  readonly path: string
  readonly size: number
}

function embeddedImages(
  files: ReadonlyMap<string, Uint8Array>,
  imageMediaType: EmbeddedImageMediaType = embeddedImageMediaType,
): StructuredEmbeddedImage[] {
  const images: StructuredEmbeddedImage[] = []
  for (const [path, data] of sortedEntries(files)) {
    const mediaType = imageMediaType(path)
    if (mediaType !== undefined) images.push({ path, mediaType, data })
  }
  return images
}

function structuredDocumentWarnings(
  entries: readonly SafeArchiveEntryLike[],
  images: readonly StructuredEmbeddedImage[],
  imageMediaType: EmbeddedImageMediaType = embeddedImageMediaType,
): string[] {
  const availableImages = entries.filter(entry => imageMediaType(entry.path) !== undefined).length
  const warnings = ['Document layout, macros, animations, and active content are not executed or reproduced.']
  if (availableImages > images.length) {
    warnings.push(`Embedded raster images were bounded at ${images.length} of ${availableImages} readable items.`)
  }
  return warnings
}

function embeddedImageBytes(images: readonly StructuredEmbeddedImage[]): number {
  return images.reduce((sum, image) => sum + image.data.byteLength, 0)
}

function embeddedImageMediaType(path: string): StructuredImageMediaType | undefined {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  return undefined
}

function pptxEmbeddedImageMediaType(path: string): StructuredImageMediaType | undefined {
  const normalized = path.toLowerCase()
  if (!/^ppt\/media\/[^/]+$/u.test(normalized)) return undefined
  return embeddedImageMediaType(normalized)
}

function docxXmlPath(path: string): boolean {
  return path === 'word/document.xml'
    || /^word\/(?:header|footer)[0-9]+\.xml$/u.test(path)
    || /^word\/(?:footnotes|endnotes|comments)\.xml$/u.test(path)
}

function pptxXmlPath(path: string): boolean {
  return /^ppt\/(?:slides\/slide|notesSlides\/notesSlide)[0-9]+\.xml$/u.test(path)
    || /^ppt\/slides\/_rels\/slide[0-9]+\.xml\.rels$/u.test(path)
}

function presentationSlideImages(files: ReadonlyMap<string, Uint8Array>, slidePath: string): string[] {
  const slideNumber = numericSuffix(slidePath)
  const relationshipsPath = `ppt/slides/_rels/slide${slideNumber}.xml.rels`
  const relationships = files.get(relationshipsPath)
  if (relationships === undefined) return []
  const images = new Set<string>()
  parseXml(relationships, relationshipsPath, {
    open: (tag) => {
      if (localName(tag.name) !== 'Relationship') return
      const type = attribute(tag, 'Type')
      const target = attribute(tag, 'Target')
      const targetMode = attribute(tag, 'TargetMode')
      if (type?.endsWith('/image') !== true || target === undefined || targetMode === 'External') return
      const resolved = relationshipTarget(slidePath, target)
      if (resolved !== undefined && pptxEmbeddedImageMediaType(resolved) !== undefined && files.has(resolved)) {
        images.add(resolved)
      }
    },
  })
  return [...images].sort(naturalCompare)
}

function relationshipTarget(sourcePart: string, target: string): string | undefined {
  if (target.startsWith('/') || target.includes('\\')) return undefined
  const resolved = normalize(join(dirname(sourcePart), target))
  if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) return undefined
  return resolved
}

function xlsxXmlPath(path: string): boolean {
  return path === 'xl/sharedStrings.xml'
    || path === 'xl/workbook.xml'
    || /^xl\/worksheets\/sheet[0-9]+\.xml$/u.test(path)
}

function documentPartLabel(path: string): string {
  if (/\/header[0-9]+\.xml$/u.test(path)) return `Header ${numericSuffix(path)}`
  if (/\/footer[0-9]+\.xml$/u.test(path)) return `Footer ${numericSuffix(path)}`
  if (path.endsWith('/footnotes.xml')) return 'Footnotes'
  if (path.endsWith('/endnotes.xml')) return 'Endnotes'
  if (path.endsWith('/comments.xml')) return 'Comments'
  return path
}

function sortedEntries(files: ReadonlyMap<string, Uint8Array>): Array<[string, Uint8Array]> {
  return [...files.entries()].sort(([left], [right]) => naturalCompare(left, right))
}

function naturalCompare(left: string, right: string): number {
  return left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' })
}

function numericSuffix(path: string): number {
  return Number.parseInt(/([0-9]+)(?:\.xml)?$/u.exec(path)?.[1] ?? '0', 10)
}

function attribute(tag: XmlTag, name: string): string | undefined {
  const value = tag.attributes[name]
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object' && 'value' in value) {
    const nested = (value as { readonly value?: unknown }).value
    return typeof nested === 'string' ? nested : undefined
  }
  return undefined
}

function localName(name: string): string {
  return name.includes(':') ? (name.split(':').at(-1) ?? name) : name
}

function objectValue(value: unknown, required = true): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (required) throw unreadable('structured document contains an invalid object')
  return undefined
}

function textValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function joinText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.filter(item => typeof item === 'string').join('')
  return ''
}

function titleCase(value: string): string {
  return value.length === 0 ? value : `${value[0]?.toUpperCase()}${value.slice(1)}`
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function unreadable(message: string, cause?: unknown): GeoResearchError {
  return new GeoResearchError('ATTACHMENT_MEDIA_UNREADABLE', message, cause === undefined ? undefined : { cause })
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error('attachment read aborted')
}

class TextSink {
  readonly maxBytes: number
  private readonly chunks: string[] = []
  private bytes = 0
  truncated = false

  constructor(maxBytes = STRUCTURED_READ_LIMITS.maxExtractedTextBytes) {
    this.maxBytes = maxBytes
  }

  append(value: string): void {
    if (this.truncated || value.length === 0) return
    const encoded = Buffer.from(value)
    const remaining = this.maxBytes - this.bytes
    if (encoded.byteLength <= remaining) {
      this.chunks.push(value)
      this.bytes += encoded.byteLength
      return
    }
    if (remaining > 0) {
      const prefix = validUtf8Prefix(encoded, remaining)
      this.chunks.push(prefix)
      this.bytes += Buffer.byteLength(prefix)
    }
    this.truncated = true
  }

  line(value = ''): void {
    this.append(value)
    this.append('\n')
  }

  finish(): string {
    return this.chunks.join('')
      .replaceAll('\r\n', '\n')
      .replaceAll('\r', '\n')
      .replace(/[ \t]+\n/gu, '\n')
      .replace(/\n{4,}/gu, '\n\n\n')
      .trim()
  }
}

function validUtf8Prefix(bytes: Uint8Array, maxBytes: number): string {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  for (let end = Math.min(bytes.byteLength, maxBytes); end >= Math.max(0, maxBytes - 4); end -= 1) {
    try {
      return decoder.decode(bytes.subarray(0, end))
    } catch {
      // Try the previous code point boundary.
    }
  }
  return ''
}

const BLOCK_ELEMENTS = new Set([
  'address', 'article', 'aside', 'blockquote', 'div', 'dl', 'dt', 'dd', 'figcaption', 'figure',
  'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'li', 'main', 'nav', 'ol', 'p',
  'pre', 'section', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
])
