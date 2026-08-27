import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { digestJson } from '@georesearch/dsh-contracts'
import { afterEach, describe, expect, it } from 'vitest'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Python geospatial worker', () => {
  it('reads an extensionless Artifact Store GeoTIFF by its registered media type', async () => {
    const root = await mkdtemp(join(tmpdir(), 'georesearch-python-extensionless-'))
    temporaryRoots.push(root)
    const objectPath = join(root, '0123456789abcdef')
    const pythonRoot = resolve(import.meta.dirname, '..', 'python')
    const source = [
      'import json, sys',
      'from pathlib import Path',
      'import numpy as np',
      'import rasterio',
      'from rasterio.transform import from_origin',
      'from georesearch_worker.worker import _inspect_asset',
      'path = Path(sys.argv[1])',
      "with rasterio.open(path, 'w', driver='GTiff', width=2, height=2, count=1, dtype='uint8', crs='EPSG:4326', transform=from_origin(100, 20, 1, 1), nodata=0) as dataset:",
      "    dataset.write(np.array([[[1, 2], [3, 4]]], dtype='uint8'))",
      "print(json.dumps(_inspect_asset({'artifactId': 'artifact-extensionless', 'digest': 'sha256:' + '1' * 64, 'kind': 'uploaded-file', 'mediaType': 'image/tiff', 'path': str(path)})))",
    ].join('\n')
    const result = spawnSync(process.env.PYTHON?.trim() || 'python', ['-c', source, objectPath], {
      cwd: pythonRoot,
      env: { ...process.env, PYTHONPATH: pythonRoot },
      encoding: 'utf8',
      shell: false,
      windowsHide: true,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      format: 'GTiff',
      width: 2,
      height: 2,
      crs: { authority: 'EPSG:4326' },
      bands: [{ noData: 0 }],
    })
  })

  it('reads RFC 7946 GeoJSON and detects a preset spatial split leak', async () => {
    const root = await mkdtemp(join(tmpdir(), 'georesearch-python-geodata-'))
    temporaryRoots.push(root)
    const datasetPath = join(root, 'public-fixture.geojson')
    await writeFile(datasetPath, JSON.stringify({
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        properties: { class_id: 1, label: 'forest' },
        geometry: {
          type: 'Polygon',
          coordinates: [[[100, 20], [101, 20], [101, 21], [100, 21], [100, 20]]],
        },
      }],
    }), 'utf8')
    const pythonRoot = resolve(import.meta.dirname, '..', 'python')
    const child = spawn(process.env.PYTHON?.trim() || 'python', ['-u', '-m', 'georesearch_worker'], {
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
        new Promise(resolve => waiters.push(resolve)),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`worker timed out: ${stderr}`)), 10_000)),
      ])
    }

    try {
      const hello = await nextLine()
      expect(hello).toMatchObject({
        type: 'hello',
        protocol: 'georesearch-worker/1',
        capabilities: { methods: expect.arrayContaining(['inspect-dataset']) },
      })
      const artifactDigest = digestJson({ fixture: 'public-geojson' })
      child.stdin.write(`${JSON.stringify({
        id: 'geodata-public-case',
        method: 'inspect-dataset',
        deadline: new Date(Date.now() + 30_000).toISOString(),
        params: {
          assets: [{
            artifactId: 'public-geojson',
            digest: artifactDigest,
            kind: 'geojson',
            path: datasetPath,
          }],
          splits: [{
            splitId: 'train',
            role: 'train',
            sampleIds: ['feature-1'],
            spatialUnitIds: ['tile-shared'],
            sourceAssetDigests: [artifactDigest],
            temporalKeys: ['2025-01-01'],
          }, {
            splitId: 'test',
            role: 'test',
            sampleIds: ['feature-2'],
            spatialUnitIds: ['tile-shared'],
            sourceAssetDigests: [artifactDigest],
            temporalKeys: ['2025-02-01'],
          }],
          options: {
            machineLearning: true,
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
        },
      })}\n`)
      const response = await nextLine()
      expect(response.id).toBe('geodata-public-case')
      expect(response.error).toBeUndefined()
      expect(response.result.assets[0]).toMatchObject({
        format: 'GeoJSON',
        featureCount: 1,
        spatialExtent: [100, 20, 101, 21],
        crs: { authority: 'OGC:CRS84' },
      })
      const checks = new Map(response.result.checks.map((check: any) => [check.checkId, check]))
      expect(checks.get('crs-present')).toMatchObject({ status: 'passed' })
      expect(checks.get('spatial-leakage')).toMatchObject({
        mandatory: true,
        status: 'failed',
        code: 'SPATIAL_LEAKAGE_DETECTED',
      })
      expect(checks.get('temporal-leakage')).toMatchObject({ status: 'passed' })
    } finally {
      child.stdin.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
      child.stdin.end()
      const exitCode = await new Promise<number | null>(resolveExit => child.once('close', resolveExit))
      expect(exitCode, stderr).toBe(0)
      lines.close()
    }
  }, 20_000)
})
