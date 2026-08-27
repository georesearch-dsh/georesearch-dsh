import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { decompressConcatenatedZstd } from './analyze-prompt-cache.ts'

type JsonRecord = Record<string, unknown>

interface Difference {
  readonly path: string
  readonly kind: 'type' | 'value' | 'length' | 'key-order'
  readonly leftType?: string
  readonly rightType?: string
  readonly leftLength?: number
  readonly rightLength?: number
  readonly commonPrefixChars?: number
  readonly leftKey?: string
  readonly rightKey?: string
}

function record(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function valueType(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function commonPrefix(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index += 1
  return index
}

function firstDifference(left: unknown, right: unknown, path = '$'): Difference | undefined {
  const leftType = valueType(left)
  const rightType = valueType(right)
  if (leftType !== rightType) return { path, kind: 'type', leftType, rightType }

  if (typeof left === 'string' && typeof right === 'string') {
    if (left === right) return undefined
    return {
      path,
      kind: 'value',
      leftLength: left.length,
      rightLength: right.length,
      commonPrefixChars: commonPrefix(left, right),
    }
  }
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return Object.is(left, right) ? undefined : { path, kind: 'value' }
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    const limit = Math.min(left.length, right.length)
    for (let index = 0; index < limit; index += 1) {
      const difference = firstDifference(left[index], right[index], `${path}[${index}]`)
      if (difference !== undefined) return difference
    }
    return left.length === right.length
      ? undefined
      : { path, kind: 'length', leftLength: left.length, rightLength: right.length }
  }

  const leftRecord = left as JsonRecord
  const rightRecord = right as JsonRecord
  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)
  const keyLimit = Math.min(leftKeys.length, rightKeys.length)
  for (let index = 0; index < keyLimit; index += 1) {
    if (leftKeys[index] !== rightKeys[index]) {
      return {
        path,
        kind: 'key-order',
        leftKey: leftKeys[index],
        rightKey: rightKeys[index],
      }
    }
    const key = leftKeys[index]!
    const difference = firstDifference(leftRecord[key], rightRecord[key], `${path}.${key}`)
    if (difference !== undefined) return difference
  }
  return leftKeys.length === rightKeys.length
    ? undefined
    : { path, kind: 'length', leftLength: leftKeys.length, rightLength: rightKeys.length }
}

async function firstRequestHeader(file: string): Promise<JsonRecord> {
  const bytes = await readFile(file)
  const text = file.endsWith('.zstd')
    ? (await decompressConcatenatedZstd(bytes)).toString('utf8')
    : bytes.toString('utf8')
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0) continue
    const row = record(JSON.parse(line))
    if (row?.type !== 'request/header') continue
    const data = record(row.data)
    const header = record(data?.header)
    if (header !== undefined) return header
  }
  throw new Error(`${file}: no request/header event found`)
}

function headerSummary(header: JsonRecord): JsonRecord {
  const json = JSON.stringify(header)
  return {
    hash: hashJson(header),
    jsonChars: json.length,
    keys: Object.keys(header),
    components: Object.fromEntries(Object.entries(header).map(([key, value]) => [key, {
      hash: hashJson(value),
      jsonChars: JSON.stringify(value).length,
      type: valueType(value),
    }])),
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2).filter(argument => argument !== '--')
  if (args.length !== 2) {
    throw new Error('usage: pnpm cache:compare -- <left-session-file> <right-session-file>')
  }
  const leftFile = resolve(args[0]!)
  const rightFile = resolve(args[1]!)
  const [left, right] = await Promise.all([
    firstRequestHeader(leftFile),
    firstRequestHeader(rightFile),
  ])
  const leftJson = JSON.stringify(left)
  const rightJson = JSON.stringify(right)
  console.log(JSON.stringify({
    leftFile,
    rightFile,
    identical: leftJson === rightJson,
    commonPrefixChars: commonPrefix(leftJson, rightJson),
    firstDifference: firstDifference(left, right) ?? null,
    left: headerSummary(left),
    right: headerSummary(right),
  }, null, 2))
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
