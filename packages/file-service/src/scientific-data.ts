import { readFile, stat } from 'node:fs/promises'
import { GeoResearchError } from '@georesearch/dsh-contracts'
import { NetCDFReader } from 'netcdfjs'
import {
  asyncBufferFromFile,
  parquetMetadataAsync,
  parquetReadObjects,
  parquetSchema,
  type FileMetaData,
  type SchemaTree,
} from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import type {
  Attribute as HdfAttribute,
  Dataset as HdfDataset,
  Datatype as HdfDatatype,
  Group as HdfGroup,
} from 'h5wasm/node'
import type { StructuredAttachmentRead } from './document.js'

export const SCIENTIFIC_READ_LIMITS = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024,
  maxExtractedTextBytes: 8 * 1024 * 1024,
  maxHdfEntities: 1_000,
  maxHdfDepth: 16,
  maxHdfAttributes: 1_000,
  maxHdfAttributesPerEntity: 100,
  maxHdfSampleValues: 50,
  maxHdfChunkBytes: 16 * 1024 * 1024,
  maxNetcdfDimensions: 256,
  maxNetcdfVariables: 500,
  maxNetcdfAttributes: 1_000,
  maxNetcdfSampleElements: 1_000,
  maxNetcdfSampleValues: 50,
  maxParquetSchemaElements: 1_000,
  maxParquetColumns: 64,
  maxParquetRows: 50,
  maxParquetColumnChunkBytes: 16 * 1024 * 1024,
  maxParquetSampleBytes: 32 * 1024 * 1024,
  maxRenderedValueCharacters: 32 * 1024,
} as const)

interface HdfState {
  entities: number
  attributes: number
  readonly warnings: string[]
}

interface NetcdfAttribute {
  readonly name: string
  readonly type: string
  readonly value: unknown
}

export async function readScientificAttachment(
  path: string,
  mediaType: string,
  signal?: AbortSignal,
): Promise<StructuredAttachmentRead> {
  abortIfNeeded(signal)
  const size = (await stat(path)).size
  if (size > SCIENTIFIC_READ_LIMITS.maxInputBytes) {
    throw new GeoResearchError('ATTACHMENT_TOO_LARGE', `scientific input exceeds ${SCIENTIFIC_READ_LIMITS.maxInputBytes} bytes`)
  }
  switch (mediaType) {
    case 'application/x-hdf5': return readHdf5(path, signal)
    case 'application/x-netcdf': return readNetcdf(path, signal)
    case 'application/vnd.apache.parquet': return readParquet(path, signal)
    default: throw unreadable(`${mediaType} has no approved scientific-data reader`)
  }
}

async function readHdf5(path: string, signal?: AbortSignal): Promise<StructuredAttachmentRead> {
  abortIfNeeded(signal)
  const h5 = await import('h5wasm/node')
  await h5.ready
  abortIfNeeded(signal)
  const sink = new TextSink()
  const state: HdfState = { entities: 0, attributes: 0, warnings: [] }
  const file = new h5.File(path, 'r')
  try {
    sink.line('# HDF5 file')
    await visitHdfGroup(file, 0, h5, sink, state, signal)
  } catch (error) {
    throw unreadable('HDF5 content could not be read safely', error)
  } finally {
    file.close()
  }
  return result('hdf5', sink, state.warnings)
}

async function visitHdfGroup(
  group: HdfGroup,
  depth: number,
  h5: typeof import('h5wasm/node'),
  sink: TextSink,
  state: HdfState,
  signal?: AbortSignal,
): Promise<void> {
  abortIfNeeded(signal)
  state.entities += 1
  if (state.entities > SCIENTIFIC_READ_LIMITS.maxHdfEntities) {
    state.warnings.push(`HDF5 traversal stopped at ${SCIENTIFIC_READ_LIMITS.maxHdfEntities} entities.`)
    return
  }
  sink.line()
  sink.line(`${'#'.repeat(Math.min(6, depth + 2))} Group: ${group.path}`)
  appendHdfAttributes(group, sink, state)
  if (depth >= SCIENTIFIC_READ_LIMITS.maxHdfDepth) {
    state.warnings.push(`HDF5 traversal stopped at depth ${SCIENTIFIC_READ_LIMITS.maxHdfDepth}.`)
    return
  }
  const names = group.keys()
  for (const name of names) {
    abortIfNeeded(signal)
    if (state.entities >= SCIENTIFIC_READ_LIMITS.maxHdfEntities) {
      if (!state.warnings.some(warning => warning.includes('entities'))) {
        state.warnings.push(`HDF5 traversal stopped at ${SCIENTIFIC_READ_LIMITS.maxHdfEntities} entities.`)
      }
      return
    }
    const entity = group.get(name)
    if (entity === null) {
      sink.line(`- ${name}: unreadable object`)
      continue
    }
    if (entity instanceof h5.ExternalLink) {
      state.entities += 1
      sink.line(`- External link ${name}: ${entity.filename}:${entity.obj_path} [not followed]`)
      continue
    }
    if (entity instanceof h5.BrokenSoftLink) {
      state.entities += 1
      sink.line(`- Symbolic link ${name}: ${entity.target} [not followed]`)
      continue
    }
    if (entity instanceof h5.Group) {
      await visitHdfGroup(entity, depth + 1, h5, sink, state, signal)
      continue
    }
    if (entity instanceof h5.Dataset) {
      state.entities += 1
      appendHdfDataset(entity, depth + 1, sink, state)
      continue
    }
    if (entity instanceof h5.Datatype) {
      state.entities += 1
      appendHdfDatatype(entity, depth + 1, sink, state)
      continue
    }
    state.entities += 1
    sink.line(`- ${name}: reference or unsupported HDF5 entity [not dereferenced]`)
  }
}

function appendHdfDataset(dataset: HdfDataset, depth: number, sink: TextSink, state: HdfState): void {
  const metadata = dataset.metadata
  const shape = dataset.shape
  sink.line()
  sink.line(`${'#'.repeat(Math.min(6, depth + 2))} Dataset: ${dataset.path}`)
  sink.line(`Shape: ${shape === null ? 'scalar' : safeJsonText(shape)}`)
  sink.line(`Dtype: ${safeJsonText(dataset.dtype)}`)
  if (metadata.chunks !== null) sink.line(`Chunks: ${safeJsonText(metadata.chunks)}`)
  if (dataset.filters.length > 0) sink.line(`Filters: ${safeJsonText(dataset.filters)}`)
  appendHdfAttributes(dataset, sink, state)

  if ((metadata.virtual_sources?.length ?? 0) > 0) {
    sink.line(`Sample: [virtual dataset omitted; ${metadata.virtual_sources?.length ?? 0} external source(s) not followed]`)
    return
  }
  if (metadata.ref_type !== undefined) {
    sink.line(`Sample: [${metadata.ref_type} references not dereferenced]`)
    return
  }
  const elements = dimensionProduct(shape ?? [])
  if (elements === undefined) {
    sink.line('Sample: [invalid or unsafe dimensions]')
    return
  }
  if (elements === 0n) {
    sink.line('Sample: []')
    return
  }
  if (metadata.chunks !== null) {
    const chunkElements = dimensionProduct(metadata.chunks)
    if (chunkElements === undefined
      || chunkElements * BigInt(Math.max(1, metadata.size)) > BigInt(SCIENTIFIC_READ_LIMITS.maxHdfChunkBytes)) {
      sink.line(`Sample: [omitted because one decoded chunk can exceed ${SCIENTIFIC_READ_LIMITS.maxHdfChunkBytes} bytes]`)
      return
    }
  }
  try {
    const value = shape === null || shape.length === 0
      ? dataset.json_value
      : dataset.slice(sampleRanges(shape, SCIENTIFIC_READ_LIMITS.maxHdfSampleValues))
    sink.line(`Sample: ${safeJsonText(value)}`)
    if (elements > BigInt(SCIENTIFIC_READ_LIMITS.maxHdfSampleValues)) {
      sink.line(`[Sample bounded to ${SCIENTIFIC_READ_LIMITS.maxHdfSampleValues} values]`)
    }
  } catch (error) {
    sink.line(`Sample: [unavailable: ${shortError(error)}]`)
  }
}

function appendHdfDatatype(datatype: HdfDatatype, depth: number, sink: TextSink, state: HdfState): void {
  sink.line()
  sink.line(`${'#'.repeat(Math.min(6, depth + 2))} Datatype: ${datatype.path}`)
  sink.line(`Metadata: ${safeJsonText(datatype.metadata)}`)
  appendHdfAttributes(datatype, sink, state)
}

function appendHdfAttributes(
  owner: HdfGroup | HdfDataset | HdfDatatype,
  sink: TextSink,
  state: HdfState,
): void {
  const attributes = Object.entries(owner.attrs)
  const remaining = Math.max(0, SCIENTIFIC_READ_LIMITS.maxHdfAttributes - state.attributes)
  const selected = attributes.slice(0, Math.min(remaining, SCIENTIFIC_READ_LIMITS.maxHdfAttributesPerEntity))
  for (const [name, attribute] of selected) {
    state.attributes += 1
    sink.line(`Attribute ${name}: ${hdfAttributeValue(attribute)}`)
  }
  if (selected.length < attributes.length) {
    state.warnings.push(`Attributes on ${owner.path} were bounded at ${selected.length} of ${attributes.length}.`)
  }
}

function hdfAttributeValue(attribute: HdfAttribute): string {
  try {
    return safeJsonText(attribute.json_value)
  } catch (error) {
    return `[unavailable: ${shortError(error)}]`
  }
}

async function readNetcdf(path: string, signal?: AbortSignal): Promise<StructuredAttachmentRead> {
  const source = await readFile(path, { signal })
  abortIfNeeded(signal)
  if (source[3] !== 1 && source[3] !== 2) throw unreadable('only NetCDF classic and 64-bit-offset files are supported')
  let reader: NetCDFReader
  try {
    reader = new NetCDFReader(source)
  } catch (error) {
    throw unreadable('NetCDF header could not be parsed safely', error)
  }
  const sink = new TextSink()
  const warnings: string[] = []
  sink.line('# NetCDF file')
  sink.line(`Format: ${reader.version}`)
  sink.line(`Record dimension: ${safeJsonText(reader.recordDimension)}`)
  sink.line()
  sink.line('## Dimensions')
  for (const dimension of reader.dimensions.slice(0, SCIENTIFIC_READ_LIMITS.maxNetcdfDimensions)) {
    sink.line(`- ${dimension.name}: ${effectiveNetcdfDimensionSize(reader, dimension.name, dimension.size)}`)
  }
  if (reader.dimensions.length > SCIENTIFIC_READ_LIMITS.maxNetcdfDimensions) {
    warnings.push(`NetCDF dimensions were bounded at ${SCIENTIFIC_READ_LIMITS.maxNetcdfDimensions}.`)
  }

  let attributeCount = 0
  sink.line()
  sink.line('## Global attributes')
  for (const attribute of (reader.globalAttributes as NetcdfAttribute[])) {
    if (attributeCount >= SCIENTIFIC_READ_LIMITS.maxNetcdfAttributes) break
    attributeCount += 1
    sink.line(`- ${attribute.name} (${attribute.type}): ${safeJsonText(attribute.value)}`)
  }
  if (reader.globalAttributes.length > attributeCount) {
    warnings.push(`NetCDF attributes were bounded at ${SCIENTIFIC_READ_LIMITS.maxNetcdfAttributes}.`)
  }

  sink.line()
  sink.line('## Variables')
  const variables = reader.variables.slice(0, SCIENTIFIC_READ_LIMITS.maxNetcdfVariables)
  for (const variable of variables) {
    abortIfNeeded(signal)
    const dimensions = variable.dimensions.map((id) => {
      const dimension = reader.dimensions[id]
      if (dimension === undefined) return { name: `dimension-${id}`, size: 'unknown' }
      return {
        name: dimension.name,
        size: effectiveNetcdfDimensionSize(reader, dimension.name, dimension.size),
      }
    })
    sink.line()
    sink.line(`### ${variable.name}`)
    sink.line(`Type: ${variable.type}`)
    sink.line(`Dimensions: ${dimensions.length === 0 ? 'scalar' : dimensions.map(value => `${value.name}=${value.size}`).join(', ')}`)
    for (const attribute of (variable.attributes as NetcdfAttribute[])) {
      if (attributeCount >= SCIENTIFIC_READ_LIMITS.maxNetcdfAttributes) break
      attributeCount += 1
      sink.line(`Attribute ${attribute.name} (${attribute.type}): ${safeJsonText(attribute.value)}`)
    }
    const elements = dimensionProduct(dimensions.map(value => typeof value.size === 'number' ? value.size : -1))
    if (elements === undefined || elements > BigInt(SCIENTIFIC_READ_LIMITS.maxNetcdfSampleElements)) {
      sink.line(`Sample: [omitted because the variable exceeds ${SCIENTIFIC_READ_LIMITS.maxNetcdfSampleElements} elements]`)
      continue
    }
    try {
      const values = reader.getDataVariable(variable)
      sink.line(`Sample: ${safeJsonText(values.slice(0, SCIENTIFIC_READ_LIMITS.maxNetcdfSampleValues))}`)
      if (values.length > SCIENTIFIC_READ_LIMITS.maxNetcdfSampleValues) {
        sink.line(`[Sample bounded to ${SCIENTIFIC_READ_LIMITS.maxNetcdfSampleValues} values]`)
      }
    } catch (error) {
      sink.line(`Sample: [unavailable: ${shortError(error)}]`)
    }
  }
  if (reader.variables.length > variables.length) {
    warnings.push(`NetCDF variables were bounded at ${SCIENTIFIC_READ_LIMITS.maxNetcdfVariables}.`)
  }
  if (attributeCount >= SCIENTIFIC_READ_LIMITS.maxNetcdfAttributes) {
    warnings.push(`NetCDF attributes were bounded at ${SCIENTIFIC_READ_LIMITS.maxNetcdfAttributes}.`)
  }
  return result('netcdf', sink, warnings)
}

async function readParquet(path: string, signal?: AbortSignal): Promise<StructuredAttachmentRead> {
  abortIfNeeded(signal)
  const file = await asyncBufferFromFile(path)
  const metadata = await parquetMetadataAsync(file, { geoparquet: false })
  abortIfNeeded(signal)
  const tree = parquetSchema(metadata)
  const sink = new TextSink()
  const warnings: string[] = []
  sink.line('# Apache Parquet file')
  sink.line(`Rows: ${metadata.num_rows.toString()}`)
  sink.line(`Row groups: ${metadata.row_groups.length}`)
  sink.line(`Created by: ${metadata.created_by ?? 'unknown'}`)
  if ((metadata.key_value_metadata?.length ?? 0) > 0) {
    sink.line('Key/value metadata:')
    for (const entry of metadata.key_value_metadata!.slice(0, 100)) {
      sink.line(`- ${entry.key}: ${safeJsonText(entry.value ?? '')}`)
    }
    if (metadata.key_value_metadata!.length > 100) warnings.push('Parquet key/value metadata was bounded at 100 entries.')
  }
  sink.line()
  sink.line('## Schema')
  const schemaCount = appendParquetSchema(tree, sink)
  if (metadata.schema.length > schemaCount) {
    warnings.push(`Parquet schema output was bounded at ${SCIENTIFIC_READ_LIMITS.maxParquetSchemaElements} elements.`)
  }

  const columns = tree.children.slice(0, SCIENTIFIC_READ_LIMITS.maxParquetColumns).map(child => child.element.name)
  if (tree.children.length > columns.length) {
    warnings.push(`Parquet sample columns were bounded at ${SCIENTIFIC_READ_LIMITS.maxParquetColumns} of ${tree.children.length}.`)
  }
  const rowEnd = Number(metadata.num_rows > BigInt(SCIENTIFIC_READ_LIMITS.maxParquetRows)
    ? BigInt(SCIENTIFIC_READ_LIMITS.maxParquetRows)
    : metadata.num_rows)
  sink.line()
  sink.line('## Row sample')
  if (rowEnd === 0 || columns.length === 0) {
    sink.line('No rows available.')
  } else {
    const unsafe = parquetSampleFailure(metadata, new Set(columns), rowEnd)
    if (unsafe !== undefined) {
      sink.line(`[Sample omitted: ${unsafe}]`)
      warnings.push(unsafe)
    } else {
      const rows = await parquetReadObjects({
        file,
        metadata,
        columns,
        rowStart: 0,
        rowEnd,
        compressors,
        utf8: false,
        geoparquet: false,
      })
      abortIfNeeded(signal)
      for (const row of rows) sink.line(safeJsonText(row))
      if (metadata.num_rows > BigInt(rows.length)) warnings.push(`Parquet rows were sampled at ${rows.length} of ${metadata.num_rows.toString()}.`)
    }
  }
  return result('parquet', sink, warnings)
}

function appendParquetSchema(root: SchemaTree, sink: TextSink): number {
  let count = 0
  const visit = (node: SchemaTree, depth: number): void => {
    if (count >= SCIENTIFIC_READ_LIMITS.maxParquetSchemaElements) return
    count += 1
    const element = node.element
    const type = element.type ?? element.converted_type ?? element.logical_type?.type ?? 'group'
    const repetition = element.repetition_type === undefined ? '' : ` ${element.repetition_type.toLowerCase()}`
    sink.line(`${'  '.repeat(depth)}- ${element.name}: ${type}${repetition}`)
    for (const child of node.children) visit(child, depth + 1)
  }
  visit(root, 0)
  return count
}

function parquetSampleFailure(metadata: FileMetaData, columns: ReadonlySet<string>, rowCount: number): string | undefined {
  let remaining = BigInt(rowCount)
  let decodedBytes = 0n
  for (const group of metadata.row_groups) {
    if (remaining <= 0n) break
    for (const column of group.columns) {
      const detail = column.meta_data
      if (detail === undefined || !columns.has(detail.path_in_schema[0] ?? '')) continue
      if (column.file_path !== undefined && column.file_path !== '') return 'external Parquet column files are not followed'
      if (column.encrypted_column_metadata !== undefined || column.crypto_metadata !== undefined) return 'encrypted Parquet columns are not decoded'
      if (detail.codec === 'LZO') return 'LZO-compressed Parquet columns have no approved decoder'
      if (detail.total_uncompressed_size > BigInt(SCIENTIFIC_READ_LIMITS.maxParquetColumnChunkBytes)) {
        return `a selected Parquet column chunk exceeds ${SCIENTIFIC_READ_LIMITS.maxParquetColumnChunkBytes} decoded bytes`
      }
      decodedBytes += detail.total_uncompressed_size
      if (decodedBytes > BigInt(SCIENTIFIC_READ_LIMITS.maxParquetSampleBytes)) {
        return `the Parquet sample exceeds ${SCIENTIFIC_READ_LIMITS.maxParquetSampleBytes} decoded bytes`
      }
    }
    remaining -= group.num_rows
  }
  return undefined
}

function effectiveNetcdfDimensionSize(reader: NetCDFReader, name: string, size: number): number {
  return size === 0 && reader.recordDimension.name === name ? reader.recordDimension.length : size
}

function sampleRanges(shape: readonly number[], maxValues: number): Array<[number, number]> {
  let remaining = maxValues
  return shape.map((dimension) => {
    const selected = Math.min(dimension, Math.max(1, remaining))
    remaining = Math.max(1, Math.floor(remaining / Math.max(1, selected)))
    return [0, selected]
  })
}

function dimensionProduct(dimensions: readonly number[]): bigint | undefined {
  let product = 1n
  for (const dimension of dimensions) {
    if (!Number.isSafeInteger(dimension) || dimension < 0) return undefined
    product *= BigInt(dimension)
  }
  return product
}

function result(format: string, sink: TextSink, warnings: readonly string[]): StructuredAttachmentRead {
  const text = sink.finish()
  return {
    format,
    text,
    extractedTextBytes: Buffer.byteLength(text),
    extractionTruncated: sink.truncated,
    warnings: [...warnings, ...(sink.truncated ? [`Extracted text was bounded at ${SCIENTIFIC_READ_LIMITS.maxExtractedTextBytes} bytes.`] : [])],
    images: [],
  }
}

function safeJsonText(value: unknown): string {
  try {
    const rendered = JSON.stringify(jsonSafe(value, 0, new WeakSet<object>())) ?? 'null'
    return rendered.length <= SCIENTIFIC_READ_LIMITS.maxRenderedValueCharacters
      ? rendered
      : `${rendered.slice(0, SCIENTIFIC_READ_LIMITS.maxRenderedValueCharacters)}...[truncated]`
  } catch (error) {
    return `[unserializable: ${shortError(error)}]`
  }
}

function jsonSafe(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return value.length <= 4_096 ? value : `${value.slice(0, 4_096)}...[truncated]`
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'undefined') return null
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array) return `<binary:${value.byteLength} bytes>`
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) return `<binary:${value.byteLength} bytes>`
    return Array.from(value as unknown as ArrayLike<number | bigint>).slice(0, 100).map(child => jsonSafe(child, depth + 1, seen))
  }
  if (value instanceof ArrayBuffer) return `<binary:${value.byteLength} bytes>`
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '<cycle>'
  if (depth >= 6) return '<nested value omitted>'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.slice(0, 100).map(child => jsonSafe(child, depth + 1, seen))
    }
    if (value instanceof Map) {
      return Object.fromEntries([...value.entries()].slice(0, 100).map(([key, child]) => [String(key), jsonSafe(child, depth + 1, seen)]))
    }
    return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, child]) => [key, jsonSafe(child, depth + 1, seen)]))
  } finally {
    seen.delete(value)
  }
}

function shortError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/gu, ' ').slice(0, 256)
}

function unreadable(message: string, cause?: unknown): GeoResearchError {
  return new GeoResearchError('ATTACHMENT_MEDIA_UNREADABLE', message, cause === undefined ? undefined : { cause })
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error('attachment read aborted')
}

class TextSink {
  private readonly chunks: string[] = []
  private bytes = 0
  truncated = false

  append(value: string): void {
    if (this.truncated || value.length === 0) return
    const encoded = Buffer.from(value)
    const remaining = SCIENTIFIC_READ_LIMITS.maxExtractedTextBytes - this.bytes
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
