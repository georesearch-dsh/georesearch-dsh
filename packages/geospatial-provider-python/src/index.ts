import { createInterface, type Interface } from 'node:readline'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@georesearch/dsh-compat-rc5'
import {
  GeoResearchError,
  type DatasetLabelClass,
  type DatasetSplitMembership,
  type GeodataAssetInspection,
  type GeodataCheck,
  type GeospatialProviderCapability,
  type Sha256Digest,
} from '@georesearch/dsh-contracts'
import { ProviderLifecycle } from '@georesearch/dsh-provider-lifecycle'

const PROTOCOL = 'georesearch-worker/1'
const PROVIDER_VERSION = '0.1.0'
const MAX_LINE_CHARS = 16 * 1024 * 1024

export interface GeospatialSubprocessRuntime {
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

export interface PythonGeospatialProviderOptions {
  readonly runtime: GeospatialSubprocessRuntime
  readonly pythonRoot: string
  readonly pythonExecutable?: string
  readonly requestTimeoutMs?: number
  readonly graceMs?: number
  readonly environment?: Readonly<Record<string, string>>
  readonly now?: () => Date
}

export interface ProviderAssetRequest {
  readonly artifactId: string
  readonly digest: Sha256Digest
  readonly kind: string
  readonly mediaType: string
  readonly path: string
}

export interface ProviderInspectionOptions {
  readonly machineLearning: boolean
  readonly classification: boolean
  readonly categoricalResampling: string | null
  readonly labelSchema: readonly DatasetLabelClass[]
  readonly spatialStatistics: {
    readonly blockingStrategy: string
    readonly autocorrelation: string
    readonly multipleComparison: string
    readonly effectSize: string
  }
}

export interface ProviderInspectionRequest {
  readonly assets: readonly ProviderAssetRequest[]
  readonly splits: readonly DatasetSplitMembership[]
  readonly options: ProviderInspectionOptions
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}

export interface ProviderInspectionResult {
  readonly assets: readonly GeodataAssetInspection[]
  readonly checks: readonly GeodataCheck[]
}

interface WorkerHello {
  readonly type: 'hello'
  readonly protocol: typeof PROTOCOL
  readonly workerVersion: string
  readonly pythonVersion: string
  readonly capabilities: {
    readonly methods: readonly string[]
    readonly cancel: true
    readonly deadlines: true
    readonly libraries: Readonly<Record<string, string | null>>
  }
  readonly pid: number
}

interface PendingRequest {
  readonly id: string
  readonly resolve: (value: ProviderInspectionResult) => void
  readonly reject: (error: unknown) => void
  readonly timeout: NodeJS.Timeout
  abort?: () => void
  grace?: NodeJS.Timeout
  cause?: 'timeout' | 'cancel'
}

interface WorkerSession {
  readonly handle: SubprocessHandle
  readonly lines: Interface
  readonly hello: Promise<WorkerHello>
  readonly resolveHello: (value: WorkerHello) => void
  readonly rejectHello: (error: unknown) => void
  settled: boolean
}

export class PythonGeospatialProvider {
  private readonly runtime: GeospatialSubprocessRuntime
  private readonly pythonRoot: string
  private readonly pythonExecutable: string
  private readonly requestTimeoutMs: number
  private readonly graceMs: number
  private readonly environment: Readonly<Record<string, string>>
  private readonly now: () => Date
  private readonly lifecycle = new ProviderLifecycle()
  private readonly pending = new Map<string, PendingRequest>()
  private session: WorkerSession | undefined
  private sequence = 0
  private capabilityValue: GeospatialProviderCapability = {
    providerId: 'python-geospatial',
    providerVersion: PROVIDER_VERSION,
    protocol: PROTOCOL,
    shell: false,
    persistentWorker: true,
    cancel: true,
    deadlines: true,
    methods: ['inspect-dataset'],
    libraries: {},
  }

  constructor(options: PythonGeospatialProviderOptions) {
    this.runtime = options.runtime
    this.pythonRoot = nonEmpty(options.pythonRoot, 'pythonRoot')
    this.pythonExecutable = nonEmpty(options.pythonExecutable ?? 'python', 'pythonExecutable')
    this.requestTimeoutMs = positive(options.requestTimeoutMs ?? 120_000, 'requestTimeoutMs')
    this.graceMs = positive(options.graceMs ?? 2_000, 'graceMs')
    this.environment = options.environment ?? {}
    this.now = options.now ?? (() => new Date())
  }

  get capability(): GeospatialProviderCapability {
    return this.capabilityValue
  }

  get state() {
    return this.lifecycle.state
  }

  get inFlight(): number {
    return this.lifecycle.inFlight
  }

  async ready(): Promise<GeospatialProviderCapability> {
    const session = this.ensureSession()
    await session.hello
    return this.capabilityValue
  }

  inspect(request: ProviderInspectionRequest): Promise<ProviderInspectionResult> {
    return this.lifecycle.admit(async () => {
      validateInspectionRequest(request)
      const session = this.ensureSession()
      await session.hello
      return await this.request(session, request)
    })
  }

  drain(): Promise<void> {
    return this.lifecycle.drain()
  }

  dispose(): Promise<void> {
    return this.lifecycle.dispose({
      cancel: async () => {
        for (const pending of this.pending.values()) this.cancelPending(pending, 'cancel')
      },
      cleanup: async () => {
        const session = this.session
        if (session === undefined) return
        const stdin = session.handle.stdin
        if (stdin !== undefined && !stdin.destroyed && !stdin.writableEnded) {
          stdin.end(`${JSON.stringify({ type: 'shutdown' })}\n`)
        }
        const completed = await waitWithTimeout(session.handle.done, this.graceMs)
        if (!completed) {
          session.handle.terminate()
          await session.handle.waitForExit()
        }
        session.lines.close()
        if (this.session === session) this.session = undefined
      },
    })
  }

  private ensureSession(): WorkerSession {
    if (this.session !== undefined) return this.session
    let resolveHello!: (value: WorkerHello) => void
    let rejectHello!: (error: unknown) => void
    const hello = new Promise<WorkerHello>((resolve, reject) => {
      resolveHello = resolve
      rejectHello = reject
    })
    const handle = this.runtime.spawn({
      argv: [this.pythonExecutable, '-u', '-m', 'georesearch_worker'],
      cwd: this.pythonRoot,
      env: {
        ...this.environment,
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONNOUSERSITE: '1',
        PYTHONPATH: this.pythonRoot,
      },
      graceMs: this.graceMs,
      stdio: {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: { maxBytes: 256 * 1024 },
      },
    })
    const stdin = handle.stdin
    const stdout = handle.stdout
    if (stdin === undefined || stdout === undefined) {
      handle.terminate()
      throw new GeoResearchError('GEOSPATIAL_PROVIDER_UNAVAILABLE', 'Python worker pipes are unavailable')
    }
    const lines = createInterface({ input: stdout })
    const session: WorkerSession = { handle, lines, hello, resolveHello, rejectHello, settled: false }
    this.session = session
    stdin.on('error', error => this.failSession(
      session,
      new GeoResearchError('GEOSPATIAL_WORKER_CRASHED', error.message, { cause: error }),
    ))
    lines.on('line', line => this.onLine(session, line))
    lines.on('error', error => this.failSession(session, new GeoResearchError('GEOSPATIAL_WORKER_CRASHED', error.message, { cause: error })))
    void handle.done.then(
      outcome => this.failSession(session, new GeoResearchError('GEOSPATIAL_WORKER_CRASHED', `Python worker exited ${String(outcome.exitCode)}${outcome.signal === null ? '' : ` (${outcome.signal})`}`)),
      error => this.failSession(session, new GeoResearchError('GEOSPATIAL_WORKER_CRASHED', errorMessage(error), { cause: error })),
    )
    return session
  }

  private onLine(session: WorkerSession, line: string): void {
    if (line.length > MAX_LINE_CHARS) {
      this.failSession(session, new GeoResearchError('GEOSPATIAL_PROVIDER_INCOMPATIBLE', 'Python worker emitted an oversized protocol line'))
      session.handle.terminate()
      return
    }
    let value: unknown
    try {
      value = JSON.parse(line) as unknown
    } catch (error) {
      this.failSession(session, new GeoResearchError('GEOSPATIAL_PROVIDER_INCOMPATIBLE', 'Python worker emitted invalid NDJSON', { cause: error }))
      session.handle.terminate()
      return
    }
    if (!session.settled) {
      try {
        const hello = parseHello(value)
        session.settled = true
        this.capabilityValue = {
          ...this.capabilityValue,
          providerVersion: hello.workerVersion,
          libraries: hello.capabilities.libraries,
        }
        session.resolveHello(hello)
      } catch (error) {
        session.settled = true
        session.rejectHello(error)
        this.failSession(session, error)
        session.handle.terminate()
      }
      return
    }
    const response = record(value, 'worker response')
    const id = response.id
    if (typeof id !== 'string') {
      this.failSession(session, new GeoResearchError('GEOSPATIAL_PROVIDER_INCOMPATIBLE', 'Python worker response has no request id'))
      session.handle.terminate()
      return
    }
    const pending = this.pending.get(id)
    if (pending === undefined) return
    this.finishPending(pending)
    if (typeof response.error === 'string') {
      pending.reject(workerError(response.error, pending.cause))
      return
    }
    try {
      pending.resolve(parseInspectionResult(response.result))
    } catch (error) {
      pending.reject(new GeoResearchError('GEOSPATIAL_PROVIDER_INCOMPATIBLE', 'Python worker result is incompatible', { cause: error }))
    }
  }

  private request(session: WorkerSession, request: ProviderInspectionRequest): Promise<ProviderInspectionResult> {
    const id = `geodata-${process.pid}-${++this.sequence}`
    const timeoutMs = positive(request.timeoutMs ?? this.requestTimeoutMs, 'timeoutMs')
    const deadline = new Date(this.now().getTime() + timeoutMs)
    return new Promise<ProviderInspectionResult>((resolve, reject) => {
      const pending: PendingRequest = {
        id,
        resolve,
        reject,
        timeout: setTimeout(() => this.cancelPending(pending, 'timeout'), timeoutMs),
      }
      if (request.signal !== undefined) {
        const abort = () => this.cancelPending(pending, 'cancel')
        pending.abort = abort
        request.signal.addEventListener('abort', abort, { once: true })
      }
      this.pending.set(id, pending)
      const message = {
        id,
        method: 'inspect-dataset',
        deadline: deadline.toISOString(),
        params: {
          assets: request.assets,
          splits: request.splits,
          options: request.options,
        },
      }
      session.handle.stdin?.write(`${JSON.stringify(message)}\n`, error => {
        if (error === null || error === undefined) return
        this.finishPending(pending)
        reject(new GeoResearchError('GEOSPATIAL_WORKER_CRASHED', error.message, { cause: error }))
      })
    })
  }

  private cancelPending(pending: PendingRequest, cause: 'timeout' | 'cancel'): void {
    if (!this.pending.has(pending.id) || pending.cause !== undefined) return
    pending.cause = cause
    this.session?.handle.stdin?.write(`${JSON.stringify({ type: 'cancel', id: pending.id })}\n`)
    pending.grace = setTimeout(() => {
      if (!this.pending.has(pending.id)) return
      this.session?.handle.terminate()
    }, this.graceMs)
  }

  private finishPending(pending: PendingRequest): void {
    if (!this.pending.delete(pending.id)) return
    clearTimeout(pending.timeout)
    if (pending.grace !== undefined) clearTimeout(pending.grace)
  }

  private failSession(session: WorkerSession, error: unknown): void {
    if (this.session !== session) return
    this.session = undefined
    session.lines.close()
    if (!session.settled) {
      session.settled = true
      session.rejectHello(error)
    }
    for (const pending of this.pending.values()) {
      this.finishPending(pending)
      pending.reject(error)
    }
  }
}

function parseHello(value: unknown): WorkerHello {
  const source = record(value, 'worker hello')
  const capabilities = record(source.capabilities, 'worker hello capabilities')
  const methods = stringArray(capabilities.methods, 'worker hello methods')
  const libraries = record(capabilities.libraries, 'worker hello libraries')
  if (source.type !== 'hello' || source.protocol !== PROTOCOL || typeof source.workerVersion !== 'string'
    || typeof source.pythonVersion !== 'string' || !Number.isSafeInteger(source.pid)
    || capabilities.cancel !== true || capabilities.deadlines !== true || !methods.includes('inspect-dataset')) {
    throw new GeoResearchError('GEOSPATIAL_PROVIDER_INCOMPATIBLE', 'Python worker hello is incompatible')
  }
  if (libraries.rasterio === null || libraries.pyproj === null) {
    throw new GeoResearchError('GEOSPATIAL_PROVIDER_INCOMPATIBLE', 'mandatory rasterio/pyproj validators are unavailable')
  }
  return {
    type: 'hello', protocol: PROTOCOL, workerVersion: source.workerVersion,
    pythonVersion: source.pythonVersion, pid: source.pid as number,
    capabilities: {
      methods, cancel: true, deadlines: true,
      libraries: Object.fromEntries(Object.entries(libraries).map(([key, item]) => {
        if (item !== null && typeof item !== 'string') throw new TypeError(`worker library ${key} is invalid`)
        return [key, item as string | null]
      })),
    },
  }
}

function parseInspectionResult(value: unknown): ProviderInspectionResult {
  const source = record(value, 'inspection result')
  if (!Array.isArray(source.assets) || !Array.isArray(source.checks)) throw new TypeError('inspection result arrays are missing')
  return {
    assets: source.assets as unknown as readonly GeodataAssetInspection[],
    checks: source.checks as unknown as readonly GeodataCheck[],
  }
}

function validateInspectionRequest(request: ProviderInspectionRequest): void {
  if (request.assets.length === 0 || request.assets.length > 128) throw new TypeError('assets must contain 1 through 128 entries')
  for (const asset of request.assets) {
    nonEmpty(asset.artifactId, 'asset.artifactId')
    nonEmpty(asset.kind, 'asset.kind')
    nonEmpty(asset.mediaType, 'asset.mediaType')
    nonEmpty(asset.path, 'asset.path')
    if (!/^sha256:[0-9a-f]{64}$/u.test(asset.digest)) throw new TypeError('asset.digest is invalid')
  }
}

function workerError(code: string, cause: PendingRequest['cause']): GeoResearchError {
  if (cause === 'timeout' || code === 'DEADLINE_EXCEEDED') return new GeoResearchError('GEOSPATIAL_TIMEOUT', 'geospatial request exceeded its deadline')
  if (cause === 'cancel' || code === 'CANCELLED') return new GeoResearchError('GEOSPATIAL_CANCELLED', 'geospatial request was cancelled')
  if (code === 'GEOSPATIAL_PROVIDER_INCOMPATIBLE') return new GeoResearchError('GEOSPATIAL_PROVIDER_INCOMPATIBLE', 'Python geospatial dependencies are incompatible')
  return new GeoResearchError('GEODATA_INVALID', `Python geospatial request failed with ${code}`)
}

async function waitWithTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer!: NodeJS.Timeout
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs) }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${field} must be an object`)
  return value as Record<string, unknown>
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new TypeError(`${field} must be a string array`)
  return value as string[]
}

function nonEmpty(value: string, field: string): string {
  if (value.trim().length === 0 || value.includes('\0')) throw new TypeError(`${field} must be non-empty NUL-free text`)
  return value
}

function positive(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer`)
  return value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
