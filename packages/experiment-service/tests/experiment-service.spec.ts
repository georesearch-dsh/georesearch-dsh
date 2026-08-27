import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  digestJson,
  digestPhase3Body,
  sha256Bytes,
  type DatasetManifest,
  type ExperimentSpecCandidate,
  type GeodataInspectionReport,
  type RepositoryAudit,
  type ResultEnvelope,
  type RunRecord,
  type SourceRecord,
} from '@georesearch/dsh-contracts'
import type { Agent, ToolExecution } from '@georesearch/dsh-compat-rc5'
import { projectPaths } from '@georesearch/dsh-project-provider-files'
import { ProjectCoordinator } from '@georesearch/dsh-project-service'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EXPERIMENT_SPEC_COMMIT_PARAMETERS,
  ExperimentCoordinator,
} from '../src/index.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('ExperimentCoordinator', () => {
  it('keeps the Coordinator commit schema compact while Host validation stays strict', async () => {
    expect(JSON.stringify(EXPERIMENT_SPEC_COMMIT_PARAMETERS).length).toBeLessThan(700)
    expect(EXPERIMENT_SPEC_COMMIT_PARAMETERS.properties.candidate).toMatchObject({
      type: 'object',
      description: expect.stringContaining('Pass it unchanged'),
    })

    const fixture = await experimentFixture()
    await expect(fixture.experiments.commitCandidate(
      execution(fixture.workspace, 'coordinator', 'invalid-compact-candidate'),
      { schemaVersion: 1 } as unknown as ExperimentSpecCandidate,
      fixture.generation,
    )).rejects.toMatchObject({ code: 'EXPERIMENT_SPEC_INVALID' })
  })

  it('freezes a validated protocol and atomically commits report, manifest, and spec', async () => {
    const fixture = await experimentFixture()
    const result = await fixture.experiments.commitCandidate(
      execution(fixture.workspace, 'coordinator', 'spec-commit'),
      fixture.candidate,
      fixture.generation,
    )

    expect(result.amendment).toBeNull()
    expect(result.experimentSpec).toMatchObject({
      status: 'frozen',
      revision: 1,
      sourceTreeDigest: fixture.audit.sourceTreeDigest,
      datasets: [{ datasetId: fixture.report.datasetId, role: 'training' }],
      seeds: [7],
    })
    const state = await fixture.projects.loadProject(fixture.projectId)
    expect(state.generation).toBe(fixture.generation + 1)
    expect(state.state.geodataReports?.[fixture.report.reportId]).toEqual(fixture.report)
    expect(state.state.datasetManifests?.[fixture.report.datasetId]).toEqual(result.datasetManifests[0])
    expect(state.state.experimentSpecs?.[result.experimentSpec.specId]).toEqual(result.experimentSpec)
    expect(fixture.verifyCalls).toBeGreaterThanOrEqual(1)
  })

  it('keeps candidate creation Experiment-only and formal commit Coordinator-only', async () => {
    const fixture = await experimentFixture()
    await expect(fixture.experiments.candidate(
      execution(fixture.workspace, 'experiment', 'candidate-ok'),
      fixture.candidate,
    )).resolves.toEqual(fixture.candidate)
    await expect(fixture.experiments.candidate(
      execution(fixture.workspace, 'coordinator', 'candidate-wrong-role'),
      fixture.candidate,
    )).rejects.toMatchObject({ code: 'GEORESEARCH_ROLE_MISMATCH' })
    await expect(fixture.experiments.commitCandidate(
      execution(fixture.workspace, 'experiment', 'commit-wrong-role'),
      fixture.candidate,
      fixture.generation,
    )).rejects.toMatchObject({ code: 'GEORESEARCH_ROLE_MISMATCH' })
  })

  it('commits metric values only from one succeeded formal-run stdout envelope', async () => {
    const fixture = await experimentFixture()
    const frozen = await fixture.experiments.commitCandidate(
      execution(fixture.workspace, 'coordinator', 'spec-for-result'),
      fixture.candidate,
      fixture.generation,
    )
    const run = await commitSucceededRun(fixture, frozen.experimentSpec.digest, frozen.datasetManifests[0]!.digest)
    const outputArtifact = fixture.report.assets[0]!.artifactRef
    const envelope = resultEnvelope(fixture.report.datasetId, [outputArtifact.artifactId])
    await writeResultLog(fixture.home, fixture.projectId, run, envelope)
    const current = await fixture.projects.loadProject(fixture.projectId)

    const results = await fixture.experiments.commitResults(
      execution(fixture.workspace, 'coordinator', 'result-commit'),
      current.generation,
      run.runId,
    )
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      resultId: 'result-macro-f1',
      value: 0.81,
      validationStatus: 'pending',
      experimentSpecDigest: frozen.experimentSpec.digest,
      runId: run.runId,
    })
    const state = await fixture.projects.loadProject(fixture.projectId)
    expect(state.state.results?.['result-macro-f1']).toEqual(results[0])
    expect(state.state.runs[run.runId]?.outputArtifactRefs).toEqual([outputArtifact])
    await expect(fixture.experiments.readResult(
      agent(fixture.workspace, 'reviewer'),
      'result-macro-f1',
    )).resolves.toEqual(results[0])
  })

  it('rejects multiple or partially invalid envelopes without committing any ResultRecord', async () => {
    const fixture = await experimentFixture()
    const frozen = await fixture.experiments.commitCandidate(
      execution(fixture.workspace, 'coordinator', 'spec-invalid-result'),
      fixture.candidate,
      fixture.generation,
    )
    const run = await commitSucceededRun(fixture, frozen.experimentSpec.digest, frozen.datasetManifests[0]!.digest)
    const valid = resultEnvelope(fixture.report.datasetId)
    const invalid: ResultEnvelope = {
      schemaVersion: 1,
      results: [
        valid.results[0]!,
        { ...valid.results[0]!, resultId: 'result-invalid', metricId: 'unregistered-metric' },
      ],
    }
    await writeResultLog(fixture.home, fixture.projectId, run, invalid)
    const before = await fixture.projects.loadProject(fixture.projectId)
    await expect(fixture.experiments.commitResults(
      execution(fixture.workspace, 'coordinator', 'invalid-result-commit'),
      before.generation,
      run.runId,
    )).rejects.toMatchObject({ code: 'RESULT_ENVELOPE_INVALID' })
    const after = await fixture.projects.loadProject(fixture.projectId)
    expect(after.generation).toBe(before.generation)
    expect(after.state.results ?? {}).toEqual({})

    await writeResultLog(fixture.home, fixture.projectId, run, valid, 2)
    await expect(fixture.experiments.commitResults(
      execution(fixture.workspace, 'coordinator', 'duplicate-envelope-commit'),
      after.generation,
      run.runId,
    )).rejects.toMatchObject({ code: 'RESULT_ENVELOPE_INVALID' })
  })

  it('rejects a formal result when stdout changed after the exit marker was written', async () => {
    const fixture = await experimentFixture()
    const frozen = await fixture.experiments.commitCandidate(
      execution(fixture.workspace, 'coordinator', 'spec-tampered-result'),
      fixture.candidate,
      fixture.generation,
    )
    const run = await commitSucceededRun(fixture, frozen.experimentSpec.digest, frozen.datasetManifests[0]!.digest)
    await writeResultLog(fixture.home, fixture.projectId, run, resultEnvelope(fixture.report.datasetId))
    const stdoutPath = join(projectPaths(fixture.home, fixture.projectId).root, run.stdoutPath)
    await writeFile(stdoutPath, `${await readFile(stdoutPath, 'utf8')}tampered\n`, 'utf8')
    const current = await fixture.projects.loadProject(fixture.projectId)

    await expect(fixture.experiments.commitResults(
      execution(fixture.workspace, 'coordinator', 'tampered-result-commit'),
      current.generation,
      run.runId,
    )).rejects.toMatchObject({ code: 'RESULT_ENVELOPE_INVALID' })
  })
})

async function experimentFixture() {
  const root = await mkdtemp(join(tmpdir(), 'georesearch-experiment-service-'))
  temporaryRoots.push(root)
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  await mkdir(workspace)
  const projects = new ProjectCoordinator({ home, now: fixedClock() })
  const coordinatorAgent = agent(workspace, 'coordinator')
  const resolved = await projects.resolveAgent(coordinatorAgent, { attachIfMissing: true })
  const projectId = resolved.stateFile.projectId
  const brief = await projects.commitResearchBrief(
    execution(workspace, 'coordinator', 'brief'),
    1,
    researchBriefBody(),
  )
  const uploaded = await projects.commitUploadedArtifact(coordinatorAgent, {
    attachmentId: '00000000-0000-4000-8000-000000000501',
    source: Readable.from(Buffer.from('phase5-raster-fixture')),
    maxBytes: 1024,
    mediaType: 'image/tiff',
  })
  const source = sourceRecord()
  await projects.commitSourceRecord(projectId, {
    expectedGeneration: 3,
    operationKey: digestJson({ operation: 'source' }),
    requestDigest: digestJson({ request: 'source' }),
    source,
  })
  const audit = repositoryAudit(projectId, resolved.binding.workspaceId, resolved.binding.bindingVersion, workspace, source)
  await projects.commitRepositoryAudit(projectId, {
    expectedGeneration: 4,
    operationKey: digestJson({ operation: 'audit' }),
    requestDigest: digestJson({ request: 'audit' }),
    repositoryAudit: audit,
  })
  const report = geodataReport(
    projectId,
    resolved.binding.workspaceId,
    resolved.binding.bindingVersion,
    uploaded.artifact,
  )
  let verifyCalls = 0
  const experiments = new ExperimentCoordinator({
    projects,
    geospatial: {
      async verifyReport(_agent, value) {
        verifyCalls += 1
        if (value.digest !== report.digest) throw new Error('unexpected report')
      },
      manifestFromReport(value, role) {
        return datasetManifest(value, role)
      },
    },
    host: {
      requireExperiment(value) { requireRole(value, 'experiment') },
      requireRootCoordinator(value) { requireRole(value, 'coordinator') },
      requireReviewer(value) { requireRole(value, 'reviewer') },
    },
  }, {
    home,
    now: fixedClock(),
  })
  const candidate = experimentCandidate(report, brief.brief.digest, audit.auditId)
  const state = await projects.loadProject(projectId)
  return {
    home,
    workspace,
    projects,
    projectId,
    resolved,
    report,
    audit,
    candidate,
    experiments,
    generation: state.generation,
    get verifyCalls() { return verifyCalls },
  }
}

async function commitSucceededRun(
  fixture: Awaited<ReturnType<typeof experimentFixture>>,
  experimentSpecDigest: `sha256:${string}`,
  datasetDigest: `sha256:${string}`,
): Promise<RunRecord> {
  const initialState = await fixture.projects.loadProject(fixture.projectId)
  const argv = ['python.exe', 'experiment.py', '--seed', '7']
  const starting: RunRecord = {
    schemaVersion: 1,
    runId: 'run-phase5',
    kind: 'formal',
    projectId: fixture.projectId,
    workspaceId: fixture.resolved.binding.workspaceId,
    workspaceBindingVersion: fixture.resolved.binding.bindingVersion,
    experimentSpecDigest,
    sourceTreeDigest: fixture.audit.sourceTreeDigest,
    environmentDigest: digestJson({ python: '3.13.7' }),
    datasetDigests: [datasetDigest],
    seed: 7,
    argv,
    argvDigest: digestJson(argv),
    cwd: {
      canonicalPath: fixture.resolved.workspace.canonicalPath,
      volumeIdentity: fixture.resolved.workspace.volumeIdentity,
      fileIdentity: fixture.resolved.workspace.directoryFileIdentity,
    },
    state: 'starting',
    launchId: 'launch-phase5',
    resourceLimits: { timeoutMs: 60_000, graceMs: 1_000, stdoutMaxBytes: 1_048_576, stderrMaxBytes: 1_048_576 },
    stdoutPath: 'runs/run-phase5/stdout.log',
    stderrPath: 'runs/run-phase5/stderr.log',
    sandbox: { mode: 'workspace-write', enforcement: 'partial' },
    approval: { outcome: 'allowed-once', callId: 'approval-phase5', approvedAt: '2026-08-18T02:00:00.000Z' },
    outputArtifactRefs: [],
  }
  await commitRun(fixture.projects, initialState.generation, starting, true, 'starting')
  const running: RunRecord = {
    ...starting,
    state: 'running',
    pid: 4242,
    processCreationTime: '2026-08-18T02:00:01.000Z',
    supervisorReceiptDigest: digestJson({ receipt: 1 }),
    startedAt: '2026-08-18T02:00:01.000Z',
  }
  await commitRun(fixture.projects, initialState.generation + 1, running, false, 'running')
  const collecting: RunRecord = {
    ...running,
    state: 'collecting',
    endedAt: '2026-08-18T02:00:02.000Z',
    exitCode: 0,
  }
  await commitRun(fixture.projects, initialState.generation + 2, collecting, false, 'collecting')
  const succeeded: RunRecord = { ...collecting, state: 'succeeded' }
  await commitRun(fixture.projects, initialState.generation + 3, succeeded, false, 'succeeded')
  return succeeded
}

async function commitRun(
  projects: ProjectCoordinator,
  expectedGeneration: number,
  run: RunRecord,
  initial: boolean,
  state: string,
): Promise<void> {
  await projects.commitRunRecord(run.projectId, {
    expectedGeneration,
    operationKey: digestJson({ operation: `run-${state}` }),
    requestDigest: digestJson({ request: `run-${state}` }),
    run,
    initial,
  })
}

async function writeResultLog(
  home: string,
  projectId: string,
  run: RunRecord,
  envelope: ResultEnvelope,
  repetitions = 1,
): Promise<void> {
  const path = join(projectPaths(home, projectId).root, run.stdoutPath)
  await mkdir(join(projectPaths(home, projectId).root, 'runs', run.runId), { recursive: true })
  const line = `GEORESEARCH_RESULT_V1 ${JSON.stringify(envelope)}`
  const stdout = `${Array.from({ length: repetitions }, () => line).join('\n')}\n`
  await writeFile(path, stdout, 'utf8')
  await writeFile(join(projectPaths(home, projectId).runs, run.runId, 'exit.json'), `${JSON.stringify({
    schemaVersion: 1,
    projectId,
    runId: run.runId,
    launchId: run.launchId,
    exitCode: run.exitCode ?? null,
    signal: null,
    endedAt: run.endedAt,
    stdoutDigest: sha256Bytes(Buffer.from(stdout, 'utf8')),
    stderrDigest: sha256Bytes(Buffer.alloc(0)),
  }, undefined, 2)}\n`, 'utf8')
  expect(await readFile(path, 'utf8')).toContain('GEORESEARCH_RESULT_V1')
}

function researchBriefBody() {
  return {
    schemaVersion: 1,
    briefId: 'brief-phase5',
    title: 'Spatial leakage experiment',
    researchQuestion: 'Does the candidate improve land-cover classification without spatial leakage?',
    background: 'Public remote-sensing benchmark.',
    motivation: 'Validate a geography-aware experiment protocol.',
    region: { description: 'Fixture region', bbox: [100, 20, 116, 36], crs: 'EPSG:4326' },
    timeRange: { start: '2025-01-01', end: '2025-12-31' },
    researchSubjects: ['land cover'],
    dataModalities: ['optical raster'],
    hypotheses: [{ hypothesisId: 'hypothesis-1', statement: 'The candidate improves macro F1.' }],
    expectedContributions: ['Leakage-safe evaluation'],
    constraints: ['CPU only'],
    knownAssumptions: ['Labels are current'],
    successCriteria: ['Every result is traceable'],
    userConfirmation: {
      confirmed: true,
      confirmedAt: '2026-08-18T00:00:00.000Z',
      confirmedBy: 'user',
      auditNote: 'Approved fixture.',
    },
  }
}

function sourceRecord(): SourceRecord {
  const body = {
    schemaVersion: 1 as const,
    sourceId: 'source-phase5',
    title: 'Public land-cover benchmark',
    authors: [{ name: 'A. Researcher', orcid: null }],
    year: 2025,
    venue: 'Fixture Journal',
    stableIdentifier: { kind: 'doi' as const, value: '10.1234/phase5.fixture' },
    sourceType: 'journal-article',
    versionRelation: { kind: 'none' as const, relatedIdentifier: null },
    retrievedAt: '2026-08-18T00:00:00.000Z',
    providerTrace: {
      providerId: 'fixture', providerVersion: '1.0.0', retrievedAt: '2026-08-18T00:00:00.000Z',
      credentialRef: null, credentialBindingEpoch: 0, requestId: null,
    },
    codeRefs: [{ url: 'https://github.com/example/land-cover.git', label: 'official' }],
    dataRefs: [{ url: 'https://example.test/land-cover.tif', label: 'dataset' }],
    status: 'resolved' as const,
    searchChain: { chainId: 'chain-phase5', generation: 1, providerItemId: 'phase5-fixture' },
  }
  return { ...body, digest: digestPhase3Body(body) }
}

function repositoryAudit(
  projectId: string,
  workspaceId: string,
  bindingVersion: number,
  workspace: string,
  source: SourceRecord,
): RepositoryAudit {
  const body = {
    schemaVersion: 1 as const,
    auditId: 'audit-phase5',
    projectId,
    workspaceId,
    workspaceBindingVersion: bindingVersion,
    sourceId: source.sourceId,
    sourceDigest: source.digest,
    repository: {
      capability: {
        providerId: 'git-cli' as const, providerVersion: '1.0.0', shell: false as const,
        readOnlyCommands: true as const, maxFiles: 20_000, maxChanges: 2_000, maxHashedBytes: 268_435_456,
      },
      canonicalRoot: workspace,
      gitDir: join(workspace, '.git'),
      gitCommonDir: join(workspace, '.git'),
      remoteUrl: source.codeRefs[0]?.url ?? null,
      headCommit: 'a'.repeat(40),
      branch: 'main',
      detached: false,
      tags: [],
      targetRef: 'HEAD',
      targetCommit: 'a'.repeat(40),
      targetMatchesHead: true,
      dirty: false,
      changes: [],
    },
    sourceTreeDigest: digestJson({ sourceTree: 'phase5' }),
    languages: [{ language: 'Python', fileCount: 2 }],
    buildSystems: [{ name: 'Python packaging', manifestPaths: ['pyproject.toml'] }],
    entryPoints: ['experiment.py'],
    configurationFiles: ['config.yml'],
    dataDependencyPaths: ['data'],
    environmentFiles: ['pyproject.toml'],
    testPaths: ['tests'],
    methodCodeDeltas: [],
    blockers: [],
    auditedAt: '2026-08-18T00:00:01.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

function geodataReport(
  projectId: string,
  workspaceId: string,
  bindingVersion: number,
  artifact: { readonly artifactId: string; readonly digest: `sha256:${string}`; readonly kind: string },
): GeodataInspectionReport {
  const artifactRef = {
    artifactId: artifact.artifactId,
    digest: artifact.digest,
    kind: artifact.kind,
  }
  const body = {
    schemaVersion: 1 as const,
    reportId: 'geodata-phase5',
    projectId,
    workspaceId,
    workspaceBindingVersion: bindingVersion,
    datasetId: 'dataset-phase5',
    datasetName: 'Public land-cover fixture',
    datasetVersion: '1.0.0',
    source: { uri: 'https://example.test/land-cover.tif', provider: 'public-fixture', accessedAt: '2026-08-18T00:00:02.000Z' },
    actions: ['raster-metadata', 'crs', 'extent', 'alignment', 'nodata', 'band-schema', 'label-schema', 'split-summary'] as const,
    provider: {
      providerId: 'python-geospatial' as const, providerVersion: '0.1.0', protocol: 'georesearch-worker/1' as const,
      shell: false as const, persistentWorker: true as const, cancel: true as const, deadlines: true as const,
      methods: ['inspect-dataset'] as const, libraries: { rasterio: '1.4.3', pyproj: '3.7.2' },
    },
    assets: [{
      artifactRef,
      format: 'GTiff', width: 16, height: 16, featureCount: null,
      spatialExtent: [100, 20, 116, 36] as const,
      crs: { authority: 'EPSG:32650', wktDigest: digestJson({ wkt: 32650 }), axisOrder: ['E', 'N'], units: ['metre'] },
      resolution: [1, 1] as const,
      transform: [1, 0, 100, 0, -1, 36] as const,
      bands: [{ index: 1, name: 'class', dataType: 'uint8', unit: null, scale: 1, offset: 0, noData: 255, colorInterpretation: 'gray' }],
      fields: [],
    }],
    splits: [{
      splitId: 'train', role: 'train' as const, sampleIds: ['sample-1'], spatialUnitIds: ['tile-1'],
      sourceAssetDigests: [artifactRef.digest], temporalKeys: ['2025-01-01'],
    }, {
      splitId: 'test', role: 'test' as const, sampleIds: ['sample-2'], spatialUnitIds: ['tile-2'],
      sourceAssetDigests: [artifactRef.digest], temporalKeys: ['2025-02-01'],
    }],
    qualityMasks: ['cloud'],
    preprocessingLevel: 'surface-reflectance',
    labelSchema: [{ value: '1', label: 'forest' }],
    knownLimitations: [],
    checks: [{
      checkId: 'spatial-leakage', domain: 'geospatial-ml' as const, mandatory: true, status: 'passed' as const,
      code: 'SPATIAL_LEAKAGE_CLEAR', message: 'No spatial overlap.', relatedArtifactIds: [artifactRef.artifactId],
    }],
    overall: 'passed' as const,
    inspectedAt: '2026-08-18T00:00:02.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

function datasetManifest(
  report: GeodataInspectionReport,
  role: 'training' | 'validation' | 'testing' | 'covariate' | 'labels' = 'training',
): DatasetManifest {
  const asset = report.assets[0]!
  const body = {
    schemaVersion: 1 as const,
    datasetId: report.datasetId,
    name: report.datasetName,
    version: report.datasetVersion,
    projectId: report.projectId,
    workspaceId: report.workspaceId,
    workspaceBindingVersion: report.workspaceBindingVersion,
    source: report.source,
    assetRefs: report.assets.map(item => item.artifactRef),
    assetDigests: report.assets.map(item => item.artifactRef.digest),
    spatialExtent: asset.spatialExtent,
    timeRange: { start: null, end: null },
    crs: asset.crs,
    resolution: asset.resolution,
    bands: asset.bands,
    fields: asset.fields,
    qualityMasks: report.qualityMasks,
    preprocessingLevel: report.preprocessingLevel,
    labelSchema: report.labelSchema,
    splits: report.splits,
    knownLimitations: role === 'training' ? report.knownLimitations : [...report.knownLimitations, `Experiment dataset role: ${role}`],
    inspectionReportDigest: report.digest,
    status: report.overall === 'passed' ? 'verified' as const : 'blocked' as const,
    createdAt: '2026-08-18T00:00:03.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

function experimentCandidate(
  report: GeodataInspectionReport,
  researchBriefDigest: `sha256:${string}`,
  repositoryAuditId: string,
): ExperimentSpecCandidate {
  return {
    schemaVersion: 1,
    kind: 'experiment-spec',
    specId: 'spec-phase5-v1',
    experimentId: 'experiment-phase5',
    revision: 1,
    researchBriefDigest,
    hypothesisIds: ['hypothesis-1'],
    repositoryAuditId,
    datasetReports: [report],
    datasetRoles: [{ datasetId: report.datasetId, role: 'training' }],
    baselines: [{
      baselineId: 'baseline-1', description: 'Published baseline', implementationRef: 'baseline.py',
      preprocessingPolicy: 'shared', trainingBudget: '10 epochs', postprocessingPolicy: 'none',
    }],
    independentVariables: [{ name: 'model', values: ['baseline', 'candidate'] }],
    controlVariables: [{ name: 'split', value: 'fixed' }],
    splitStrategy: 'spatial blocks',
    preprocessing: [{ stepId: 'normalize', description: 'Normalize imagery.', appliesTo: [report.datasetId], parameters: { method: 'z-score' } }],
    metrics: [{ metricId: 'macro-f1', name: 'Macro F1', unit: 'score', direction: 'maximize', aggregation: 'macro', implementationRef: 'metrics.py' }],
    seeds: [7],
    ablations: [],
    statisticalPlan: {
      method: 'paired spatial bootstrap', confidenceLevel: 0.95, effectSize: 'mean difference',
      multipleComparison: 'Holm', spatialAutocorrelation: 'Moran I', blockingStrategy: 'spatial blocks',
    },
    stoppingRule: 'complete every seed',
    resourceRequirements: ['CPU'],
    acceptanceCriteria: ['Emit the registered metric envelope'],
    amendment: null,
  }
}

function resultEnvelope(datasetId: string, artifactIds: readonly string[] = []): ResultEnvelope {
  return {
    schemaVersion: 1,
    results: [{
      resultId: 'result-macro-f1',
      metricId: 'macro-f1',
      value: 0.81,
      unit: 'score',
      aggregation: 'macro',
      uncertainty: { kind: 'none', level: null, lower: null, upper: null },
      comparisonTarget: 'baseline-1',
      scope: { datasetId, region: 'fixture-region', sensor: 'synthetic', split: 'test' },
      artifactIds,
    }],
  }
}

function fixedClock(): () => string {
  let tick = 0
  return () => new Date(Date.UTC(2026, 7, 18, 0, 0, tick++)).toISOString()
}

function requireRole(value: Agent, expected: 'coordinator' | 'experiment' | 'reviewer'): void {
  if (String(value.id) !== expected) {
    const error = new Error(`${expected} required`) as Error & { code: string }
    error.code = 'GEORESEARCH_ROLE_MISMATCH'
    throw error
  }
}

function agent(workspace: string, role: 'coordinator' | 'experiment' | 'reviewer'): Agent {
  return {
    id: role,
    session: { id: `session-${role}`, header: { cwd: workspace } },
  } as unknown as Agent
}

function execution(
  workspace: string,
  role: 'coordinator' | 'experiment' | 'reviewer',
  callId: string,
): ToolExecution {
  return {
    agent: agent(workspace, role),
    rootCallId: `root-${callId}`,
    callId,
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}
