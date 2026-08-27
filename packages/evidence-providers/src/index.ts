import {
  GeoResearchError,
  digestPhase3Body,
  type JsonValue,
  type LiteratureAuthor,
  type LiteratureItem,
  type LiteratureProviderCapability,
  type LiteratureProviderPage,
  type LiteratureSearchRequest,
  type LiteratureWarning,
} from '@georesearch/dsh-contracts'
import { ProviderLifecycle } from '@georesearch/dsh-provider-lifecycle'

const CROSSREF_RESULT_WINDOW = 10_000

export interface LiteratureProviderCredential {
  readonly ref: string | null
  readonly value: string | null
  readonly bindingEpoch: number
}

export interface LiteratureProviderPageRequest {
  readonly request: LiteratureSearchRequest
  readonly upstreamState: JsonValue | null
  readonly credential: LiteratureProviderCredential
  readonly pageSize: number
  readonly signal?: AbortSignal
}

export interface LiteratureProvider {
  readonly capability: LiteratureProviderCapability
  initialUpstreamState(): JsonValue
  searchPage(request: LiteratureProviderPageRequest): Promise<LiteratureProviderPage>
  drain(): Promise<void>
  dispose(): Promise<void>
}

export interface SharedRateLimiterOptions {
  readonly maxConcurrent: number
  readonly minimumIntervalMs: number
  readonly now?: () => number
  readonly delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
}

interface RatePartition {
  active: number
  nextAllowedAt: number
  readonly waiters: Array<{
    readonly signal?: AbortSignal
    readonly resolve: () => void
    readonly reject: (error: unknown) => void
    abort?: () => void
  }>
}

export class SharedRateLimiter {
  private readonly partitions = new Map<string, RatePartition>()
  private readonly maxConcurrent: number
  private readonly minimumIntervalMs: number
  private readonly clock: () => number
  private readonly sleeper: (milliseconds: number, signal?: AbortSignal) => Promise<void>

  constructor(options: SharedRateLimiterOptions) {
    this.maxConcurrent = positiveInteger(options.maxConcurrent, 'maxConcurrent')
    this.minimumIntervalMs = nonNegativeInteger(options.minimumIntervalMs, 'minimumIntervalMs')
    this.clock = options.now ?? Date.now
    this.sleeper = options.delay ?? abortableDelay
  }

  async run<T>(partitionKey: string, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
    const partition = this.partition(partitionKey)
    await this.acquire(partition, signal)
    try {
      const waitMs = Math.max(0, partition.nextAllowedAt - this.clock())
      if (waitMs > 0) await this.sleeper(waitMs, signal)
      partition.nextAllowedAt = Math.max(partition.nextAllowedAt, this.clock()) + this.minimumIntervalMs
      return await operation()
    } finally {
      partition.active -= 1
      this.wake(partition)
    }
  }

  defer(partitionKey: string, milliseconds: number): void {
    const partition = this.partition(partitionKey)
    partition.nextAllowedAt = Math.max(partition.nextAllowedAt, this.clock() + Math.max(0, milliseconds))
  }

  private partition(key: string): RatePartition {
    let partition = this.partitions.get(key)
    if (partition === undefined) {
      partition = { active: 0, nextAllowedAt: 0, waiters: [] }
      this.partitions.set(key, partition)
    }
    return partition
  }

  private async acquire(partition: RatePartition, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (partition.active < this.maxConcurrent) {
      partition.active += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: RatePartition['waiters'][number] = {
        ...(signal === undefined ? {} : { signal }),
        resolve,
        reject,
      }
      if (signal !== undefined) {
        waiter.abort = () => {
          const index = partition.waiters.indexOf(waiter)
          if (index >= 0) partition.waiters.splice(index, 1)
          reject(abortError(signal))
        }
        signal.addEventListener('abort', waiter.abort, { once: true })
      }
      partition.waiters.push(waiter)
    })
    signal?.throwIfAborted()
  }

  private wake(partition: RatePartition): void {
    while (partition.active < this.maxConcurrent) {
      const waiter = partition.waiters.shift()
      if (waiter === undefined) return
      if (waiter.abort !== undefined) waiter.signal?.removeEventListener('abort', waiter.abort)
      if (waiter.signal?.aborted === true) {
        waiter.reject(abortError(waiter.signal))
        continue
      }
      partition.active += 1
      waiter.resolve()
    }
  }
}

export interface CrossrefProviderOptions {
  readonly fetch?: typeof globalThis.fetch
  readonly limiter?: SharedRateLimiter
  readonly endpoint?: string
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  readonly maxRetries?: number
  readonly random?: () => number
  readonly now?: () => number
  readonly userAgent?: string
}

export class CrossrefLiteratureProvider implements LiteratureProvider {
  readonly capability: LiteratureProviderCapability = Object.freeze({
    providerId: 'crossref',
    providerVersion: '1.1.0',
    continuationFormatDigest: digestPhase3Body({
      domain: 'georesearch.crossref-continuation/v2',
      state: { offset: 'non-negative-integer' },
    }),
    replaySemantics: 'replay-safe-read',
    maxPageSize: 100,
    supportsCredentialRef: true,
  })

  private readonly lifecycle = new ProviderLifecycle()
  private readonly fetcher: typeof globalThis.fetch
  private readonly limiter: SharedRateLimiter
  private readonly endpoint: string
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number
  private readonly maxRetries: number
  private readonly random: () => number
  private readonly clock: () => number
  private readonly userAgent: string

  constructor(options: CrossrefProviderOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch
    this.clock = options.now ?? Date.now
    this.limiter = options.limiter ?? new SharedRateLimiter({
      maxConcurrent: 2,
      minimumIntervalMs: 100,
      now: this.clock,
    })
    this.endpoint = options.endpoint ?? 'https://api.crossref.org/works'
    this.timeoutMs = boundedInteger(options.timeoutMs ?? 30_000, 1, 120_000, 'timeoutMs')
    this.maxResponseBytes = boundedInteger(
      options.maxResponseBytes ?? 8 * 1024 * 1024,
      1,
      32 * 1024 * 1024,
      'maxResponseBytes',
    )
    this.maxRetries = boundedInteger(options.maxRetries ?? 2, 0, 5, 'maxRetries')
    this.random = options.random ?? Math.random
    this.userAgent = options.userAgent ?? 'GeoResearch/0.1.0 (mailto:local-user@example.invalid)'
  }

  initialUpstreamState(): JsonValue {
    return { offset: 0 }
  }

  searchPage(request: LiteratureProviderPageRequest): Promise<LiteratureProviderPage> {
    return this.lifecycle.admit(() => this.searchPageAdmitted(request))
  }

  drain(): Promise<void> {
    return this.lifecycle.drain()
  }

  dispose(): Promise<void> {
    return this.lifecycle.dispose()
  }

  private async searchPageAdmitted(request: LiteratureProviderPageRequest): Promise<LiteratureProviderPage> {
    const offset = parseOffset(request.upstreamState ?? this.initialUpstreamState())
    const requestedPageSize = boundedInteger(request.pageSize, 1, this.capability.maxPageSize, 'pageSize')
    if (offset >= CROSSREF_RESULT_WINDOW) {
      return {
        items: [],
        nextUpstreamState: null,
        done: true,
        warnings: [{
          code: 'LITERATURE_PROVIDER_RESULT_WINDOW_REACHED',
          message: `Crossref offset pagination is bounded to ${CROSSREF_RESULT_WINDOW} results.`,
        }],
        requestId: null,
      }
    }
    const pageSize = Math.min(requestedPageSize, CROSSREF_RESULT_WINDOW - offset)
    const partition = `${this.capability.providerId}\0${request.credential.ref ?? '<anonymous>'}`
    const warnings: LiteratureWarning[] = []
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      request.signal?.throwIfAborted()
      const timeout = AbortSignal.timeout(this.timeoutMs)
      const signal = request.signal === undefined ? timeout : AbortSignal.any([request.signal, timeout])
      let response: Response
      try {
        response = await this.limiter.run(partition, signal, () => this.fetcher(
          crossrefUrl(this.endpoint, request.request, offset, pageSize),
          {
            method: 'GET',
            headers: requestHeaders(this.userAgent, request.credential.value),
            signal,
          },
        ))
      } catch (error) {
        if (request.signal?.aborted === true) {
          throw new GeoResearchError('LITERATURE_CANCELLED', 'Crossref request was cancelled', { cause: error })
        }
        if (timeout.aborted) {
          throw new GeoResearchError('LITERATURE_TIMEOUT', 'Crossref request timed out', { cause: error })
        }
        throw new GeoResearchError('LITERATURE_PROVIDER_FAILURE', 'Crossref request failed', { cause: error })
      }
      if (response.status === 429) {
        await response.body?.cancel().catch(() => undefined)
        const retry = retryAfterMilliseconds(response.headers.get('retry-after'), this.clock())
        const delayMs = retry ?? jitteredBackoff(attempt, this.random)
        if (retry === undefined) {
          warnings.push({
            code: 'LITERATURE_RETRY_AFTER_INVALID',
            message: 'Crossref returned an absent or invalid Retry-After value; bounded jittered backoff was used.',
          })
        }
        this.limiter.defer(partition, delayMs)
        if (attempt === this.maxRetries) {
          throw new GeoResearchError('LITERATURE_RATE_LIMITED', 'Crossref rate limit retry budget was exhausted')
        }
        continue
      }
      if (response.status === 401) {
        await response.body?.cancel().catch(() => undefined)
        throw new GeoResearchError('LITERATURE_AUTH_REQUIRED', 'Crossref credential was rejected')
      }
      if (response.status === 403) {
        await response.body?.cancel().catch(() => undefined)
        throw new GeoResearchError('LITERATURE_ACCESS_DENIED', 'Crossref access was denied')
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw new GeoResearchError(
          'LITERATURE_PROVIDER_FAILURE',
          `Crossref returned HTTP ${response.status}`,
        )
      }
      let body: unknown
      try {
        body = await readBoundedJson(response, this.maxResponseBytes, signal)
      } catch (error) {
        if (request.signal?.aborted === true) {
          throw new GeoResearchError('LITERATURE_CANCELLED', 'Crossref response read was cancelled', { cause: error })
        }
        if (timeout.aborted) {
          throw new GeoResearchError('LITERATURE_TIMEOUT', 'Crossref response read timed out', { cause: error })
        }
        throw error
      }
      const parsed = parseCrossrefPage(body)
      warnings.push(...parsed.warnings)
      if (parsed.items.length > pageSize) {
        throw new GeoResearchError('LITERATURE_PROVIDER_FAILURE', 'Crossref returned more items than requested')
      }
      const items = request.request.filters.publicationTypes.length === 0
        ? parsed.items
        : parsed.items.filter(item => request.request.filters.publicationTypes.includes(item.sourceType))
      const nextOffset = offset + parsed.items.length
      const windowReached = nextOffset >= CROSSREF_RESULT_WINDOW
      const done = parsed.items.length === 0 || nextOffset >= parsed.totalResults || windowReached
      if (windowReached && nextOffset < parsed.totalResults) {
        warnings.push({
          code: 'LITERATURE_PROVIDER_RESULT_WINDOW_REACHED',
          message: `Crossref offset pagination is bounded to ${CROSSREF_RESULT_WINDOW} results.`,
        })
      }
      return {
        items,
        nextUpstreamState: done ? null : { offset: nextOffset },
        done,
        warnings,
        requestId: response.headers.get('x-request-id'),
      }
    }
    throw new GeoResearchError('LITERATURE_PROVIDER_FAILURE', 'Crossref retry loop ended unexpectedly')
  }
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (value === null) return undefined
  const trimmed = value.trim()
  if (/^\d+$/u.test(trimmed)) {
    const seconds = Number(trimmed)
    return Number.isSafeInteger(seconds) ? Math.min(seconds * 1_000, 120_000) : undefined
  }
  const date = Date.parse(trimmed)
  if (!Number.isFinite(date)) return undefined
  return Math.min(Math.max(0, date - now), 120_000)
}

function crossrefUrl(
  endpoint: string,
  request: LiteratureSearchRequest,
  offset: number,
  pageSize: number,
): string {
  const url = new URL(endpoint)
  url.searchParams.set('query.bibliographic', request.query)
  url.searchParams.set('rows', String(pageSize))
  url.searchParams.set('offset', String(offset))
  url.searchParams.set('select', 'DOI,title,author,published-print,published-online,container-title,type,URL')
  const filters: string[] = []
  if (request.filters.yearStart !== null) filters.push(`from-pub-date:${request.filters.yearStart}-01-01`)
  if (request.filters.yearEnd !== null) filters.push(`until-pub-date:${request.filters.yearEnd}-12-31`)
  if (request.filters.publicationTypes.length === 1) filters.push(`type:${request.filters.publicationTypes[0]}`)
  if (filters.length > 0) url.searchParams.set('filter', filters.join(','))
  return url.href
}

function requestHeaders(userAgent: string, credential: string | null): Record<string, string> {
  return {
    accept: 'application/json',
    'user-agent': userAgent,
    ...(credential === null ? {} : { 'crossref-plus-api-token': `Bearer ${credential}` }),
  }
}

async function readBoundedJson(response: Response, maxBytes: number, signal?: AbortSignal): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) {
    throw new GeoResearchError('LITERATURE_RESPONSE_TOO_LARGE', 'literature provider response exceeds the byte limit')
  }
  if (response.body === null) throw new GeoResearchError('LITERATURE_PROVIDER_FAILURE', 'literature provider returned no body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      signal?.throwIfAborted()
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxBytes) {
        await reader.cancel()
        throw new GeoResearchError('LITERATURE_RESPONSE_TOO_LARGE', 'literature provider response exceeds the byte limit')
      }
      chunks.push(chunk.value)
    }
  } catch (error) {
    if (signal?.aborted === true) throw abortError(signal)
    throw error
  } finally {
    reader.releaseLock()
  }
  const bytes = Buffer.concat(chunks.map(chunk => Buffer.from(chunk)), size)
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown
  } catch (error) {
    throw new GeoResearchError('LITERATURE_PROVIDER_FAILURE', 'literature provider returned invalid JSON', { cause: error })
  }
}

function parseCrossrefPage(value: unknown): {
  readonly items: LiteratureItem[]
  readonly totalResults: number
  readonly warnings: LiteratureWarning[]
} {
  const root = objectRecord(value, 'Crossref response')
  const message = objectRecord(root.message, 'Crossref response.message')
  if (!Array.isArray(message.items)) throw new GeoResearchError('LITERATURE_PROVIDER_FAILURE', 'Crossref items are missing')
  const parsedItems = message.items.map((entry, index) => crossrefItem(entry, index))
  if (!Number.isSafeInteger(message['total-results']) || (message['total-results'] as number) < 0) {
    throw new GeoResearchError('LITERATURE_PROVIDER_FAILURE', 'Crossref total-results is invalid')
  }
  const invalidDoiCount = parsedItems.filter(item => item.invalidDoi).length
  return {
    items: parsedItems.map(item => item.value),
    totalResults: message['total-results'] as number,
    warnings: invalidDoiCount === 0 ? [] : [{
      code: 'LITERATURE_DOI_INVALID',
      message: `${invalidDoiCount} Crossref item(s) contained a malformed DOI and were downgraded to provider identifiers.`,
    }],
  }
}

function crossrefItem(value: unknown, index: number): { readonly value: LiteratureItem; readonly invalidDoi: boolean } {
  const record = objectRecord(value, `Crossref item ${index}`)
  const rawDoi = nullableString(record.DOI)
  const doi = normalizeDoi(rawDoi)
  const url = nullableString(record.URL)
  const providerItemId = doi ?? url ?? digestPhase3Body(record)
  const title = firstText(record.title) ?? `[untitled ${providerItemId}]`
  const authors = Array.isArray(record.author)
    ? record.author.map((entry, authorIndex) => crossrefAuthor(entry, index, authorIndex))
    : []
  const venue = firstText(record['container-title'])
  return { value: {
    providerItemId,
    title,
    authors,
    year: crossrefYear(record),
    venue,
    doi,
    stableIdentifier: doi === null ? `provider:${providerItemId}` : `doi:${doi}`,
    sourceType: nullableString(record.type) ?? 'unknown',
    url,
  }, invalidDoi: rawDoi !== null && doi === null }
}

function normalizeDoi(value: string | null): string | null {
  if (value === null) return null
  const normalized = value.normalize('NFC').trim().toLowerCase()
  return /^10\.\d{4,9}\/\S+$/u.test(normalized) && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null
}

function crossrefAuthor(value: unknown, itemIndex: number, authorIndex: number): LiteratureAuthor {
  const record = objectRecord(value, `Crossref item ${itemIndex} author ${authorIndex}`)
  const given = nullableString(record.given)
  const family = nullableString(record.family)
  const name = [given, family].filter((part): part is string => part !== null).join(' ').trim()
  return { name: name === '' ? 'Unknown author' : name, orcid: nullableString(record.ORCID) }
}

function crossrefYear(record: Record<string, unknown>): number | null {
  for (const field of ['published-print', 'published-online']) {
    const date = record[field]
    if (typeof date !== 'object' || date === null || Array.isArray(date)) continue
    const parts = (date as Record<string, unknown>)['date-parts']
    if (!Array.isArray(parts) || !Array.isArray(parts[0])) continue
    const year = parts[0][0]
    if (Number.isSafeInteger(year) && (year as number) >= 0) return year as number
  }
  return null
}

function firstText(value: unknown): string | null {
  if (!Array.isArray(value)) return null
  for (const entry of value) {
    const text = nullableString(entry)
    if (text !== null) return text
  }
  return null
}

function parseOffset(value: JsonValue): number {
  const record = objectRecord(value, 'literature upstream state')
  if (Object.keys(record).length !== 1
    || !Number.isSafeInteger(record.offset)
    || (record.offset as number) < 0
    || (record.offset as number) > CROSSREF_RESULT_WINDOW) {
    throw new GeoResearchError('LITERATURE_PROVIDER_INCOMPATIBLE', 'Crossref continuation state is invalid')
  }
  return record.offset as number
}

function jitteredBackoff(attempt: number, random: () => number): number {
  const base = Math.min(30_000, 500 * (2 ** attempt))
  return Math.round(base * (0.75 + Math.max(0, Math.min(1, random())) * 0.5))
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) return
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(abortError(signal as AbortSignal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('operation aborted')
}

function objectRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GeoResearchError('LITERATURE_PROVIDER_FAILURE', `${field} must be an object`)
  }
  return value as Record<string, unknown>
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function positiveInteger(value: number, field: string): number {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, field)
}

function nonNegativeInteger(value: number, field: string): number {
  return boundedInteger(value, 0, Number.MAX_SAFE_INTEGER, field)
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}
