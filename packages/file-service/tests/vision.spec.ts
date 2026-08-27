import { describe, expect, it, vi } from 'vitest'
import {
  DEEPSEEK_VISION_CREDENTIAL_REF,
  DEEPSEEK_VISION_LIMITS,
  DEEPSEEK_VISION_MODEL,
  DeepSeekVisionAnalyzer,
  DeepSeekVisionError,
  describeVisionFailure,
} from '../src/vision.js'

describe('DeepSeek visual understanding', () => {
  it('uses the managed credential and official multimodal Chat Completions shape', async () => {
    const resolve = vi.fn(async () => ({ value: 'fixture-secret', source: 'fixture' as const }))
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        authorization: 'Bearer fixture-secret',
        'content-type': 'application/json',
      })
      return jsonResponse({
        choices: [{
          finish_reason: 'stop',
          message: { content: 'The map shows two study regions and a north arrow.' },
        }],
        usage: {
          prompt_tokens: 410,
          completion_tokens: 25,
          total_tokens: 435,
          prompt_cache_hit_tokens: 10,
          prompt_cache_miss_tokens: 400,
          completion_tokens_details: { reasoning_tokens: 0 },
        },
      }, { 'x-request-id': 'vision-request-1' })
    })
    const analyzer = new DeepSeekVisionAnalyzer({
      credentials: { resolve },
      fetch: fetchMock as typeof fetch,
    })

    const result = await analyzer.analyze({
      data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
      mediaType: 'image/png',
      purpose: 'standalone',
      question: 'Which regions are highlighted?',
    })

    expect(resolve).toHaveBeenCalledOnce()
    expect(String(resolve.mock.calls[0]?.[0])).toBe(DEEPSEEK_VISION_CREDENTIAL_REF)
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://api.deepseek.com/chat/completions')
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      readonly model: string
      readonly thinking: { readonly type: string }
      readonly stream: boolean
      readonly messages: ReadonlyArray<{ readonly role: string; readonly content: unknown }>
    }
    expect(body).toMatchObject({
      model: DEEPSEEK_VISION_MODEL,
      thinking: { type: 'disabled' },
      stream: false,
    })
    expect(JSON.stringify(body.messages)).toContain('Which regions are highlighted?')
    expect(JSON.stringify(body.messages)).toContain('untrusted data')
    const userContent = body.messages[1]?.content as ReadonlyArray<Record<string, unknown>>
    expect(userContent[0]).toEqual(expect.objectContaining({
      type: 'image_url',
      image_url: expect.objectContaining({
        detail: 'high',
        url: expect.stringMatching(/^data:image\/png;base64,/u),
      }),
    }))
    expect(userContent[1]).toEqual(expect.objectContaining({
      type: 'text',
      text: expect.stringContaining('Which regions are highlighted?'),
    }))
    expect(JSON.stringify(body)).not.toContain('fixture-secret')
    expect(result).toMatchObject({
      provider: 'deepseek',
      model: DEEPSEEK_VISION_MODEL,
      text: 'The map shows two study regions and a north arrow.',
      finishReason: 'stop',
      requestId: 'vision-request-1',
      usage: {
        promptTokens: 410,
        completionTokens: 25,
        totalTokens: 435,
        promptCacheHitTokens: 10,
        promptCacheMissTokens: 400,
        reasoningTokens: 0,
      },
      input: { mediaType: 'image/png', bytes: 4, purpose: 'standalone', detail: 'high' },
      cacheStatus: 'provider-response',
    })
  })

  it('reuses an exact visual analysis without another provider request', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      choices: [{
        finish_reason: 'stop',
        message: { content: 'Exact cached visual analysis.' },
      }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
      },
    }, { 'x-request-id': 'vision-cache-source' }))
    const analyzer = new DeepSeekVisionAnalyzer({
      credentials: fixtureCredentials(),
      fetch: fetchMock as typeof fetch,
    })
    const request = { ...imageRequest(), question: 'What is visible?' }

    const first = await analyzer.analyze(request)
    const second = await analyzer.analyze(request)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(first.cacheStatus).toBe('provider-response')
    expect(second).toMatchObject({
      cacheStatus: 'local-exact-hit',
      requestId: 'vision-cache-source',
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 0,
        reasoningTokens: 0,
      },
    })
    expect(second.warnings.join(' ')).toMatch(/no provider request was issued/iu)
  })

  it('coalesces concurrent exact visual-analysis requests', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const fetchMock = vi.fn(async () => {
      await gate
      return jsonResponse({
        choices: [{
          finish_reason: 'stop',
          message: { content: 'Coalesced visual analysis.' },
        }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
        },
      }, { 'x-request-id': 'vision-coalesced-source' })
    })
    const analyzer = new DeepSeekVisionAnalyzer({
      credentials: fixtureCredentials(),
      fetch: fetchMock as typeof fetch,
    })
    const request = { ...imageRequest(), question: 'What is visible?' }

    const first = analyzer.analyze(request)
    const second = analyzer.analyze(request)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    release?.()
    const [firstResult, secondResult] = await Promise.all([first, second])

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(firstResult.cacheStatus).toBe('provider-response')
    expect(secondResult).toMatchObject({
      cacheStatus: 'local-exact-hit',
      requestId: 'vision-coalesced-source',
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        promptCacheHitTokens: 0,
        promptCacheMissTokens: 0,
        reasoningTokens: 0,
      },
    })
  })

  it('bounds the exact visual-analysis cache', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      choices: [{ finish_reason: 'stop', message: { content: 'Bounded cache result.' } }],
    }))
    const analyzer = new DeepSeekVisionAnalyzer({
      credentials: fixtureCredentials(),
      cacheMaxEntries: 1,
      fetch: fetchMock as typeof fetch,
    })

    await analyzer.analyze({ ...imageRequest(), question: 'Question A' })
    await analyzer.analyze({ ...imageRequest(), question: 'Question B' })
    await analyzer.analyze({ ...imageRequest(), question: 'Question A' })

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('fails safely when the managed credential is absent', async () => {
    const fetchMock = vi.fn()
    const analyzer = new DeepSeekVisionAnalyzer({
      credentials: { resolve: async () => undefined },
      fetch: fetchMock as typeof fetch,
    })

    await expect(analyzer.analyze(imageRequest())).rejects.toMatchObject({
      code: 'MISSING_CREDENTIAL',
      message: expect.stringContaining(DEEPSEEK_VISION_CREDENTIAL_REF),
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not expose provider error bodies through fallback warnings', async () => {
    const analyzer = new DeepSeekVisionAnalyzer({
      credentials: fixtureCredentials(),
      fetch: (async () => new Response(JSON.stringify({
        error: { message: 'echoed prompt and fixture-secret' },
      }), { status: 401 })) as typeof fetch,
    })

    let failure: unknown
    try {
      await analyzer.analyze(imageRequest())
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ code: 'HTTP_ERROR', status: 401 })
    expect(describeVisionFailure(failure)).toBe('DeepSeek vision API returned HTTP 401')
    expect(describeVisionFailure(failure)).not.toContain('fixture-secret')
  })

  it('retries transient transport and retryable HTTP failures', async () => {
    let attempt = 0
    const fetchMock = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new TypeError('temporary connection reset')
      if (attempt < 5) return new Response('', { status: 503 })
      return jsonResponse({
        choices: [{
          finish_reason: 'stop',
          message: { content: 'Recovered visual analysis.' },
        }],
      })
    })
    const analyzer = new DeepSeekVisionAnalyzer({
      credentials: fixtureCredentials(),
      retryBaseDelayMs: 0,
      fetch: fetchMock as typeof fetch,
    })

    const result = await analyzer.analyze(imageRequest())

    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(result.text).toBe('Recovered visual analysis.')
    expect(result.warnings.join(' ')).toMatch(/succeeded after 5 attempts/u)
  })

  it('distinguishes internal timeout from caller cancellation', async () => {
    const timeoutAnalyzer = new DeepSeekVisionAnalyzer({
      credentials: fixtureCredentials(),
      timeoutMs: 10,
      fetch: hangingFetch,
    })
    await expect(timeoutAnalyzer.analyze(imageRequest())).rejects.toMatchObject({ code: 'TIMEOUT' })

    const controller = new AbortController()
    const cancelled = new Error('caller cancelled image analysis')
    const fetchMock = vi.fn(hangingFetch)
    const cancelledAnalyzer = new DeepSeekVisionAnalyzer({
      credentials: fixtureCredentials(),
      fetch: fetchMock as typeof fetch,
    })
    const pending = cancelledAnalyzer.analyze(imageRequest(), controller.signal)
    const assertion = expect(pending).rejects.toBe(cancelled)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    controller.abort(cancelled)
    await assertion
  })

  it('bounds questions and rejects malformed successful responses', async () => {
    const analyzer = new DeepSeekVisionAnalyzer({
      credentials: fixtureCredentials(),
      fetch: (async () => jsonResponse({ choices: [] })) as typeof fetch,
    })
    await expect(analyzer.analyze({
      ...imageRequest(),
      question: 'x'.repeat(DEEPSEEK_VISION_LIMITS.maxQuestionBytes + 1),
    })).rejects.toThrow(/question exceeds/u)
    await expect(analyzer.analyze(imageRequest())).rejects.toBeInstanceOf(DeepSeekVisionError)
  })

  it('cancels provider output that exceeds the response byte envelope', async () => {
    const analyzer = new DeepSeekVisionAnalyzer({
      credentials: fixtureCredentials(),
      fetch: (async () => jsonResponse({
        choices: [{
          finish_reason: 'stop',
          message: { content: 'x'.repeat(DEEPSEEK_VISION_LIMITS.maxResponseBytes + 1) },
        }],
      })) as typeof fetch,
    })

    await expect(analyzer.analyze(imageRequest())).rejects.toMatchObject({ code: 'RESPONSE_LIMIT' })
  })
})

function imageRequest() {
  return {
    data: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]),
    mediaType: 'image/jpeg' as const,
    purpose: 'pdf-page' as const,
  }
}

function fixtureCredentials() {
  return { resolve: async () => ({ value: 'fixture-secret', source: 'fixture' as const }) }
}

const hangingFetch = (async (_url: string | URL | Request, init?: RequestInit) => (
  await new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })
  })
)) as typeof fetch

function jsonResponse(value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  })
}
