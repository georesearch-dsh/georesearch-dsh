import { promisify } from 'node:util'
import { zstdCompress } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  analyzeSessionJsonl,
  decompressConcatenatedZstd,
} from '../scripts/analyze-prompt-cache.js'

const compress = promisify(zstdCompress)

function line(value: unknown): string {
  return JSON.stringify(value)
}

function assistant(seq: number, inputTokens: number, cacheReadTokens: number): object {
  return {
    type: 'assistant/message',
    seq,
    data: {
      message: { source: { model: 'deepseek-v4-pro' } },
      usage: { inputTokens, outputTokens: 10, cacheReadTokens },
    },
  }
}

describe('prompt cache session analysis', () => {
  it('decodes the independently appended Zstandard frames used by Harness', async () => {
    const first = await compress('first\n')
    const second = await compress('second\n')
    await expect(decompressConcatenatedZstd(Buffer.concat([first, second])))
      .resolves.toEqual(Buffer.from('first\nsecond\n'))
  })

  it('separates cold/header-reset misses from stable-epoch traffic', () => {
    const header = { config: { provider: 'deepseek-official', model: 'deepseek-v4-pro' }, system: 'v1', tools: [] }
    const changed = { ...header, system: 'v2' }
    const jsonl = [
      { type: 'session', id: 'session-cache', agentPreset: 'standard' },
      { type: 'agent-preset/selected', seq: 0, data: { agentPreset: 'georesearch' } },
      { type: 'request/header', seq: 1, data: { reason: 'initial', header } },
      assistant(2, 1_000, 0),
      { type: 'request/header', seq: 3, data: { reason: 'resume', header } },
      assistant(4, 50, 950),
      { type: 'request/header', seq: 5, data: { reason: 'resume', header: changed } },
      assistant(6, 1_200, 0),
      assistant(7, 50, 1_250),
    ].map(line).join('\n')

    expect(analyzeSessionJsonl(jsonl)).toMatchObject({
      sessionId: 'session-cache',
      preset: 'georesearch',
      model: 'deepseek-v4-pro',
      calls: 4,
      promptTokens: 4_500,
      uncachedInputTokens: 2_300,
      cacheReadTokens: 2_200,
      hitPct: 48.9,
      warmHitPct: 62.9,
      sameEpochHitPct: 95.7,
      headerSnapshots: 3,
      cacheEpochChanges: 1,
      resetCalls: 2,
      resetUncachedTokens: 2_200,
      resetMissSharePct: 95.7,
    })
  })
})
