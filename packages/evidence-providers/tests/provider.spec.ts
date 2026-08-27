import { describe, expect, it, vi } from 'vitest'
import {
  CrossrefLiteratureProvider,
  SharedRateLimiter,
  retryAfterMilliseconds,
} from '../src/index.js'

describe('shared literature rate limiting', () => {
  it('enforces a shared partition concurrency limit across callers', async () => {
    const limiter = new SharedRateLimiter({ maxConcurrent: 2, minimumIntervalMs: 0 })
    let active = 0
    let maximum = 0
    const operations = Array.from({ length: 8 }, () => limiter.run('crossref\0<anonymous>', undefined, async () => {
      active += 1
      maximum = Math.max(maximum, active)
      await new Promise<void>(resolve => setTimeout(resolve, 5))
      active -= 1
    }))
    await Promise.all(operations)
    expect(maximum).toBe(2)
  })

  it('parses Retry-After delta seconds and HTTP dates', () => {
    expect(retryAfterMilliseconds('3', 0)).toBe(3_000)
    expect(retryAfterMilliseconds('Thu, 01 Jan 1970 00:00:05 GMT', 2_000)).toBe(3_000)
    expect(retryAfterMilliseconds('not-a-date', 0)).toBeUndefined()
  })
})

describe('Crossref replay-safe provider', () => {
  it('paginates bounded normalized items and sends no secret in the URL', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      expect(url.searchParams.get('query.bibliographic')).toBe('remote sensing')
      expect(url.searchParams.get('offset')).toBe('0')
      expect(url.searchParams.has('cursor')).toBe(false)
      expect(url.href).not.toContain('secret-token')
      expect(new Headers(init?.headers).get('crossref-plus-api-token')).toBe('Bearer secret-token')
      return Response.json({
        message: {
          items: [{
            DOI: '10.1234/FIXTURE',
            title: ['Fixture title'],
            author: [{ given: 'Ada', family: 'Lovelace', ORCID: null }],
            'published-online': { 'date-parts': [[2025, 1, 1]] },
            'container-title': ['Fixture Journal'],
            type: 'journal-article',
            URL: 'https://doi.org/10.1234/FIXTURE',
          }],
          'total-results': 2,
          'next-cursor': 'stateful-token-that-must-be-ignored',
        },
      }, { headers: { 'x-request-id': 'request-1' } })
    })
    const provider = new CrossrefLiteratureProvider({ fetch: fetcher })
    const page = await provider.searchPage({
      request: {
        query: 'remote sensing',
        filters: { yearStart: null, yearEnd: null, publicationTypes: [] },
        maxResults: 10,
      },
      upstreamState: provider.initialUpstreamState(),
      credential: { ref: 'CROSSREF_TOKEN', value: 'secret-token', bindingEpoch: 1 },
      pageSize: 1,
    })
    expect(page.items[0]).toMatchObject({
      providerItemId: '10.1234/fixture',
      title: 'Fixture title',
      year: 2025,
    })
    expect(page.nextUpstreamState).toEqual({ offset: 1 })
    expect(page.done).toBe(false)
    expect(page.requestId).toBe('request-1')
    await provider.dispose()
  })

  it('uses bounded fallback backoff for an invalid Retry-After and then succeeds', async () => {
    const sleeps: number[] = []
    const limiter = new SharedRateLimiter({
      maxConcurrent: 1,
      minimumIntervalMs: 0,
      now: () => 0,
      delay: async milliseconds => { sleeps.push(milliseconds) },
    })
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': 'bad' } }))
      .mockResolvedValueOnce(Response.json({ message: { items: [], 'total-results': 0 } }))
    const provider = new CrossrefLiteratureProvider({
      fetch: fetcher,
      limiter,
      random: () => 0.5,
      maxRetries: 1,
      now: () => 0,
    })
    const page = await provider.searchPage({
      request: {
        query: 'fixture',
        filters: { yearStart: null, yearEnd: null, publicationTypes: [] },
        maxResults: 10,
      },
      upstreamState: provider.initialUpstreamState(),
      credential: { ref: null, value: null, bindingEpoch: 0 },
      pageSize: 10,
    })
    expect(page.warnings).toEqual([expect.objectContaining({ code: 'LITERATURE_RETRY_AFTER_INVALID' })])
    expect(sleeps).toEqual([500])
    await provider.dispose()
  })

  it('downgrades a malformed DOI instead of publishing it as a DOI identity', async () => {
    const provider = new CrossrefLiteratureProvider({
      fetch: async () => Response.json({
        message: {
          items: [{
            DOI: 'not-a-doi',
            title: ['Malformed DOI fixture'],
            author: [],
            'published-online': { 'date-parts': [[2025]] },
            'container-title': ['Fixture Journal'],
            type: 'journal-article',
            URL: 'https://example.test/malformed-doi-fixture',
          }],
          'total-results': 1,
        },
      }),
    })
    const page = await provider.searchPage({
      request: {
        query: 'malformed DOI',
        filters: { yearStart: null, yearEnd: null, publicationTypes: [] },
        maxResults: 1,
      },
      upstreamState: provider.initialUpstreamState(),
      credential: { ref: null, value: null, bindingEpoch: 0 },
      pageSize: 1,
    })
    expect(page.items[0]).toMatchObject({
      doi: null,
      providerItemId: 'https://example.test/malformed-doi-fixture',
      stableIdentifier: 'provider:https://example.test/malformed-doi-fixture',
    })
    expect(page.warnings).toContainEqual(expect.objectContaining({ code: 'LITERATURE_DOI_INVALID' }))
    await provider.dispose()
  })

  it('keeps an advancing empty offset page resumable after local publication-type filtering', async () => {
    const provider = new CrossrefLiteratureProvider({
      fetch: async () => Response.json({
        message: {
          items: [{
            DOI: '10.1234/FILTERED',
            title: ['Filtered fixture'],
            author: [],
            'published-online': { 'date-parts': [[2025]] },
            'container-title': ['Fixture Journal'],
            type: 'book-chapter',
            URL: 'https://doi.org/10.1234/FILTERED',
          }],
          'total-results': 2,
        },
      }),
    })
    const result = await provider.searchPage({
      request: {
        query: 'fixture',
        filters: { yearStart: null, yearEnd: null, publicationTypes: ['journal-article'] },
        maxResults: 10,
      },
      upstreamState: provider.initialUpstreamState(),
      credential: { ref: null, value: null, bindingEpoch: 0 },
      pageSize: 1,
    })
    expect(result.items).toEqual([])
    expect(result.done).toBe(false)
    expect(result.nextUpstreamState).toEqual({ offset: 1 })
    await provider.dispose()
  })

  it('replays an immutable offset request without Crossref scroll-cursor state', async () => {
    const requestedOffsets: string[] = []
    const provider = new CrossrefLiteratureProvider({
      fetch: async input => {
        const url = new URL(String(input))
        requestedOffsets.push(url.searchParams.get('offset') ?? '<missing>')
        return Response.json({
          message: {
            items: [{
              DOI: '10.1234/REPLAY',
              title: ['Replay fixture'],
              author: [],
              'published-online': { 'date-parts': [[2025]] },
              'container-title': ['Fixture Journal'],
              type: 'journal-article',
              URL: 'https://doi.org/10.1234/REPLAY',
            }],
            'total-results': 2,
            'next-cursor': 'same-stateful-token',
          },
        })
      },
    })
    const request = {
      request: {
        query: 'fixture',
        filters: { yearStart: null, yearEnd: null, publicationTypes: [] },
        maxResults: 1,
      },
      upstreamState: provider.initialUpstreamState(),
      credential: { ref: null, value: null, bindingEpoch: 0 },
      pageSize: 1,
    } as const
    const first = await provider.searchPage(request)
    const replay = await provider.searchPage(request)
    expect(requestedOffsets).toEqual(['0', '0'])
    expect(replay).toEqual(first)
    expect(first.nextUpstreamState).toEqual({ offset: 1 })
    await provider.dispose()
  })
})
