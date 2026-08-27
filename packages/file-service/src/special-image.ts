import { readFile, stat } from 'node:fs/promises'
import { createCanvas, ImageData, type Canvas } from '@napi-rs/canvas'
import { decode as decodeBmp } from 'bmp-js'
import * as UTIF from 'utif2'
import { GeoResearchError } from '@georesearch/dsh-contracts'

export const SPECIAL_IMAGE_LIMITS = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024,
  maxDecodedPixels: 16_000_000,
  maxPages: 256,
  maxOutputBytes: 5 * 1024 * 1024,
} as const)

export interface SpecialImageReadOptions {
  readonly page?: number
  readonly maxPixels?: number
  readonly maxOutputBytes?: number
}

export interface SpecialImageRead {
  readonly data: Uint8Array
  readonly mediaType: 'image/png'
  readonly width: number
  readonly height: number
  readonly page: number
  readonly pageCount: number
  readonly warnings: readonly string[]
}

interface DecodedImage {
  readonly rgba: Uint8ClampedArray
  readonly width: number
  readonly height: number
  readonly page: number
  readonly pageCount: number
}

export async function readSpecialImage(
  path: string,
  mediaType: string,
  options: SpecialImageReadOptions = {},
  signal?: AbortSignal,
): Promise<SpecialImageRead> {
  abortIfNeeded(signal)
  const size = (await stat(path)).size
  if (size > SPECIAL_IMAGE_LIMITS.maxInputBytes) {
    throw new GeoResearchError('ATTACHMENT_TOO_LARGE', `image input exceeds ${SPECIAL_IMAGE_LIMITS.maxInputBytes} bytes`)
  }
  const source = await readFile(path, { signal })
  return readSpecialImageBytes(source, mediaType, options, signal)
}

export function readSpecialImageBytes(
  input: Uint8Array,
  mediaType: string,
  options: SpecialImageReadOptions = {},
  signal?: AbortSignal,
): SpecialImageRead {
  abortIfNeeded(signal)
  if (input.byteLength > SPECIAL_IMAGE_LIMITS.maxInputBytes) {
    throw new GeoResearchError('ATTACHMENT_TOO_LARGE', `image input exceeds ${SPECIAL_IMAGE_LIMITS.maxInputBytes} bytes`)
  }
  const source = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  const page = positiveInteger(options.page ?? 1, 'page')
  let decoded: DecodedImage
  try {
    if (mediaType === 'image/tiff') decoded = decodeTiff(source, page)
    else if (mediaType === 'image/bmp') decoded = decodeBitmap(source, page)
    else throw new TypeError(`${mediaType} is not a transcoded image type`)
  } catch (error) {
    if (error instanceof GeoResearchError || error instanceof TypeError) throw error
    throw unreadable(`${mediaType} could not be decoded safely`, error)
  }
  abortIfNeeded(signal)
  const maxPixels = positiveInteger(options.maxPixels ?? SPECIAL_IMAGE_LIMITS.maxDecodedPixels, 'maxPixels')
  const maxOutputBytes = positiveInteger(options.maxOutputBytes ?? SPECIAL_IMAGE_LIMITS.maxOutputBytes, 'maxOutputBytes')
  const encoded = encodeBoundedPng(decoded, Math.min(maxPixels, SPECIAL_IMAGE_LIMITS.maxDecodedPixels), maxOutputBytes)
  return {
    data: encoded.data,
    mediaType: 'image/png',
    width: encoded.width,
    height: encoded.height,
    page: decoded.page,
    pageCount: decoded.pageCount,
    warnings: encoded.warnings,
  }
}

function decodeTiff(source: Buffer, page: number): DecodedImage {
  const directories = UTIF.decode(source)
  if (directories.length === 0) throw unreadable('TIFF contains no image directories')
  if (directories.length > SPECIAL_IMAGE_LIMITS.maxPages) {
    throw new GeoResearchError('ATTACHMENT_TOO_LARGE', `TIFF exceeds ${SPECIAL_IMAGE_LIMITS.maxPages} pages`)
  }
  if (page > directories.length) throw new TypeError(`page ${page} is outside the TIFF image`)
  const directory = directories[page - 1]
  if (directory === undefined) throw unreadable(`TIFF page ${page} is missing`)
  const width = tiffDimension(directory.t256, 'width')
  const height = tiffDimension(directory.t257, 'height')
  assertDimensions(width, height)
  UTIF.decodeImage(source, directory)
  if (directory.width !== width || directory.height !== height) throw unreadable('TIFF dimensions changed during decode')
  const rgba = UTIF.toRGBA8(directory)
  if (rgba.byteLength !== width * height * 4) throw unreadable('TIFF decoder returned an invalid pixel buffer')
  return {
    rgba: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength),
    width,
    height,
    page,
    pageCount: directories.length,
  }
}

function decodeBitmap(source: Buffer, page: number): DecodedImage {
  if (page !== 1) throw new TypeError('BMP files contain only page 1')
  const header = inspectBitmap(source)
  const decoded = decodeBmp(source)
  if (decoded.width !== header.width || decoded.height !== header.height) throw unreadable('BMP dimensions changed during decode')
  if (decoded.data.byteLength !== header.width * header.height * 4) throw unreadable('BMP decoder returned an invalid pixel buffer')
  let allAlphaZero = true
  if (header.bitsPerPixel === 32) {
    for (let index = 0; index < decoded.data.byteLength; index += 4) {
      if (decoded.data[index] !== 0) {
        allAlphaZero = false
        break
      }
    }
  }
  const rgba = new Uint8ClampedArray(decoded.data.byteLength)
  const opaque = header.bitsPerPixel !== 32 || allAlphaZero
  for (let index = 0; index < decoded.data.byteLength; index += 4) {
    rgba[index] = decoded.data[index + 3] as number
    rgba[index + 1] = decoded.data[index + 2] as number
    rgba[index + 2] = decoded.data[index + 1] as number
    rgba[index + 3] = opaque ? 255 : (decoded.data[index] as number)
  }
  return { rgba, width: header.width, height: header.height, page: 1, pageCount: 1 }
}

function inspectBitmap(source: Buffer): { readonly width: number; readonly height: number; readonly bitsPerPixel: number } {
  if (source.byteLength < 54 || source.toString('latin1', 0, 2) !== 'BM') throw unreadable('BMP header is incomplete')
  const declaredSize = source.readUInt32LE(2)
  const pixelOffset = source.readUInt32LE(10)
  const dibSize = source.readUInt32LE(14)
  if (dibSize !== 40) throw unreadable('only the 40-byte BMP BITMAPINFOHEADER is supported')
  const width = source.readInt32LE(18)
  const rawHeight = source.readInt32LE(22)
  if (rawHeight === -2_147_483_648) throw unreadable('BMP height is invalid')
  const height = Math.abs(rawHeight)
  const planes = source.readUInt16LE(26)
  const bitsPerPixel = source.readUInt16LE(28)
  const compression = source.readUInt32LE(30)
  const declaredPixelBytes = source.readUInt32LE(34)
  const declaredColors = source.readUInt32LE(46)
  if (declaredSize !== 0 && declaredSize > source.byteLength) throw unreadable('BMP declared size exceeds the input')
  if (planes !== 1) throw unreadable('BMP plane count is invalid')
  if (![1, 4, 8, 16, 24, 32].includes(bitsPerPixel)) throw unreadable(`BMP ${bitsPerPixel}-bit pixels are unsupported`)
  if (compression !== 0) throw unreadable(`compressed BMP pixels are unsupported (compression ${compression})`)
  assertDimensions(width, height)

  const maximumColors = bitsPerPixel < 16 ? 2 ** bitsPerPixel : 0
  if (declaredColors > maximumColors) throw unreadable('BMP palette size is invalid')
  const paletteColors = bitsPerPixel < 16 && declaredColors === 0 ? maximumColors : declaredColors
  const expectedPixelOffset = 14 + dibSize + paletteColors * 4
  if (pixelOffset !== expectedPixelOffset) {
    throw unreadable(`BMP pixel offset ${pixelOffset} does not match the decoded header size ${expectedPixelOffset}`)
  }

  const rowBytes = ((BigInt(width) * BigInt(bitsPerPixel) + 31n) / 32n) * 4n
  const requiredPixelBytes = rowBytes * BigInt(height)
  const requiredEnd = BigInt(pixelOffset) + requiredPixelBytes
  if (requiredEnd > BigInt(source.byteLength)) throw unreadable('BMP pixel rows are truncated')
  if (declaredPixelBytes !== 0 && BigInt(declaredPixelBytes) < requiredPixelBytes) {
    throw unreadable('BMP declared pixel size is smaller than its rows')
  }
  if (declaredSize !== 0 && BigInt(declaredSize) < requiredEnd) {
    throw unreadable('BMP declared file size is smaller than its pixel rows')
  }
  return { width, height, bitsPerPixel }
}

function encodeBoundedPng(
  decoded: DecodedImage,
  maxPixels: number,
  maxOutputBytes: number,
): { readonly data: Uint8Array; readonly width: number; readonly height: number; readonly warnings: readonly string[] } {
  const warnings: string[] = []
  const source = createCanvas(decoded.width, decoded.height)
  source.getContext('2d').putImageData(new ImageData(decoded.rgba, decoded.width, decoded.height), 0, 0)
  let width = decoded.width
  let height = decoded.height
  let canvas: Canvas = source
  if (decoded.width * decoded.height > maxPixels) {
    const scale = Math.sqrt(maxPixels / (decoded.width * decoded.height))
    width = Math.max(1, Math.floor(decoded.width * scale))
    height = Math.max(1, Math.floor(decoded.height * scale))
    canvas = resizedCanvas(source, width, height)
    warnings.push(`Image was resized from ${decoded.width}x${decoded.height} to ${width}x${height} for the Harness pixel limit.`)
  }
  let png = canvas.toBuffer('image/png')
  for (let attempt = 0; png.byteLength > maxOutputBytes && attempt < 4 && (width > 1 || height > 1); attempt += 1) {
    const scale = Math.min(0.9, Math.sqrt(maxOutputBytes / png.byteLength) * 0.9)
    const nextWidth = Math.max(1, Math.floor(width * scale))
    const nextHeight = Math.max(1, Math.floor(height * scale))
    if (nextWidth === width && nextHeight === height) break
    canvas = resizedCanvas(canvas, nextWidth, nextHeight)
    width = nextWidth
    height = nextHeight
    png = canvas.toBuffer('image/png')
  }
  if (png.byteLength > maxOutputBytes) {
    throw new GeoResearchError('ATTACHMENT_TOO_LARGE', `transcoded PNG exceeds ${maxOutputBytes} bytes`)
  }
  if (width !== decoded.width || height !== decoded.height) {
    if (warnings.length === 0) warnings.push(`Image was resized to ${width}x${height} for the Harness byte limit.`)
    else if (!warnings[0]?.includes(`${width}x${height}`)) warnings.push(`Image was further resized to ${width}x${height} for the Harness byte limit.`)
  }
  return { data: png, width, height, warnings }
}

function resizedCanvas(source: Canvas, width: number, height: number): Canvas {
  const target = createCanvas(width, height)
  target.getContext('2d').drawImage(source, 0, 0, width, height)
  return target
}

function tiffDimension(value: UTIF.TiffTag | number | Uint8Array | undefined, label: string): number {
  const first = Array.isArray(value) ? value[0] : value instanceof Uint8Array ? value[0] : value
  const parsed = typeof first === 'string' ? Number(first) : first
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed)) throw unreadable(`TIFF ${label} is missing or invalid`)
  return parsed
}

function assertDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
    throw unreadable('image dimensions must be positive safe integers')
  }
  if (width * height > SPECIAL_IMAGE_LIMITS.maxDecodedPixels) {
    throw new GeoResearchError('ATTACHMENT_TOO_LARGE', `decoded image exceeds ${SPECIAL_IMAGE_LIMITS.maxDecodedPixels} pixels`)
  }
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer`)
  return value
}

function unreadable(message: string, cause?: unknown): GeoResearchError {
  return new GeoResearchError('ATTACHMENT_MEDIA_UNREADABLE', message, cause === undefined ? undefined : { cause })
}

function abortIfNeeded(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw signal.reason instanceof Error ? signal.reason : new Error('attachment read aborted')
}
