import { PassThrough, Writable } from 'node:stream'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@georesearch/dsh-compat-rc5'
import { digestJson } from '@georesearch/dsh-contracts'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PythonGeospatialProvider,
  type GeospatialSubprocessRuntime,
  type ProviderInspectionRequest,
} from '../src/index.js'

const providers: PythonGeospatialProvider[] = []

afterEach(async () => {
  await Promise.all(providers.splice(0).map(provider => provider.dispose().catch(() => undefined)))
})

describe('PythonGeospatialProvider', () => {
  it('uses the fixed persistent-worker argv and returns negotiated inspection results', async () => {
    const runtime = new ControlledRuntime('success')
    const provider = tracked(new PythonGeospatialProvider({
      runtime,
      pythonRoot: 'C:\georesearch\python',
      pythonExecutable: 'python.exe',
      environment: { GEORESEARCH_TEST: '1' },
    }))

    await expect(provider.ready()).resolves.toMatchObject({
      providerId: 'python-geospatial',
      protocol: 'georesearch-worker/1',
      libraries: { rasterio: '1.4.3', pyproj: '3.7.2' },
    })
    await expect(provider.inspect(request())).resolves.toMatchObject({
      assets: [{ format: 'GeoJSON' }],
      checks: [{ checkId: 'crs-present', status: 'passed' }],
    })

    expect(runtime.specs).toHaveLength(1)
    expect(runtime.specs[0]).toMatchObject({
      argv: ['python.exe', '-u', '-m', 'georesearch_worker'],
      cwd: 'C:\georesearch\python',
      graceMs: 2_000,
      stdio: { stdin: 'pipe', stdout: 'pipe' },
    })
    expect(runtime.specs[0]?.env).toMatchObject({
      GEORESEARCH_TEST: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONNOUSERSITE: '1',
      PYTHONPATH: 'C:\georesearch\python',
    })
  })

  it('propagates AbortSignal cancellation without waiting for the grace termination', async () => {
    const runtime = new ControlledRuntime('pending')
    const provider = tracked(new PythonGeospatialProvider({ runtime, pythonRoot: 'C:\python', graceMs: 100 }))
    const controller = new AbortController()
    const pending = provider.inspect({ ...request(), signal: controller.signal })
    await runtime.waitForRequest()
    controller.abort()

    await expect(pending).rejects.toMatchObject({ code: 'GEOSPATIAL_CANCELLED' })
    expect(runtime.handles[0]?.cancelIds).toHaveLength(1)
    expect(runtime.handles[0]?.terminateCalls).toBe(0)
  })

  it('rejects every in-flight request on worker crash and can start a replacement worker', async () => {
    const runtime = new ControlledRuntime('pending')
    const provider = tracked(new PythonGeospatialProvider({ runtime, pythonRoot: 'C:\python' }))
    const first = provider.inspect(request('artifact-1'))
    const second = provider.inspect(request('artifact-2'))
    await runtime.waitForRequestCount(2)
    runtime.handles[0]?.exit(1)

    await expect(first).rejects.toMatchObject({ code: 'GEOSPATIAL_WORKER_CRASHED' })
    await expect(second).rejects.toMatchObject({ code: 'GEOSPATIAL_WORKER_CRASHED' })
    runtime.mode = 'success'
    await expect(provider.inspect(request('artifact-3'))).resolves.toMatchObject({ checks: expect.any(Array) })
    expect(runtime.specs).toHaveLength(2)
  })

  it('drains accepted work, stops new admission, and disposes the worker exactly once', async () => {
    const runtime = new ControlledRuntime('pending')
    const provider = tracked(new PythonGeospatialProvider({ runtime, pythonRoot: 'C:\python' }))
    const pending = provider.inspect(request())
    await runtime.waitForRequest()
    const draining = provider.drain()
    await expect(provider.inspect(request('late-artifact'))).rejects.toThrow(/draining/)
    runtime.handles[0]?.respondSuccess()
    await pending
    await draining
    const first = provider.dispose()
    const second = provider.dispose()
    expect(second).toBe(first)
    await first
    expect(provider.state).toBe('DISPOSED')
    expect(runtime.handles[0]?.shutdowns).toBe(1)
  })

  it('disposes cleanly when Host subprocess teardown closes worker stdin first', async () => {
    const runtime = new ControlledRuntime('success')
    const provider = tracked(new PythonGeospatialProvider({ runtime, pythonRoot: 'C:\python' }))
    await provider.ready()

    runtime.handles[0]?.closeInputBeforeDone()

    await expect(provider.dispose()).resolves.toBeUndefined()
    expect(provider.state).toBe('DISPOSED')
  })
})

function tracked(provider: PythonGeospatialProvider): PythonGeospatialProvider {
  providers.push(provider)
  return provider
}

function request(artifactId = 'dataset-artifact'): ProviderInspectionRequest {
  return {
    assets: [{
      artifactId,
      digest: digestJson({ artifactId }),
      kind: 'geojson',
      mediaType: 'application/geo+json',
      path: `C:\workspace\${artifactId}.geojson`,
    }],
    splits: [],
    options: {
      machineLearning: false,
      classification: false,
      categoricalResampling: null,
      labelSchema: [],
      spatialStatistics: {
        blockingStrategy: 'spatial blocks',
        autocorrelation: 'Moran I',
        multipleComparison: 'Holm',
        effectSize: 'mean difference',
      },
    },
  }
}

class ControlledRuntime implements GeospatialSubprocessRuntime {
  readonly specs: SubprocessSpawnSpec[] = []
  readonly handles: ControlledHandle[] = []
  mode: 'success' | 'pending'

  constructor(mode: 'success' | 'pending') {
    this.mode = mode
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    this.specs.push(spec)
    const handle = new ControlledHandle(() => this.mode)
    this.handles.push(handle)
    return handle
  }

  async waitForRequest(): Promise<void> {
    await this.waitForRequestCount(1)
  }

  async waitForRequestCount(count: number): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (this.handles.reduce((sum, handle) => sum + handle.requestIds.length, 0) >= count) return
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    throw new Error(`timed out waiting for ${count} provider requests`)
  }
}

class ControlledHandle implements SubprocessHandle {
  readonly pid = 4242
  readonly stdout = new PassThrough()
  readonly stderr = undefined
  readonly collected = {}
  readonly stdin: Writable
  readonly requestIds: string[] = []
  readonly cancelIds: string[] = []
  terminateCalls = 0
  shutdowns = 0
  private inputClosed = false
  private exited = false
  private readonly pendingIds: string[] = []
  private resolveDone!: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
  readonly done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(resolve => {
    this.resolveDone = resolve
  })

  constructor(private readonly mode: () => 'success' | 'pending') {
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        if (this.inputClosed) {
          const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
          queueMicrotask(() => this.exit(1))
          callback(error)
          return
        }
        try {
          for (const line of String(chunk).split(/\r?\n/u).filter(Boolean)) this.onMessage(JSON.parse(line) as Record<string, unknown>)
          callback()
        } catch (error) {
          callback(error as Error)
        }
      },
    })
    queueMicrotask(() => this.emit({
      type: 'hello',
      protocol: 'georesearch-worker/1',
      workerVersion: '0.1.0',
      pythonVersion: '3.13.7',
      capabilities: {
        methods: ['inspect-dataset'],
        cancel: true,
        deadlines: true,
        libraries: { rasterio: '1.4.3', pyproj: '3.7.2' },
      },
      pid: this.pid,
    }))
  }

  terminate(): void {
    this.terminateCalls += 1
    this.exit(null, 'SIGTERM')
  }

  async waitForExit(): Promise<boolean> {
    await this.done
    return true
  }

  exit(exitCode: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return
    this.exited = true
    this.resolveDone({ exitCode, signal })
    this.stdout.end()
  }

  closeInputBeforeDone(): void {
    this.inputClosed = true
  }

  respondSuccess(): void {
    for (const id of this.pendingIds.splice(0)) this.emitSuccess(id)
  }

  private onMessage(message: Record<string, unknown>): void {
    if (message.type === 'shutdown') {
      this.shutdowns += 1
      this.exit(0)
      return
    }
    if (message.type === 'cancel' && typeof message.id === 'string') {
      this.cancelIds.push(message.id)
      const index = this.pendingIds.indexOf(message.id)
      if (index >= 0) this.pendingIds.splice(index, 1)
      this.emit({ id: message.id, error: 'CANCELLED' })
      return
    }
    if (message.method === 'inspect-dataset' && typeof message.id === 'string') {
      this.requestIds.push(message.id)
      if (this.mode() === 'success') this.emitSuccess(message.id)
      else this.pendingIds.push(message.id)
    }
  }

  private emitSuccess(id: string): void {
    this.emit({
      id,
      result: {
        assets: [{ format: 'GeoJSON' }],
        checks: [{ checkId: 'crs-present', status: 'passed' }],
      },
    })
  }

  private emit(value: unknown): void {
    this.stdout.write(`${JSON.stringify(value)}\n`)
  }
}
