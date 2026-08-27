import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'

const decompress = promisify(zstdDecompress)
const ZSTD_MAGIC = 0xFD2FB528

interface FrameRange {
  readonly start: number
  readonly end: number
}

interface Totals {
  calls: number
  promptTokens: number
  uncachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
}

interface AnalyzedCall {
  readonly usage: Totals
  readonly reset: boolean
}

export interface SessionCacheSummary extends Totals {
  readonly file: string
  readonly sessionId: string
  readonly preset: string
  readonly model: string | null
  readonly hitPct: number | null
  readonly warmHitPct: number | null
  readonly sameEpochHitPct: number | null
  readonly headerSnapshots: number
  readonly cacheEpochChanges: number
  readonly resetCalls: number
  readonly resetUncachedTokens: number
  readonly resetMissSharePct: number | null
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function nonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function emptyTotals(): Totals {
  return {
    calls: 0,
    promptTokens: 0,
    uncachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  }
}

function addUsage(target: Totals, usage: Record<string, unknown>): void {
  const input = nonNegative(usage.inputTokens)
  const read = nonNegative(usage.cacheReadTokens)
  const write = nonNegative(usage.cacheWriteTokens)
  target.calls += 1
  target.promptTokens += input + read + write
  target.uncachedInputTokens += input
  target.cacheReadTokens += read
  target.cacheWriteTokens += write
  target.outputTokens += nonNegative(usage.outputTokens)
}

function sumCalls(calls: readonly AnalyzedCall[]): Totals {
  const totals = emptyTotals()
  for (const call of calls) {
    totals.calls += call.usage.calls
    totals.promptTokens += call.usage.promptTokens
    totals.uncachedInputTokens += call.usage.uncachedInputTokens
    totals.cacheReadTokens += call.usage.cacheReadTokens
    totals.cacheWriteTokens += call.usage.cacheWriteTokens
    totals.outputTokens += call.usage.outputTokens
  }
  return totals
}

function hitPercent(totals: Totals): number | null {
  return totals.promptTokens === 0
    ? null
    : Math.round(1_000 * totals.cacheReadTokens / totals.promptTokens) / 10
}

function sharePercent(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round(1_000 * part / whole) / 10
}

function fingerprint(header: unknown): string {
  return createHash('sha256').update(JSON.stringify(header)).digest('hex')
}

/** Locate the independently appended frames used by Harness JSONL persistence. */
function scanZstdFrames(buffer: Buffer): FrameRange[] {
  const frames: FrameRange[] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 5 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt or incomplete Zstandard session frame at byte ${offset}`)
    }
    offset += 4
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session frame descriptor at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) {
      throw new Error(`incomplete Zstandard session frame header at byte ${start}`)
    }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) {
        throw new Error(`incomplete Zstandard session block header at byte ${offset}`)
      }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`reserved Zstandard block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) {
        throw new Error(`incomplete Zstandard session block at byte ${offset}`)
      }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) {
        throw new Error(`incomplete Zstandard checksum at byte ${offset}`)
      }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return frames
}

export async function decompressConcatenatedZstd(bytes: Buffer): Promise<Buffer> {
  const chunks: Buffer[] = []
  for (const frame of scanZstdFrames(bytes)) {
    chunks.push(await decompress(bytes.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(chunks)
}

export function analyzeSessionJsonl(text: string, file = '<memory>'): SessionCacheSummary {
  const rows = text.split(/\r?\n/u).filter(Boolean).map((line, index) => {
    try {
      return record(JSON.parse(line))
    } catch (error) {
      throw new Error(`${file}: invalid JSONL at line ${index + 1}`, { cause: error })
    }
  }).filter((row): row is Record<string, unknown> => row !== undefined)

  const session = rows.find(row => row.type === 'session') ?? {}
  const calls: AnalyzedCall[] = []
  let model: string | null = null
  let selectedPreset: string | undefined
  let headerSnapshots = 0
  let cacheEpochChanges = 0
  let previousFingerprint: string | undefined
  let activeHeader: { reset: boolean; used: boolean } | undefined

  for (const row of rows) {
    const data = record(row.data)
    if (row.type === 'agent-preset/selected' && typeof data?.agentPreset === 'string') {
      selectedPreset = data.agentPreset
    }
    if (row.type === 'request/header') {
      const currentFingerprint = fingerprint(data?.header)
      const changed = previousFingerprint !== undefined && currentFingerprint !== previousFingerprint
      headerSnapshots += 1
      if (changed) cacheEpochChanges += 1
      activeHeader = { reset: previousFingerprint === undefined || changed, used: false }
      previousFingerprint = currentFingerprint
      continue
    }
    if (row.type !== 'assistant/message') continue
    const usage = record(data?.usage)
    if (usage === undefined) continue
    const totals = emptyTotals()
    addUsage(totals, usage)
    const reset = activeHeader?.used === false && activeHeader.reset
    if (activeHeader !== undefined) activeHeader.used = true
    calls.push({ usage: totals, reset })
    if (model === null) {
      const message = record(data?.message)
      const source = record(message?.source)
      if (typeof source?.model === 'string') model = source.model
    }
  }

  const all = sumCalls(calls)
  const warm = sumCalls(calls.slice(1))
  const sameEpoch = sumCalls(calls.filter(call => !call.reset))
  const resets = sumCalls(calls.filter(call => call.reset))
  return {
    file,
    sessionId: typeof session.id === 'string' ? session.id : basename(file),
    preset: selectedPreset ?? (typeof session.agentPreset === 'string' ? session.agentPreset : 'default'),
    model,
    ...all,
    hitPct: hitPercent(all),
    warmHitPct: hitPercent(warm),
    sameEpochHitPct: hitPercent(sameEpoch),
    headerSnapshots,
    cacheEpochChanges,
    resetCalls: resets.calls,
    resetUncachedTokens: resets.uncachedInputTokens,
    resetMissSharePct: sharePercent(resets.uncachedInputTokens, all.uncachedInputTokens),
  }
}

async function sessionFiles(target: string): Promise<string[]> {
  const info = await stat(target)
  if (info.isFile()) return [target]
  if (!info.isDirectory()) return []
  const files: string[] = []
  const entries = await readdir(target, { withFileTypes: true })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    const path = join(target, entry.name)
    if (entry.isDirectory()) files.push(...await sessionFiles(path))
    if (entry.isFile() && (entry.name === 'session.jsonl' || entry.name === 'session.jsonl.zstd')) {
      files.push(path)
    }
  }
  return files
}

async function readSession(file: string): Promise<string> {
  const bytes = await readFile(file)
  if (!file.endsWith('.zstd')) return bytes.toString('utf8')
  return (await decompressConcatenatedZstd(bytes)).toString('utf8')
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const targetArg = args.find(argument => !argument.startsWith('--'))
  if (targetArg === undefined) {
    throw new Error('usage: pnpm cache:analyze -- <session-file-or-sessions-directory> [--json]')
  }
  const target = resolve(targetArg)
  const files = await sessionFiles(target)
  const summaries = (await Promise.all(files.map(async file =>
    analyzeSessionJsonl(await readSession(file), file))))
    .filter(summary => summary.calls > 0)
  if (json) {
    console.log(JSON.stringify(summaries, null, 2))
    return
  }
  console.table(summaries.map(summary => ({
    session: summary.sessionId,
    preset: summary.preset,
    calls: summary.calls,
    hitPct: summary.hitPct,
    warmHitPct: summary.warmHitPct,
    sameEpochHitPct: summary.sameEpochHitPct,
    epochChanges: summary.cacheEpochChanges,
    resetMissSharePct: summary.resetMissSharePct,
    uncached: summary.uncachedInputTokens,
  })))
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
