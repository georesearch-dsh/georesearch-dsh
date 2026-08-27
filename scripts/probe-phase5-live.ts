import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { digestJson, nowUtc } from '@georesearch/dsh-contracts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceUrl = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_admin_0_countries.geojson'
const reportPath = resolve(root, 'dist', 'reports', 'phase5-live-activation.json')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'georesearch-phase5-live-'))
const datasetPath = join(temporaryRoot, 'ne_110m_admin_0_countries.geojson')
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 60_000)
let child: ReturnType<typeof spawn> | undefined

try {
  const response = await fetch(sourceUrl, { signal: controller.signal })
  if (!response.ok) throw new Error(`Natural Earth download failed: HTTP ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length < 10_000 || bytes.length > 20 * 1024 * 1024) {
    throw new Error(`Natural Earth fixture size is outside the accepted range: ${bytes.length}`)
  }
  await writeFile(datasetPath, bytes)
  const parsed = JSON.parse(await readFile(datasetPath, 'utf8')) as {
    readonly type?: unknown
    readonly features?: unknown[]
  }
  if (parsed.type !== 'FeatureCollection' || !Array.isArray(parsed.features) || parsed.features.length < 100) {
    throw new Error('Natural Earth fixture is not the expected public country FeatureCollection')
  }

  const pythonRoot = resolve(root, 'python')
  child = spawn(process.env.PYTHON?.trim() || 'python', ['-u', '-m', 'georesearch_worker'], {
    cwd: pythonRoot,
    env: { ...process.env, PYTHONPATH: pythonRoot },
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const lines = createInterface({ input: child.stdout })
  const queue: unknown[] = []
  const waiters: Array<(value: unknown) => void> = []
  lines.on('line', line => {
    const value = JSON.parse(line) as unknown
    const waiter = waiters.shift()
    if (waiter === undefined) queue.push(value)
    else waiter(value)
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  const nextLine = async (): Promise<any> => {
    if (queue.length > 0) return queue.shift()
    return await Promise.race([
      new Promise(resolveLine => waiters.push(resolveLine)),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error(`Phase 5 worker timed out: ${stderr}`)),
        30_000,
      )),
    ])
  }

  const hello = await nextLine()
  if (hello?.protocol !== 'georesearch-worker/1'
    || hello?.capabilities?.libraries?.rasterio == null
    || hello?.capabilities?.libraries?.pyproj == null) {
    throw new Error('Python geospatial worker did not negotiate mandatory libraries')
  }
  const artifactDigest = digestJson({ sourceUrl, bytes: bytes.length, content: bytes.toString('base64') })
  child.stdin.write(`${JSON.stringify({
    id: 'phase5-natural-earth-leakage',
    method: 'inspect-dataset',
    deadline: new Date(Date.now() + 30_000).toISOString(),
    params: {
      assets: [{
        artifactId: 'natural-earth-countries',
        digest: artifactDigest,
        kind: 'geojson',
        path: datasetPath,
      }],
      splits: [{
        splitId: 'train', role: 'train', sampleIds: ['country-train'],
        spatialUnitIds: ['natural-earth-shared-tile'], sourceAssetDigests: [artifactDigest],
        temporalKeys: ['2026-train'],
      }, {
        splitId: 'test', role: 'test', sampleIds: ['country-test'],
        spatialUnitIds: ['natural-earth-shared-tile'], sourceAssetDigests: [artifactDigest],
        temporalKeys: ['2026-test'],
      }],
      options: {
        machineLearning: true,
        classification: false,
        categoricalResampling: null,
        labelSchema: [],
        spatialStatistics: {
          blockingStrategy: 'country polygons',
          autocorrelation: 'Moran I',
          multipleComparison: 'Holm',
          effectSize: 'mean difference',
        },
      },
    },
  })}\n`)
  const inspection = await nextLine()
  if (inspection?.id !== 'phase5-natural-earth-leakage' || inspection?.error !== undefined) {
    throw new Error(`Natural Earth inspection failed: ${JSON.stringify(inspection?.error)}`)
  }
  const asset = inspection.result?.assets?.[0]
  const checks = new Map<string, any>(
    (inspection.result?.checks ?? []).map((check: any) => [String(check.checkId), check]),
  )
  if (asset?.format !== 'GeoJSON'
    || asset?.featureCount !== parsed.features.length
    || asset?.crs?.authority !== 'OGC:CRS84'
    || checks.get('crs-present')?.status !== 'passed'
    || checks.get('spatial-leakage')?.status !== 'failed'
    || checks.get('spatial-leakage')?.code !== 'SPATIAL_LEAKAGE_DETECTED'
    || checks.get('temporal-leakage')?.status !== 'passed') {
    throw new Error('Natural Earth live case did not detect the preset geographic error')
  }

  await atomicWriteJson(reportPath, {
    schemaVersion: 1,
    phase: 'phase5-public-geospatial-case',
    checkedAt: nowUtc(),
    source: {
      name: 'Natural Earth 1:110m Admin 0 Countries',
      url: sourceUrl,
      bytes: bytes.length,
      digest: artifactDigest,
      featureCount: parsed.features.length,
    },
    provider: hello.capabilities,
    finding: checks.get('spatial-leakage'),
    checks: {
      publicDatasetRead: true,
      rfc7946CrsRecognized: true,
      presetSpatialLeakageDetected: true,
      temporalSplitClear: true,
      telemetryDisabled: process.env.DSH_TELEMETRY_DISABLED !== '0',
    },
  })
  process.stdout.write(`${JSON.stringify({ reportPath, featureCount: parsed.features.length }, undefined, 2)}\n`)
} finally {
  clearTimeout(timeout)
  if (child !== undefined && child.exitCode === null) {
    child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
    child.stdin.end()
    await Promise.race([
      new Promise<void>(resolveExit => child!.once('close', () => resolveExit())),
      new Promise<void>(resolveWait => setTimeout(resolveWait, 5_000)),
    ])
    if (child.exitCode === null) child.kill('SIGKILL')
  }
  await rm(temporaryRoot, { recursive: true, force: true })
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  await rename(temporary, path)
}
