import { describe, expect, it } from 'vitest'
import { digestJson, GEODATA_ACTIONS, type GeodataCheck } from '@georesearch/dsh-contracts'
import type { Agent, ToolExecution } from '@georesearch/dsh-compat-rc5'
import {
  GeospatialCoordinator,
  type GeodataInspectionRequest,
  type GeospatialCoordinatorPorts,
} from '../src/index.js'

describe('GeospatialCoordinator', () => {
  it('builds a strict report and verified DatasetManifest from current Artifacts', async () => {
    const fixture = geospatialFixture()
    const report = await fixture.coordinator.inspect(execution(), inspectionRequest())

    expect(report.projectId).toBe('project-phase5')
    expect(report.workspaceId).toBe('workspace-phase5')
    expect(report.actions).toEqual([...GEODATA_ACTIONS].sort())
    expect(report.overall).toBe('passed')
    expect(report.assets[0]?.artifactRef).toEqual(fixture.artifact)
    expect(fixture.hostCalls).toBe(1)

    const manifest = fixture.coordinator.manifestFromReport(report, 'testing')
    expect(manifest).toMatchObject({
      datasetId: report.datasetId,
      assetRefs: [fixture.artifact],
      assetDigests: [fixture.artifact.digest],
      spatialExtent: [100, 20, 116, 36],
      status: 'verified',
      inspectionReportDigest: report.digest,
    })
    expect(manifest.knownLimitations).toContain('Experiment dataset role: testing')
  })

  it('derives failed and blocked overall states only from mandatory checks', async () => {
    const failed = geospatialFixture([
      check('optional-note', false, 'failed'),
      check('alignment', true, 'failed'),
    ])
    await expect(failed.coordinator.inspect(execution(), inspectionRequest()))
      .resolves.toMatchObject({ overall: 'failed' })

    const blocked = geospatialFixture([
      check('alignment', true, 'failed'),
      check('validator-missing', true, 'blocked'),
    ])
    const report = await blocked.coordinator.inspect(execution(), inspectionRequest())
    expect(report.overall).toBe('blocked')
    expect(blocked.coordinator.manifestFromReport(report).status).toBe('blocked')
  })

  it('rejects cross-binding Artifacts before invoking the Python provider', async () => {
    const fixture = geospatialFixture()
    fixture.artifactWorkspaceId = 'other-workspace'
    await expect(fixture.coordinator.inspect(execution(), inspectionRequest()))
      .rejects.toMatchObject({ code: 'GEODATA_INVALID' })
    expect(fixture.providerCalls).toBe(0)
  })

  it('revalidates report content and rejects changed geodata before protocol freeze', async () => {
    const fixture = geospatialFixture()
    const report = await fixture.coordinator.inspect(execution(), inspectionRequest())
    await expect(fixture.coordinator.verifyReport(agent(), report)).resolves.toBeUndefined()

    fixture.checks = [check('crs-present', true, 'failed')]
    await expect(fixture.coordinator.verifyReport(agent(), report))
      .rejects.toMatchObject({ code: 'GEODATA_INVALID' })
  })

  it('allows Host revalidation for a Coordinator without exposing the inspect tool', async () => {
    const fixture = geospatialFixture()
    const report = await fixture.coordinator.inspect(execution(), inspectionRequest())

    await expect(fixture.coordinator.verifyReport(agent('coordinator'), report)).resolves.toBeUndefined()
    await expect(fixture.coordinator.inspect(execution('coordinator'), inspectionRequest()))
      .rejects.toThrow('Experiment role required')
  })
})

function geospatialFixture(initialChecks: readonly GeodataCheck[] = [check('crs-present', true, 'passed')]) {
  const artifact = {
    artifactId: 'artifact-raster',
    digest: digestJson({ raster: 1 }),
    kind: 'geotiff',
  }
  const state = {
    providerCalls: 0,
    hostCalls: 0,
    artifactWorkspaceId: 'workspace-phase5',
    checks: [...initialChecks],
  }
  const ports: GeospatialCoordinatorPorts = {
    projects: {
      async resolveAgent() {
        return {
          stateFile: { projectId: 'project-phase5' },
          binding: { workspaceId: 'workspace-phase5', bindingVersion: 3 },
        } as never
      },
      async resolveArtifactFile() {
        return {
          projectId: 'project-phase5',
          workspaceId: state.artifactWorkspaceId,
          artifact,
          path: 'C:\workspace\dataset.tif',
        } as never
      },
    },
    provider: {
      capability: {
        providerId: 'python-geospatial',
        providerVersion: '0.1.0',
        protocol: 'georesearch-worker/1',
        shell: false,
        persistentWorker: true,
        cancel: true,
        deadlines: true,
        methods: ['inspect-dataset'],
        libraries: { rasterio: '1.4.3', pyproj: '3.7.2' },
      },
      async inspect(request) {
        state.providerCalls += 1
        return {
          assets: request.assets.map(item => ({
            artifactRef: { artifactId: item.artifactId, digest: item.digest, kind: item.kind },
            format: 'GTiff',
            width: 16,
            height: 16,
            featureCount: null,
            spatialExtent: [100, 20, 116, 36] as const,
            crs: { authority: 'EPSG:32650', wktDigest: digestJson({ wkt: 32650 }), axisOrder: ['E', 'N'], units: ['metre'] },
            resolution: [1, 1] as const,
            transform: [1, 0, 100, 0, -1, 36] as const,
            bands: [{ index: 1, name: 'class', dataType: 'uint8', unit: null, scale: 1, offset: 0, noData: 255, colorInterpretation: 'gray' }],
            fields: [],
          })),
          checks: state.checks,
        }
      },
    },
    host: {
      requireExperiment(value) {
        state.hostCalls += 1
        if (String(value.id) !== 'experiment') throw new Error('Experiment role required')
      },
    },
  }
  const coordinator = new GeospatialCoordinator(ports, () => '2026-08-18T01:00:00.000Z')
  return {
    coordinator,
    artifact,
    get providerCalls() { return state.providerCalls },
    get hostCalls() { return state.hostCalls },
    get artifactWorkspaceId() { return state.artifactWorkspaceId },
    set artifactWorkspaceId(value: string) { state.artifactWorkspaceId = value },
    get checks() { return state.checks },
    set checks(value: readonly GeodataCheck[]) { state.checks = [...value] },
  }
}

function inspectionRequest(): GeodataInspectionRequest {
  return {
    datasetId: 'dataset-phase5',
    datasetName: 'Land cover',
    datasetVersion: '1.0.0',
    sourceUri: 'https://example.test/land-cover.tif',
    sourceProvider: 'public-fixture',
    artifactIds: ['artifact-raster'],
    actions: ['crs'],
    splits: [{
      splitId: 'train', role: 'train', sampleIds: ['sample-1'], spatialUnitIds: ['tile-1'],
      sourceAssetDigests: [digestJson({ raster: 1 })], temporalKeys: ['2025-01-01'],
    }],
    qualityMasks: ['cloud'],
    preprocessingLevel: 'surface-reflectance',
    labelSchema: [{ value: '1', label: 'forest' }],
    knownLimitations: [],
    machineLearning: false,
    classification: true,
    categoricalResampling: 'nearest',
    spatialStatistics: {
      blockingStrategy: 'spatial blocks',
      autocorrelation: 'Moran I',
      multipleComparison: 'Holm',
      effectSize: 'mean difference',
    },
  }
}

function check(checkId: string, mandatory: boolean, status: GeodataCheck['status']): GeodataCheck {
  return {
    checkId,
    domain: 'common-gis',
    mandatory,
    status,
    code: `${checkId.toUpperCase()}_${status.toUpperCase()}`,
    message: `${checkId} is ${status}.`,
    relatedArtifactIds: ['artifact-raster'],
  }
}

function agent(role = 'experiment'): Agent {
  return { id: role, session: { id: `session-${role}` } } as unknown as Agent
}

function execution(role = 'experiment'): ToolExecution {
  return {
    agent: agent(role),
    rootCallId: 'root-call',
    callId: 'call',
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}
