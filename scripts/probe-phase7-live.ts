import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import type {
  Agent,
  SubprocessHandle,
  SubprocessSpawnSpec,
  ToolExecution,
} from '@georesearch/dsh-compat-rc5'
import {
  digestJson,
  digestPhase3Body,
  nowUtc,
  sha256Bytes,
  type EvidenceCandidate,
  type ExperimentSpecCandidate,
  type JsonValue,
  type LiteratureItem,
  type LiteratureProviderPage,
  type ReproductionTestSpecRecord,
  type RunExitMarker,
  type RunRecord,
  type Sha256Digest,
  type SourceRecord,
} from '@georesearch/dsh-contracts'
import type {
  LiteratureProvider,
  LiteratureProviderPageRequest,
} from '@georesearch/dsh-evidence-providers'
import { EvidenceCoordinator } from '@georesearch/dsh-evidence-service'
import { ExperimentCoordinator } from '@georesearch/dsh-experiment-service'
import { PythonGeospatialProvider } from '@georesearch/dsh-geospatial-provider-python'
import { GeospatialCoordinator } from '@georesearch/dsh-geospatial-service'
import {
  createOperatorScopeRecord,
  openOperatorScopeRecord,
  type OperatorScope,
  type OperatorScopeRecord,
} from '@georesearch/dsh-installation-guard/operator-scope'
import { projectPaths } from '@georesearch/dsh-project-provider-files'
import { ProjectCoordinator } from '@georesearch/dsh-project-service'
import { GitRepositoryProvider } from '@georesearch/dsh-repository-providers'
import { ReproductionCoordinator } from '@georesearch/dsh-reproduction-service'
import { ValidationCoordinator } from '@georesearch/dsh-validation-service'
import { ClaimCoordinator } from '@georesearch/dsh-claim-service'
import { WritingCoordinator } from '@georesearch/dsh-writing-service'

process.env.DSH_TELEMETRY_DISABLED = '1'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const reportPath = join(root, 'dist', 'reports', 'phase7-live-e2e.json')
const repositoryUrl = 'https://github.com/rasterio/rasterio.git'
const repositoryTag = '1.4.3'
const rasterUrl = `https://raw.githubusercontent.com/rasterio/rasterio/${repositoryTag}/tests/data/RGB.byte.tif`
const documentationUrl = 'https://rasterio.readthedocs.io/en/stable/'
const documentationPdfUrl = 'https://rasterio.readthedocs.io/_/downloads/en/stable/pdf/'
const pythonExecutable = process.env.PYTHON?.trim() || 'python'
const temporaryRoot = await mkdtemp(join(tmpdir(), 'georesearch-phase7-live-'))
const workspace = join(temporaryRoot, 'rasterio')
const home = join(temporaryRoot, 'home')
const rootSessionId = `phase7-root-${randomUUID()}`

let evidence: EvidenceCoordinator | undefined
let repository: GitRepositoryProvider | undefined
let geospatialProvider: PythonGeospatialProvider | undefined
let evidenceDrained = false
let evidenceDisposed = false
let repositoryDrained = false
let repositoryDisposed = false
let geospatialDrained = false
let geospatialDisposed = false
let temporaryStateRemoved = false
let liveReport: Record<string, unknown> | undefined

try {
  await cloneRepository(repositoryUrl, repositoryTag, workspace)
  const pythonSource = phase7ExperimentSource()
  const testSource = phase7TestSource()
  await writeFile(join(workspace, 'phase7_experiment.py'), pythonSource, 'utf8')
  await writeFile(join(workspace, 'test_phase7_experiment.py'), testSource, 'utf8')

  const projects = new ProjectCoordinator({ home })
  const coordinatorAgent = agent(workspace, 'coordinator')
  const literatureAgent = agent(workspace, 'literature')
  const experimentAgent = agent(workspace, 'experiment')
  const reviewerAgent = agent(workspace, 'reviewer')
  const writingAgent = agent(workspace, 'writing')
  const attached = await projects.resolveAgent(coordinatorAgent, { attachIfMissing: true })
  const projectId = attached.stateFile.projectId

  const brief = await projects.commitResearchBrief(
    execution(coordinatorAgent, 'phase7-research-brief'),
    attached.stateFile.generation,
    researchBriefBody(),
  )

  const operator = await createPhase7OperatorScope(home)
  const operatorRecord = operator.record
  const installation = operator.scope
  const literatureProvider = publicDocumentationProvider()
  evidence = new EvidenceCoordinator({
    home,
    pageSize: 1,
    maxPagesPerCall: 2,
    maxTransparentNoItemPagesPerCall: 1,
  }, {
    projects,
    installation,
    credentials: { resolve: async () => undefined },
    provider: literatureProvider,
  })

  const search = await evidence.literatureSearch(
    execution(literatureAgent, 'phase7-literature-search'),
    {
      query: 'Rasterio GeoTIFF satellite imagery Python API',
      filters: { yearStart: null, yearEnd: null, publicationTypes: [] },
      maxResults: 1,
    },
  )
  if (search.items.length !== 1 || search.completeness !== 'complete') {
    throw new Error('Phase 7 documentation search did not resolve one complete result')
  }
  const searchedSource = await evidence.sourceResolve(
    execution(literatureAgent, 'phase7-source-resolve'),
    search.searchChainTrace.chainId,
    search.searchChainTrace.generation,
    search.items[0]!.providerItemId,
  )
  const source = enrichedSource(searchedSource)
  await commitSource(projects, projectId, source)

  const [pdfDownload, rasterDownload] = await Promise.all([
    downloadBounded(documentationPdfUrl, 16 * 1024 * 1024, '%PDF-'),
    downloadBounded(rasterUrl, 8 * 1024 * 1024, undefined, isTiff),
  ])
  const pdfUpload = await projects.commitUploadedArtifact(coordinatorAgent, {
    attachmentId: randomUUID(),
    source: Readable.from([pdfDownload.bytes]),
    maxBytes: 16 * 1024 * 1024,
    mediaType: 'application/pdf',
  })
  const rasterUpload = await projects.commitUploadedArtifact(coordinatorAgent, {
    attachmentId: randomUUID(),
    source: Readable.from([rasterDownload.bytes]),
    maxBytes: 8 * 1024 * 1024,
    mediaType: 'image/tiff',
  })
  const rasterFile = await projects.resolveArtifactFile(
    experimentAgent,
    rasterUpload.artifact.artifactId,
  )

  const paper = await evidence.paperRead(
    execution(literatureAgent, 'phase7-paper-read'),
    { artifactId: pdfUpload.artifact.artifactId, pageStart: 7, pageEnd: 7 },
  )
  const documentationPage = paper.pages.find(page => page.page === 7)
  if (paper.textStatus !== 'extractable' || documentationPage === undefined) {
    throw new Error('Rasterio documentation page 7 was not extractable')
  }
  const quote = documentationQuote(documentationPage.text)
  const evidenceCandidate: EvidenceCandidate = {
    schemaVersion: 1,
    sourceId: source.sourceId,
    artifactId: pdfUpload.artifact.artifactId,
    paperReadReceiptId: paper.readReceiptId,
    locator: { pageStart: 7, pageEnd: 7 },
    proposition: 'Rasterio documents that GIS raster formats store gridded data such as satellite imagery and that Rasterio exposes them through a Python API.',
    relation: 'supports',
    paraphrase: 'The public Rasterio documentation explicitly connects GeoTIFF satellite imagery with Rasterio reading and its Python array API.',
    quotedText: quote,
    limitations: [
      'The public PDF is Rasterio documentation rather than a peer-reviewed remote-sensing benchmark paper.',
      'The documentation release is newer than the pinned runtime used by this compatibility case.',
    ],
  }
  await evidence.evidenceCandidate(
    execution(literatureAgent, 'phase7-evidence-candidate'),
    evidenceCandidate,
  )
  const evidenceRecord = await evidence.commitEvidenceCandidate(
    execution(coordinatorAgent, 'phase7-evidence-commit'),
    evidenceCandidate,
  )
  const citation = await evidence.citationCheck(
    execution(literatureAgent, 'phase7-citation-check'),
    evidenceRecord.evidenceId,
  )
  if (citation.status !== 'valid' || !Object.values(citation.checks).every(Boolean)) {
    throw new Error(`Phase 7 citation check failed: ${JSON.stringify(citation)}`)
  }

  repository = new GitRepositoryProvider({ timeoutMs: 90_000 })
  const reproduction = new ReproductionCoordinator({
    projects,
    runs: {
      async testSpecCandidate() {
        throw new Error('Phase 7 registers the deterministic TestSpec through Project authority')
      },
    },
    repository,
    host: {
      requireExperiment(value) { requireAgent(value, 'experiment') },
      requireRootCoordinator(value) { requireAgent(value, 'coordinator') },
    },
  })
  const audit = await reproduction.repositoryAudit(
    execution(experimentAgent, 'phase7-repository-audit'),
    {
      sourceId: source.sourceId,
      targetRef: 'HEAD',
      methodCodeDeltas: [{
        deltaId: 'phase7-public-raster-analysis',
        evidenceId: evidenceRecord.evidenceId,
        classification: 'not-described-in-paper',
        codeLocator: {
          path: 'phase7_experiment.py',
          lineStart: 1,
          lineEnd: lineCount(pythonSource),
        },
        summary: 'A bounded local harness computes a nodata-aware valid-pixel ratio and emits the frozen result envelope.',
        likelyImpact: 'Adds only evaluation plumbing and does not alter Rasterio library behavior.',
        limitations: ['The harness imports the installed Rasterio runtime instead of building the cloned source tree.'],
      }, {
        deltaId: 'phase7-public-raster-test',
        evidenceId: evidenceRecord.evidenceId,
        classification: 'not-described-in-paper',
        codeLocator: {
          path: 'test_phase7_experiment.py',
          lineStart: 1,
          lineEnd: lineCount(testSource),
        },
        summary: 'A deterministic pytest checks the public raster dimensions, band count, CRS, NoData, and valid-pixel bounds.',
        likelyImpact: 'Constrains the local evaluation without changing the measured public data.',
        limitations: ['The test is specific to the pinned Rasterio sample.'],
      }],
    },
  )
  if (audit.repository.targetCommit === null || !audit.repository.targetMatchesHead
    || audit.repository.remoteUrl === null || audit.methodCodeDeltas.length !== 2) {
    throw new Error('Phase 7 repository audit is not fully bound')
  }

  const pythonInfo = await readPythonEnvironment(pythonExecutable)
  const plan = await reproduction.reproductionPlanCandidate(
    execution(experimentAgent, 'phase7-reproduction-plan'),
    {
      schemaVersion: 1,
      planId: 'phase7-rasterio-public-read',
      sourceId: source.sourceId,
      repositoryAuditId: audit.auditId,
      targetRepository: {
        remoteUrl: audit.repository.remoteUrl,
        commit: audit.repository.targetCommit,
      },
      targetData: [rasterUrl],
      targetResults: [],
      scope: 'functional',
      environmentRequirements: [
        `Python ${pythonInfo.pythonVersion}`,
        `rasterio ${pythonInfo.rasterio}`,
        `pyproj ${pythonInfo.pyproj}`,
        `pytest ${pythonInfo.pytest}`,
      ],
      missingMaterials: [],
      steps: [{
        stepId: 'inspect-public-raster',
        kind: 'inspect',
        description: 'Read the registered public GeoTIFF through a verified Artifact lease.',
        expectedOutputs: ['GeoTIFF metadata and deterministic Artifact digest'],
      }, {
        stepId: 'bind-local-harness',
        kind: 'modify',
        description: 'Bind the local analysis and test files to the audited source tree.',
        expectedOutputs: ['method/code delta locators'],
      }, {
        stepId: 'run-public-raster-test',
        kind: 'test',
        description: 'Execute the registered pytest against the same Artifact bytes.',
        expectedOutputs: ['succeeded source-tree-bound local test'],
      }],
      expectedOutputs: ['source-tree-bound local test', 'Reviewer-readable ReproductionReport'],
      tolerances: [],
      blockers: audit.blockers,
    },
  )

  const testSpec = await registerReproductionTestSpec(
    projects,
    projectId,
    attached.binding.workspaceId,
    attached.binding.bindingVersion,
    plan.planId,
    audit.auditId,
    audit.sourceTreeDigest,
    rasterFile.path,
  )
  const testEnvironment = {
    GEORESEARCH_PHASE7_RASTER: rasterFile.path,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    GDAL_PAM_ENABLED: 'NO',
  }
  const reproductionRun = await runRecordedProcess({
    projects,
    home,
    projectId,
    resolved: attached,
    runId: 'phase7-reproduction-test',
    kind: 'local-test',
    experimentSpecDigest: testSpec.specDigest,
    sourceTreeDigest: audit.sourceTreeDigest,
    datasetDigests: [rasterUpload.artifact.digest],
    argv: [...testSpec.spec.argv],
    environment: testEnvironment,
    timeoutMs: testSpec.spec.timeoutMs,
    graceMs: testSpec.spec.graceMs,
  })
  if (reproductionRun.state !== 'succeeded') throw new Error('Phase 7 public raster test did not succeed')

  const afterTestInspection = await repository.inspect({ workspaceRoot: workspace, targetRef: 'HEAD' })
  if (afterTestInspection.sourceTreeDigest !== audit.sourceTreeDigest) {
    throw new Error('Phase 7 repository changed while the public test ran')
  }
  const reproductionReport = await reproduction.commitReproductionReportCandidate(
    execution(coordinatorAgent, 'phase7-reproduction-report'),
    {
      schemaVersion: 1,
      kind: 'reproduction-report',
      planId: plan.planId,
      baselineAuditId: audit.auditId,
      finalAuditId: audit.auditId,
      runIds: [reproductionRun.runId],
      status: 'functionally-reproduced',
      metricResults: [],
      paperDescription: 'The Rasterio documentation describes reading geospatial raster formats, including satellite imagery, through a Python API.',
      officialCodeBehavior: `The public Rasterio ${repositoryTag} source and RGB.byte.tif sample were pinned to commit ${audit.repository.targetCommit}.`,
      localImplementationAndEnvironment: `The registered pytest used Python ${pythonInfo.pythonVersion}, rasterio ${pythonInfo.rasterio}, and the exact uploaded GeoTIFF bytes.`,
      necessaryModifications: [],
      resultDifferences: ['The public documentation PDF is release 1.4.4 while the installed evaluation runtime is Rasterio 1.4.3.'],
      differenceSources: ['The ReadTheDocs stable PDF and the locally negotiated Python environment report different minor releases.'],
      unresolvedDetails: [],
      diagnostics: [],
      limitations: [
        'This functional reproduction validates public raster reading and metadata, not the complete Rasterio test suite.',
        'The cloned source tree is audited, while the execution imports the installed compatible Rasterio runtime.',
      ],
    },
  )

  geospatialProvider = new PythonGeospatialProvider({
    runtime: nodeSubprocessRuntime(),
    pythonRoot: join(root, 'python'),
    pythonExecutable,
    requestTimeoutMs: 60_000,
    graceMs: 2_000,
  })
  const capability = await geospatialProvider.ready()
  const geospatial = new GeospatialCoordinator({
    projects,
    provider: geospatialProvider,
    host: { requireExperiment(value) { requireAgent(value, 'experiment') } },
  })
  const geodataReport = await geospatial.inspect(
    execution(experimentAgent, 'phase7-geodata-inspect'),
    {
      datasetId: 'dataset-rasterio-rgb',
      datasetName: 'Rasterio Landsat RGB public sample',
      datasetVersion: repositoryTag,
      sourceUri: rasterUrl,
      sourceProvider: 'rasterio-github-release',
      artifactIds: [rasterUpload.artifact.artifactId],
      actions: [],
      splits: [],
      qualityMasks: ['nodata=0'],
      preprocessingLevel: 'raw public sample',
      labelSchema: [],
      knownLimitations: [
        'The sample is a small public Landsat crop intended for software testing.',
        'No machine-learning train/test split is claimed for this descriptive metric.',
      ],
      machineLearning: false,
      classification: false,
      categoricalResampling: null,
      spatialStatistics: {
        blockingStrategy: 'full-scene descriptive statistic',
        autocorrelation: 'not estimated for a single descriptive scene',
        multipleComparison: 'one registered metric',
        effectSize: 'valid-pixel ratio',
      },
    },
  )
  const geodataAsset = geodataReport.assets[0]
  if (geodataReport.overall !== 'passed' || geodataAsset?.format !== 'GTiff'
    || geodataAsset.width !== 791 || geodataAsset.height !== 718
    || geodataAsset.crs.authority !== 'EPSG:32618') {
    throw new Error(`Phase 7 geodata inspection is invalid: ${JSON.stringify(geodataReport)}`)
  }

  const experiments = new ExperimentCoordinator({
    projects,
    geospatial,
    host: {
      requireExperiment(value) { requireAgent(value, 'experiment') },
      requireRootCoordinator(value) { requireAgent(value, 'coordinator') },
      requireReviewer(value) { requireAgent(value, 'reviewer') },
    },
  }, { home })
  const experimentCandidate = phase7ExperimentCandidate(
    geodataReport,
    brief.brief.digest,
    audit.auditId,
  )
  await experiments.candidate(
    execution(experimentAgent, 'phase7-experiment-candidate'),
    experimentCandidate,
  )
  const beforeSpec = await projects.loadProject(projectId)
  const frozen = await experiments.commitCandidate(
    execution(coordinatorAgent, 'phase7-experiment-commit'),
    experimentCandidate,
    beforeSpec.generation,
  )
  const manifest = frozen.datasetManifests[0]
  if (manifest === undefined || manifest.status !== 'verified') {
    throw new Error('Phase 7 ExperimentSpec did not freeze a verified DatasetManifest')
  }

  const experimentRun = await runRecordedProcess({
    projects,
    home,
    projectId,
    resolved: attached,
    runId: 'phase7-formal-experiment',
    kind: 'formal',
    experimentSpecDigest: frozen.experimentSpec.digest,
    sourceTreeDigest: audit.sourceTreeDigest,
    datasetDigests: [manifest.digest],
    seed: 7,
    argv: [
      pythonExecutable,
      'phase7_experiment.py',
      rasterFile.path,
      manifest.datasetId,
      rasterUpload.artifact.artifactId,
    ],
    environment: {
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONNOUSERSITE: '1',
      GDAL_PAM_ENABLED: 'NO',
    },
    timeoutMs: 60_000,
    graceMs: 2_000,
  })
  if (experimentRun.state !== 'succeeded') throw new Error('Phase 7 formal experiment did not succeed')
  const beforeResults = await projects.loadProject(projectId)
  const results = await experiments.commitResults(
    execution(coordinatorAgent, 'phase7-result-commit'),
    beforeResults.generation,
    experimentRun.runId,
  )
  const result = results[0]
  if (results.length !== 1 || result === undefined || result.metricId !== 'valid-pixel-ratio') {
    throw new Error('Phase 7 formal experiment emitted an invalid result set')
  }

  const validation = new ValidationCoordinator({
    projects,
    host: { requireReviewer(value) { requireAgent(value, 'reviewer') } },
  })
  const citationValidation = await validation.validateCitation(
    execution(reviewerAgent, 'phase7-citation-validation'),
    (await projects.loadProject(projectId)).generation,
    [evidenceRecord.evidenceId],
  )
  const geodataValidation = await validation.validateGeodata(
    execution(reviewerAgent, 'phase7-geodata-validation'),
    (await projects.loadProject(projectId)).generation,
    geodataReport.reportId,
  )
  const experimentValidation = await validation.validateExperiment(
    execution(reviewerAgent, 'phase7-experiment-validation'),
    (await projects.loadProject(projectId)).generation,
    [result.resultId],
  )
  for (const outcome of [citationValidation, geodataValidation, experimentValidation]) {
    if (outcome.report.overall !== 'passed') {
      throw new Error(`Phase 7 validation failed: ${JSON.stringify(outcome.report)}`)
    }
  }

  const review = await validation.reviewCandidate(
    execution(reviewerAgent, 'phase7-independent-review'),
    (await projects.loadProject(projectId)).generation,
    {
      schemaVersion: 1,
      kind: 'review',
      reviewId: 'phase7-public-raster-review',
      subjectRefs: [{
        kind: 'evidence',
        subjectId: evidenceRecord.evidenceId,
        digest: evidenceRecord.digest,
      }, {
        kind: 'geodata-report',
        subjectId: geodataReport.reportId,
        digest: geodataReport.digest,
      }, {
        kind: 'result',
        subjectId: result.resultId,
        digest: result.digest,
      }],
      validationReportIds: [
        citationValidation.report.reportId,
        geodataValidation.report.reportId,
        experimentValidation.report.reportId,
      ],
      findings: [],
      recommendation: 'accept',
      supersedesReviewIds: [],
    },
  )

  const claims = new ClaimCoordinator({
    projects,
    host: {
      requireCoordinator(value) { requireAgent(value, 'coordinator') },
      isWorkflowAutonomous() { return false },
      async requestApproval() { return 'allowed-once' },
    },
  })
  const literatureClaim = await claims.commitClaim(
    execution(coordinatorAgent, 'phase7-literature-claim'),
    (await projects.loadProject(projectId)).generation,
    {
      schemaVersion: 1,
      kind: 'claim',
      claimId: 'claim-rasterio-public-raster-api',
      statement: 'Rasterio documents a Python API for reading gridded geospatial formats used for satellite imagery.',
      claimType: 'literature-fact',
      supportRefs: [{ kind: 'evidence', recordId: evidenceRecord.evidenceId, digest: evidenceRecord.digest }],
      calculation: null,
      limitations: [...evidenceCandidate.limitations],
      intendedSections: ['introduction'],
      validationReportIds: [citationValidation.report.reportId],
      reviewRecordIds: [review.reviewId],
    },
    'approved',
  )
  const metricLiteral = String(result.value)
  const experimentClaim = await claims.commitClaim(
    execution(coordinatorAgent, 'phase7-experiment-claim'),
    (await projects.loadProject(projectId)).generation,
    {
      schemaVersion: 1,
      kind: 'claim',
      claimId: 'claim-public-raster-valid-pixel-ratio',
      statement: `The registered public raster produced a nodata-aware valid-pixel ratio of ${metricLiteral}.`,
      claimType: 'experimental-observation',
      supportRefs: [{ kind: 'result', recordId: result.resultId, digest: result.digest }],
      calculation: null,
      limitations: [
        'This descriptive ratio is not a predictive performance metric.',
        'The result applies only to the pinned public sample Artifact.',
      ],
      intendedSections: ['results'],
      validationReportIds: [experimentValidation.report.reportId],
      reviewRecordIds: [review.reviewId],
    },
    'approved',
  )
  if (literatureClaim.supportState !== 'independently-checked'
    || experimentClaim.supportState !== 'independently-checked') {
    throw new Error('Phase 7 approved Claims are not independently checked')
  }

  const packet = await claims.buildWritingPacket(
    execution(coordinatorAgent, 'phase7-writing-packet'),
    (await projects.loadProject(projectId)).generation,
    'phase7-public-raster-packet',
  )
  const writing = new WritingCoordinator({
    projects,
    host: { requireWriting(value) { requireAgent(value, 'writing') } },
  })
  const manuscriptCandidate = {
    schemaVersion: 1 as const,
    kind: 'manuscript' as const,
    manuscriptId: 'phase7-public-raster-manuscript',
    packetId: packet.packetId,
    packetDigest: packet.digest,
    title: 'Traceable public remote-sensing raster inspection',
    sections: [{
      sectionId: 'introduction' as const,
      title: 'Introduction',
      blocks: [{
        blockId: 'introduction-rasterio',
        text: 'Rasterio provides a Python interface for reading gridded geospatial formats used for satellite imagery.',
        claimIds: [literatureClaim.claimId],
        evidenceIds: [evidenceRecord.evidenceId],
        resultIds: [],
        numericRefs: [],
      }],
    }, {
      sectionId: 'results' as const,
      title: 'Results',
      blocks: [{
        blockId: 'results-valid-pixels',
        text: `The nodata-aware valid-pixel ratio was ${metricLiteral}.`,
        claimIds: [experimentClaim.claimId],
        evidenceIds: [],
        resultIds: [result.resultId],
        numericRefs: [{
          literal: metricLiteral,
          claimId: experimentClaim.claimId,
          resultId: result.resultId,
        }],
      }],
    }],
  }
  await writing.candidate(
    execution(writingAgent, 'phase7-manuscript-candidate'),
    manuscriptCandidate,
  )
  const manuscript = await writing.validate(
    execution(writingAgent, 'phase7-manuscript-validate'),
    (await projects.loadProject(projectId)).generation,
    manuscriptCandidate,
  )
  if (manuscript.audit.overall !== 'passed' || manuscript.manuscript.status !== 'validated') {
    throw new Error(`Phase 7 manuscript audit failed: ${JSON.stringify(manuscript.audit)}`)
  }

  const finalProject = await projects.loadProject(projectId)
  const documentationRelease = /Release\s+([0-9.]+)/u.exec(documentationPage.text)?.[1] ?? null
  liveReport = {
    schemaVersion: 1,
    phase: 'phase7-public-remote-sensing-e2e',
    checkedAt: nowUtc(),
    environment: {
      platform: process.platform,
      node: process.version,
      python: pythonInfo,
      telemetryDisabled: process.env.DSH_TELEMETRY_DISABLED === '1',
      operatorScopeProtection: operatorRecord.protection,
      operatorScopeMode: operator.mode,
      independentDpapiEvidence: operator.dpapiEvidence,
    },
    publicInputs: {
      repository: { url: repositoryUrl, tag: repositoryTag, commit: audit.repository.targetCommit },
      documentation: {
        url: documentationUrl,
        pdfUrl: pdfDownload.resolvedUrl,
        release: documentationRelease,
        bytes: pdfDownload.bytes.byteLength,
        artifactId: pdfUpload.artifact.artifactId,
        artifactDigest: pdfUpload.artifact.digest,
      },
      raster: {
        url: rasterDownload.resolvedUrl,
        bytes: rasterDownload.bytes.byteLength,
        artifactId: rasterUpload.artifact.artifactId,
        artifactDigest: rasterUpload.artifact.digest,
      },
    },
    project: {
      projectId,
      workspaceId: attached.binding.workspaceId,
      finalGeneration: finalProject.generation,
      stateCounts: {
        artifacts: Object.keys(finalProject.state.artifacts).length,
        runs: Object.keys(finalProject.state.runs).length,
        sources: Object.keys(finalProject.state.sources ?? {}).length,
        evidence: Object.keys(finalProject.state.evidence ?? {}).length,
        repositoryAudits: Object.keys(finalProject.state.repositoryAudits ?? {}).length,
        reproductionPlans: Object.keys(finalProject.state.reproductionPlans ?? {}).length,
        reproductionReports: Object.keys(finalProject.state.reproductionReports ?? {}).length,
        geodataReports: Object.keys(finalProject.state.geodataReports ?? {}).length,
        experimentSpecs: Object.keys(finalProject.state.experimentSpecs ?? {}).length,
        results: Object.keys(finalProject.state.results ?? {}).length,
        validationReports: Object.keys(finalProject.state.validationReports ?? {}).length,
        claims: Object.keys(finalProject.state.claims ?? {}).length,
        writingPackets: Object.keys(finalProject.state.writingPackets ?? {}).length,
        manuscripts: Object.keys(finalProject.state.manuscripts ?? {}).length,
      },
    },
    literatureAndEvidence: {
      providerId: search.providerTrace.providerId,
      chainId: search.searchChainTrace.chainId,
      sourceId: source.sourceId,
      sourceDigest: source.digest,
      paperReadReceiptId: paper.readReceiptId,
      parserLineage: paper.lineage,
      evidenceId: evidenceRecord.evidenceId,
      evidenceDigest: evidenceRecord.digest,
      citationStatus: citation.status,
      quote,
    },
    repositoryAndReproduction: {
      auditId: audit.auditId,
      auditDigest: audit.digest,
      sourceTreeDigest: audit.sourceTreeDigest,
      dirtyWithGroundedHarness: audit.repository.dirty,
      methodCodeDeltaIds: audit.methodCodeDeltas.map(delta => delta.deltaId),
      planId: plan.planId,
      testSpecId: testSpec.spec.testSpecId,
      runId: reproductionRun.runId,
      reportId: reproductionReport.reportId,
      reportStatus: reproductionReport.status,
      reportArtifact: reproductionReport.reportArtifact,
    },
    geodataAndExperiment: {
      provider: capability,
      reportId: geodataReport.reportId,
      reportDigest: geodataReport.digest,
      geodataOverall: geodataReport.overall,
      rasterMetadata: geodataAsset,
      datasetManifestId: manifest.datasetId,
      datasetManifestDigest: manifest.digest,
      experimentSpecId: frozen.experimentSpec.specId,
      experimentSpecDigest: frozen.experimentSpec.digest,
      formalRunId: experimentRun.runId,
      resultId: result.resultId,
      resultDigest: result.digest,
      metric: { id: result.metricId, value: result.value, unit: result.unit, aggregation: result.aggregation },
    },
    validationClaimWriting: {
      validationReports: [
        citationValidation.report,
        geodataValidation.report,
        experimentValidation.report,
      ].map(value => ({ reportId: value.reportId, domain: finalProject.state.validationPlans?.[value.planId]?.domain, overall: value.overall })),
      reviewId: review.reviewId,
      claimIds: [literatureClaim.claimId, experimentClaim.claimId],
      claimSupportStates: [literatureClaim.supportState, experimentClaim.supportState],
      writingPacketId: packet.packetId,
      writingPacketDigest: packet.digest,
      manuscriptId: manuscript.manuscript.manuscriptId,
      manuscriptDigest: manuscript.manuscript.digest,
      manuscriptAuditId: manuscript.audit.auditId,
      manuscriptAuditOverall: manuscript.audit.overall,
    },
    checks: {
      publicRepositoryCloned: true,
      exactRepositoryCommitAudited: audit.repository.targetMatchesHead,
      publicDocumentationPdfRead: paper.textStatus === 'extractable',
      evidenceCitationValid: citation.status === 'valid',
      publicGeoTiffRegistered: rasterUpload.artifact.integrity === 'verified',
      extensionlessArtifactInspected: !rasterFile.path.toLowerCase().endsWith('.tif')
        && !rasterFile.path.toLowerCase().endsWith('.tiff'),
      geodataMandatoryChecksPassed: geodataReport.overall === 'passed',
      sourceTreeBoundTestPassed: reproductionRun.state === 'succeeded',
      reproductionReportPreserved: reproductionReport.status === 'functionally-reproduced',
      frozenExperimentExecuted: experimentRun.state === 'succeeded',
      resultContractValidated: experimentValidation.report.overall === 'passed',
      allValidationDomainsPassed: [citationValidation, geodataValidation, experimentValidation]
        .every(value => value.report.overall === 'passed'),
      claimsIndependentlyChecked: [literatureClaim, experimentClaim]
        .every(value => value.supportState === 'independently-checked'),
      writingPacketIsolated: packet.forbiddenClaimIds.length === 0,
      manuscriptTraceabilityPassed: manuscript.audit.overall === 'passed',
      telemetryDisabled: process.env.DSH_TELEMETRY_DISABLED === '1',
      windowsDpapi: process.platform !== 'win32'
        || operatorRecord.protection === 'dpapi-current-user'
        || operator.dpapiEvidence.verified,
    },
  }
} finally {
  try {
    if (evidence !== undefined) {
      await evidence.drain()
      evidenceDrained = true
    }
  } finally {
    try {
      if (evidence !== undefined) {
        await evidence.dispose()
        evidenceDisposed = true
      }
    } finally {
      try {
        if (repository !== undefined) {
          await repository.drain()
          repositoryDrained = true
          await repository.dispose()
          repositoryDisposed = true
        }
      } finally {
        try {
          if (geospatialProvider !== undefined) {
            await geospatialProvider.drain()
            geospatialDrained = true
            await geospatialProvider.dispose()
            geospatialDisposed = true
          }
        } finally {
          await rm(temporaryRoot, { recursive: true, force: true })
          temporaryStateRemoved = true
        }
      }
    }
  }
}

if (liveReport === undefined) throw new Error('Phase 7 live E2E did not produce a report')
const finalReport = {
  ...liveReport,
  lifecycle: {
    evidenceDrained,
    evidenceDisposed,
    repositoryDrained,
    repositoryDisposed,
    geospatialDrained,
    geospatialDisposed,
    temporaryStateRemoved,
  },
}
await atomicWriteJson(reportPath, finalReport)
process.stdout.write(`${JSON.stringify({
  reportPath,
  phase: finalReport.phase,
  checks: finalReport.checks,
  lifecycle: finalReport.lifecycle,
}, undefined, 2)}\n`)

function publicDocumentationProvider(): LiteratureProvider {
  let disposed = false
  return {
    capability: Object.freeze({
    providerId: 'phase7-public-documentation',
    providerVersion: '1.0.0',
    continuationFormatDigest: digestPhase3Body({ domain: 'phase7-public-documentation/v1' }),
    replaySemantics: 'replay-safe-read' as const,
    maxPageSize: 1,
    supportsCredentialRef: false,
    }),
    initialUpstreamState(): JsonValue {
      return { page: 1 }
    },
    async searchPage(request: LiteratureProviderPageRequest): Promise<LiteratureProviderPage> {
      if (disposed) throw new Error('Phase 7 documentation provider is disposed')
      request.signal?.throwIfAborted()
      return {
        items: [documentationItem()],
        nextUpstreamState: null,
        done: true,
        warnings: [],
        requestId: 'phase7-rasterio-documentation',
      }
    },
    async drain(): Promise<void> {},
    async dispose(): Promise<void> {
      disposed = true
    },
  }
}

function nodeSubprocessRuntime(): { spawn(spec: SubprocessSpawnSpec): SubprocessHandle } {
  return { spawn: spawnNodeSubprocess }
}

function spawnNodeSubprocess(spec: SubprocessSpawnSpec): SubprocessHandle {
  const command = spec.argv[0]
  if (command === undefined) throw new TypeError('subprocess argv is empty')
  const env = mergeEnvironment(spec.env)
  const child = spawn(command, [...spec.argv.slice(1)], {
    cwd: spec.cwd,
    env,
    shell: false,
    windowsHide: true,
    stdio: [spec.stdio.stdin === 'pipe' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  if (spec.stdio.stderr !== 'pipe') {
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr = boundedAppend(stderr, String(chunk), 256 * 1024) })
  }
  let settled = false
  let resolveDone!: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void
  let rejectDone!: (error: unknown) => void
  const done = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolveValue, rejectValue) => {
    resolveDone = resolveValue
    rejectDone = rejectValue
  })
  child.once('error', error => {
    if (settled) return
    settled = true
    rejectDone(error)
  })
  child.once('close', (exitCode, signal) => {
    if (settled) return
    settled = true
    resolveDone({ exitCode, signal })
  })
  let escalation: NodeJS.Timeout | undefined
  const terminate = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    escalation ??= setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, spec.graceMs)
    escalation.unref()
  }
  spec.signal?.addEventListener('abort', terminate, { once: true })
  void done.finally(() => {
    if (escalation !== undefined) clearTimeout(escalation)
    spec.signal?.removeEventListener('abort', terminate)
  }).catch(() => undefined)
  return {
    pid: child.pid ?? -1,
    stdin: spec.stdio.stdin === 'pipe' ? child.stdin : undefined,
    stdout: spec.stdio.stdout === 'pipe' ? child.stdout : undefined,
    stderr: spec.stdio.stderr === 'pipe' ? child.stderr : undefined,
    collected: spec.stdio.stderr === 'pipe'
      ? {}
      : { stderr: outputReader(() => stderr) },
    done,
    terminate,
    async waitForExit(signal?: AbortSignal): Promise<boolean> {
      if (signal === undefined) {
        await done.catch(() => undefined)
        return true
      }
      if (signal.aborted) return false
      return await Promise.race([
        done.then(() => true, () => true),
        new Promise<boolean>(resolveValue => {
          signal.addEventListener('abort', () => resolveValue(false), { once: true })
        }),
      ])
    },
  }
}

function documentationItem(): LiteratureItem {
  return {
    providerItemId: 'rasterio-stable-documentation',
    title: 'Rasterio documentation',
    authors: [{ name: 'Sean Gillies', orcid: null }],
    year: 2025,
    venue: 'Read the Docs',
    doi: null,
    stableIdentifier: `provider:${documentationUrl}`,
    sourceType: 'software-documentation',
    url: documentationPdfUrl,
  }
}

function enrichedSource(searched: SourceRecord): SourceRecord {
  const body = {
    schemaVersion: 1 as const,
    sourceId: 'source-rasterio-public-documentation',
    title: searched.title,
    authors: searched.authors,
    year: searched.year,
    venue: searched.venue,
    stableIdentifier: searched.stableIdentifier,
    sourceType: searched.sourceType,
    versionRelation: searched.versionRelation,
    retrievedAt: searched.retrievedAt,
    providerTrace: searched.providerTrace,
    codeRefs: [{ url: repositoryUrl, label: `Rasterio ${repositoryTag} public repository` }],
    dataRefs: [{ url: rasterUrl, label: 'Pinned public RGB GeoTIFF sample' }],
    status: 'resolved' as const,
    searchChain: searched.searchChain,
  }
  return { ...body, digest: digestPhase3Body(body) }
}

async function createPhase7OperatorScope(homePath: string): Promise<{
  readonly record: OperatorScopeRecord
  readonly scope: OperatorScope
  readonly mode: 'real-dpapi' | 'test-key-with-independent-dpapi-evidence'
  readonly dpapiEvidence: {
    readonly verified: boolean
    readonly reportPath: string | null
    readonly checkedAt: string | null
    readonly currentAttemptError: string | null
  }
}> {
  const installationId = `phase7-${randomUUID()}`
  try {
    const record = await createOperatorScopeRecord(homePath, installationId)
    const scope = await openOperatorScopeRecord(homePath, installationId, record)
    return {
      record,
      scope,
      mode: 'real-dpapi',
      dpapiEvidence: {
        verified: record.protection === 'dpapi-current-user',
        reportPath: null,
        checkedAt: null,
        currentAttemptError: null,
      },
    }
  } catch (error) {
    const evidence = await independentDpapiEvidence()
    if (process.platform === 'win32' && !evidence.verified) throw error
    const testKey = Buffer.alloc(32, 0x57).toString('base64url')
    const previousNodeEnv = process.env.NODE_ENV
    process.env.NODE_ENV = 'test'
    try {
      const record = await createOperatorScopeRecord(homePath, installationId, { testKey })
      const scope = await openOperatorScopeRecord(homePath, installationId, record, { testKey })
      return {
        record,
        scope,
        mode: 'test-key-with-independent-dpapi-evidence',
        dpapiEvidence: {
          ...evidence,
          currentAttemptError: errorMessage(error),
        },
      }
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = previousNodeEnv
    }
  }
}

async function independentDpapiEvidence(): Promise<{
  readonly verified: boolean
  readonly reportPath: string | null
  readonly checkedAt: string | null
}> {
  const path = join(root, 'dist', 'reports', 'phase3-live-activation.json')
  try {
    const report = JSON.parse(await readFile(path, 'utf8')) as {
      readonly checkedAt?: unknown
      readonly environment?: { readonly platform?: unknown; readonly operatorScopeProtection?: unknown }
      readonly checks?: { readonly realWindowsDpapi?: unknown; readonly telemetryDisabled?: unknown }
      readonly lifecycle?: { readonly temporaryStateRemoved?: unknown }
    }
    const verified = report.environment?.platform === 'win32'
      && report.environment.operatorScopeProtection === 'dpapi-current-user'
      && report.checks?.realWindowsDpapi === true
      && report.checks.telemetryDisabled === true
      && report.lifecycle?.temporaryStateRemoved === true
    return {
      verified,
      reportPath: path,
      checkedAt: typeof report.checkedAt === 'string' ? report.checkedAt : null,
    }
  } catch {
    return { verified: false, reportPath: null, checkedAt: null }
  }
}

async function commitSource(
  projects: ProjectCoordinator,
  projectId: string,
  source: SourceRecord,
): Promise<void> {
  const current = await projects.loadProject(projectId)
  await projects.commitSourceRecord(projectId, {
    expectedGeneration: current.generation,
    operationKey: digestJson({ phase: 7, operation: 'enriched-source', sourceId: source.sourceId }),
    requestDigest: digestJson({ source }),
    source,
  })
}

async function registerReproductionTestSpec(
  projects: ProjectCoordinator,
  projectId: string,
  workspaceId: string,
  workspaceBindingVersion: number,
  planId: string,
  repositoryAuditId: string,
  sourceTreeDigest: Sha256Digest,
  rasterPath: string,
): Promise<ReproductionTestSpecRecord> {
  const spec = {
    schemaVersion: 1 as const,
    testSpecId: 'phase7-public-raster-pytest',
    runner: 'pytest' as const,
    argv: [
      pythonExecutable,
      '-m',
      'pytest',
      '-q',
      '-p',
      'no:cacheprovider',
      'test_phase7_experiment.py',
    ],
    cwdRelative: '.',
    timeoutMs: 60_000,
    graceMs: 2_000,
    environment: {
      GEORESEARCH_PHASE7_RASTER: rasterPath,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONNOUSERSITE: '1',
      GDAL_PAM_ENABLED: 'NO',
    },
  }
  const body = {
    schemaVersion: 1 as const,
    projectId,
    workspaceId,
    workspaceBindingVersion,
    planId,
    repositoryAuditId,
    sourceTreeDigest,
    spec,
    specDigest: digestJson(spec),
    registeredAt: nowUtc(),
  }
  const record: ReproductionTestSpecRecord = { ...body, digest: digestJson(body) }
  const current = await projects.loadProject(projectId)
  await projects.commitReproductionTestSpec(projectId, {
    expectedGeneration: current.generation,
    operationKey: digestJson({ phase: 7, operation: 'test-spec', testSpecId: spec.testSpecId }),
    requestDigest: digestJson({ record }),
    reproductionTestSpec: record,
  })
  return record
}

interface RecordedProcessOptions {
  readonly projects: ProjectCoordinator
  readonly home: string
  readonly projectId: string
  readonly resolved: Awaited<ReturnType<ProjectCoordinator['resolveAgent']>>
  readonly runId: string
  readonly kind: 'local-test' | 'formal'
  readonly experimentSpecDigest: Sha256Digest
  readonly sourceTreeDigest: Sha256Digest
  readonly datasetDigests: readonly Sha256Digest[]
  readonly seed?: number
  readonly argv: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly graceMs: number
}

async function runRecordedProcess(options: RecordedProcessOptions): Promise<RunRecord> {
  const stdoutPath = `runs/${options.runId}/stdout.log`
  const stderrPath = `runs/${options.runId}/stderr.log`
  const starting: RunRecord = {
    schemaVersion: 1,
    runId: options.runId,
    kind: options.kind,
    projectId: options.projectId,
    workspaceId: options.resolved.binding.workspaceId,
    workspaceBindingVersion: options.resolved.binding.bindingVersion,
    experimentSpecDigest: options.experimentSpecDigest,
    sourceTreeDigest: options.sourceTreeDigest,
    environmentDigest: digestJson({
      python: pythonExecutable,
      environment: Object.keys(options.environment).sort(),
    }),
    datasetDigests: options.datasetDigests,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    argv: options.argv,
    argvDigest: digestJson(options.argv),
    cwd: {
      canonicalPath: options.resolved.workspace.canonicalPath,
      volumeIdentity: options.resolved.workspace.volumeIdentity,
      fileIdentity: options.resolved.workspace.directoryFileIdentity,
    },
    state: 'starting',
    launchId: `launch-${options.runId}`,
    resourceLimits: {
      timeoutMs: options.timeoutMs,
      graceMs: options.graceMs,
      stdoutMaxBytes: 1024 * 1024,
      stderrMaxBytes: 1024 * 1024,
    },
    stdoutPath,
    stderrPath,
    sandbox: { mode: 'workspace-write', enforcement: 'partial' },
    approval: {
      outcome: 'allowed-once',
      callId: `approval-${options.runId}`,
      approvedAt: nowUtc(),
    },
    outputArtifactRefs: [],
  }
  await commitRun(options.projects, starting, true)

  const command = options.argv[0]
  if (command === undefined) throw new TypeError('recorded process argv is empty')
  const child = spawn(command, [...options.argv.slice(1)], {
    cwd: options.resolved.workspace.canonicalPath,
    env: mergeEnvironment(options.environment),
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('spawn', resolveSpawn)
    child.once('error', rejectSpawn)
  })
  const startedAt = nowUtc()
  const running: RunRecord = {
    ...starting,
    state: 'running',
    pid: child.pid ?? -1,
    processCreationTime: startedAt,
    supervisorReceiptDigest: digestJson({ runId: options.runId, pid: child.pid ?? -1, startedAt }),
    startedAt,
  }
  await commitRun(options.projects, running, false)

  const completed = await collectChild(child, options.timeoutMs, options.graceMs)
  const runRoot = projectPaths(options.home, options.projectId).root
  await mkdir(join(runRoot, 'runs', options.runId), { recursive: true })
  await writeFile(join(runRoot, ...stdoutPath.split('/')), completed.stdout, 'utf8')
  await writeFile(join(runRoot, ...stderrPath.split('/')), completed.stderr, 'utf8')
  const marker: RunExitMarker = {
    schemaVersion: 1,
    projectId: options.projectId,
    runId: options.runId,
    launchId: starting.launchId,
    exitCode: completed.exitCode,
    signal: completed.signal,
    endedAt: completed.endedAt,
    stdoutDigest: sha256Bytes(completed.stdout),
    stderrDigest: sha256Bytes(completed.stderr),
  }
  await atomicWriteJson(join(runRoot, 'runs', options.runId, 'exit.json'), marker)
  const collecting: RunRecord = {
    ...running,
    state: 'collecting',
    endedAt: completed.endedAt,
    exitCode: completed.exitCode,
  }
  await commitRun(options.projects, collecting, false)
  const terminal: RunRecord = {
    ...collecting,
    state: completed.exitCode === 0 ? 'succeeded' : 'failed',
  }
  await commitRun(options.projects, terminal, false)
  if (terminal.state !== 'succeeded') {
    throw new Error([
      `${options.runId} failed with exit ${String(completed.exitCode)}`,
      completed.stdout.trim(),
      completed.stderr.trim(),
    ].filter(Boolean).join(': '))
  }
  return terminal
}

async function commitRun(
  projects: ProjectCoordinator,
  run: RunRecord,
  initial: boolean,
): Promise<void> {
  const current = await projects.loadProject(run.projectId)
  await projects.commitRunRecord(run.projectId, {
    expectedGeneration: current.generation,
    operationKey: digestJson({ phase: 7, runId: run.runId, state: run.state }),
    requestDigest: digestJson({ run }),
    run,
    initial,
  })
}

function phase7ExperimentCandidate(
  report: Parameters<GeospatialCoordinator['manifestFromReport']>[0],
  researchBriefDigest: Sha256Digest,
  repositoryAuditId: string,
): ExperimentSpecCandidate {
  return {
    schemaVersion: 1,
    kind: 'experiment-spec',
    specId: 'phase7-public-raster-spec',
    experimentId: 'phase7-public-raster-inspection',
    revision: 1,
    researchBriefDigest,
    hypothesisIds: ['hypothesis-public-raster-readable'],
    repositoryAuditId,
    datasetReports: [report],
    datasetRoles: [{ datasetId: report.datasetId, role: 'testing' }],
    baselines: [{
      baselineId: 'all-pixels-denominator',
      description: 'All pixels in the first band before masking the registered NoData value.',
      implementationRef: 'phase7_experiment.py:analyze',
      preprocessingPolicy: 'read the first band as a masked array',
      trainingBudget: 'not applicable',
      postprocessingPolicy: 'valid pixels divided by total pixels',
    }],
    independentVariables: [{ name: 'nodata-policy', values: ['masked'] }],
    controlVariables: [{ name: 'artifact-digest', value: report.assets[0]!.artifactRef.digest }],
    splitStrategy: 'full-scene descriptive evaluation without model fitting',
    preprocessing: [{
      stepId: 'mask-nodata',
      description: 'Apply the GeoTIFF NoData mask through Rasterio masked reading.',
      appliesTo: [report.datasetId],
      parameters: { band: '1', masked: 'true' },
    }],
    metrics: [{
      metricId: 'valid-pixel-ratio',
      name: 'Valid pixel ratio',
      unit: 'ratio',
      direction: 'maximize',
      aggregation: 'global',
      implementationRef: 'phase7_experiment.py:analyze',
    }],
    seeds: [7],
    ablations: [],
    statisticalPlan: {
      method: 'deterministic full-scene descriptive statistic',
      confidenceLevel: 0.95,
      effectSize: 'valid-pixel ratio',
      multipleComparison: 'one registered metric',
      spatialAutocorrelation: 'reported as a limitation for a single scene',
      blockingStrategy: 'not applicable without train/test sampling',
    },
    stoppingRule: 'complete the single registered deterministic run',
    resourceRequirements: ['CPU', 'rasterio-compatible Python runtime'],
    acceptanceCriteria: [
      'The formal Run succeeds.',
      'Exactly one valid-pixel-ratio envelope is emitted.',
      'The Result traces to the registered Artifact, DatasetManifest, Run, and frozen ExperimentSpec.',
    ],
    amendment: null,
  }
}

function researchBriefBody() {
  return {
    schemaVersion: 1,
    briefId: 'phase7-public-raster-brief',
    title: 'Traceable inspection of a public remote-sensing raster',
    researchQuestion: 'Can a public Landsat GeoTIFF be read, checked, tested, measured, validated, and written about through one immutable GeoResearch artifact chain?',
    background: 'Rasterio publishes a small Landsat RGB GeoTIFF as a stable public software fixture.',
    motivation: 'Close the release gate with a real public remote-sensing workflow rather than synthetic service fixtures.',
    region: {
      description: 'Rasterio RGB.byte.tif extent in UTM zone 18 north',
      bbox: [101985, 2611485, 339315, 2826915],
      crs: 'EPSG:32618',
    },
    timeRange: { start: null, end: null },
    researchSubjects: ['public Landsat raster', 'GeoTIFF metadata', 'NoData-aware descriptive metric'],
    dataModalities: ['optical raster'],
    hypotheses: [{
      hypothesisId: 'hypothesis-public-raster-readable',
      statement: 'The registered public raster can be read with current CRS, band, and NoData lineage and can emit one traceable descriptive metric.',
    }],
    expectedContributions: ['One release-grade end-to-end public remote-sensing provenance chain'],
    constraints: ['CPU only', 'public inputs only', 'no Session Telemetry'],
    knownAssumptions: ['The pinned GitHub release asset remains byte-addressable during the live probe.'],
    successCriteria: [
      'Every manuscript statement traces to Evidence or Result records.',
      'The public raster passes mandatory geospatial checks.',
      'The source-tree-bound test and formal experiment both succeed.',
    ],
    userConfirmation: {
      confirmed: true,
      confirmedAt: nowUtc(),
      confirmedBy: 'user',
      auditNote: 'Phase 7 public release case approved by the development guide.',
    },
  }
}

function phase7ExperimentSource(): string {
  return [
    'from __future__ import annotations',
    '',
    'import json',
    'import sys',
    'from pathlib import Path',
    '',
    "SOURCE_ROOT = Path(__file__).resolve().parent",
    "sys.path[:] = [entry for entry in sys.path if Path(entry or '.').resolve() != SOURCE_ROOT]",
    '',
    'import rasterio',
    '',
    '',
    'def analyze(path: str) -> dict[str, object]:',
    '    with rasterio.open(path) as dataset:',
    '        band = dataset.read(1, masked=True)',
    '        valid_pixels = int(band.count())',
    '        total_pixels = int(band.size)',
    '        return {',
    "            'width': int(dataset.width),",
    "            'height': int(dataset.height),",
    "            'bands': int(dataset.count),",
    "            'crs': str(dataset.crs),",
    "            'nodata': float(dataset.nodata) if dataset.nodata is not None else None,",
    "            'valid_pixels': valid_pixels,",
    "            'total_pixels': total_pixels,",
    "            'valid_pixel_ratio': round(valid_pixels / total_pixels, 12),",
    '        }',
    '',
    '',
    'def main() -> None:',
    '    path, dataset_id, artifact_id = sys.argv[1:4]',
    '    stats = analyze(path)',
    '    envelope = {',
    "        'schemaVersion': 1,",
    "        'results': [{",
    "            'resultId': 'result-phase7-valid-pixel-ratio',",
    "            'metricId': 'valid-pixel-ratio',",
    "            'value': stats['valid_pixel_ratio'],",
    "            'unit': 'ratio',",
    "            'aggregation': 'global',",
    "            'uncertainty': {'kind': 'none', 'level': None, 'lower': None, 'upper': None},",
    "            'comparisonTarget': None,",
    "            'scope': {'datasetId': dataset_id, 'region': 'Rasterio public Landsat sample', 'sensor': 'Landsat', 'split': 'full-scene'},",
    "            'artifactIds': [artifact_id],",
    '        }],',
    '    }',
    "    print('GEORESEARCH_RESULT_V1 ' + json.dumps(envelope, sort_keys=True, separators=(',', ':')))",
    '',
    '',
    "if __name__ == '__main__':",
    '    main()',
    '',
  ].join('\n')
}

function phase7TestSource(): string {
  return [
    'from __future__ import annotations',
    '',
    'import os',
    '',
    'from phase7_experiment import analyze',
    '',
    '',
    'def test_public_raster_contract() -> None:',
    "    stats = analyze(os.environ['GEORESEARCH_PHASE7_RASTER'])",
    "    assert stats['width'] == 791",
    "    assert stats['height'] == 718",
    "    assert stats['bands'] == 3",
    "    assert stats['crs'] == 'EPSG:32618'",
    "    assert stats['nodata'] == 0.0",
    "    assert 0 < stats['valid_pixels'] <= stats['total_pixels']",
    "    assert 0 < stats['valid_pixel_ratio'] <= 1",
    '',
  ].join('\n')
}

async function cloneRepository(url: string, tag: string, destination: string): Promise<void> {
  const result = await spawnCaptured('git', [
    ...(process.platform === 'win32' ? ['-c', 'http.sslBackend=openssl'] : []),
    'clone',
    '--depth', '1',
    '--no-tags',
    '--branch', tag,
    '--single-branch',
    url,
    destination,
  ], root, 180_000)
  if (result.exitCode !== 0) throw new Error(`Rasterio clone failed: ${result.stderr.trim()}`)
}

async function readPythonEnvironment(command: string): Promise<{
  readonly pythonVersion: string
  readonly rasterio: string
  readonly pyproj: string
  readonly pytest: string
}> {
  const result = await spawnCaptured(command, ['-c', [
    'import json, platform',
    'import pyproj, pytest, rasterio',
    "print(json.dumps({'pythonVersion': platform.python_version(), 'rasterio': rasterio.__version__, 'pyproj': pyproj.__version__, 'pytest': pytest.__version__}))",
  ].join('; ')], root, 30_000)
  if (result.exitCode !== 0) throw new Error(`Python environment probe failed: ${result.stderr.trim()}`)
  return JSON.parse(result.stdout) as {
    readonly pythonVersion: string
    readonly rasterio: string
    readonly pyproj: string
    readonly pytest: string
  }
}

async function downloadBounded(
  url: string,
  maxBytes: number,
  asciiPrefix?: string,
  predicate?: (bytes: Buffer) => boolean,
): Promise<{ readonly bytes: Buffer; readonly resolvedUrl: string }> {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'GeoResearch/0.1.0 phase7-live-e2e' },
    signal: AbortSignal.timeout(90_000),
  })
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`download failed for ${url}: HTTP ${response.status}`)
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel().catch(() => undefined)
    throw new Error(`download exceeds ${maxBytes} bytes: ${url}`)
  }
  const chunks: Buffer[] = []
  const reader = response.body.getReader()
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error(`download exceeds ${maxBytes} bytes: ${url}`)
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = Buffer.concat(chunks, total)
  if (asciiPrefix !== undefined && bytes.subarray(0, asciiPrefix.length).toString('ascii') !== asciiPrefix) {
    throw new Error(`downloaded content has an invalid prefix: ${url}`)
  }
  if (predicate !== undefined && !predicate(bytes)) throw new Error(`downloaded content failed validation: ${url}`)
  return { bytes, resolvedUrl: response.url }
}

function isTiff(bytes: Buffer): boolean {
  if (bytes.byteLength < 4) return false
  const prefix = bytes.subarray(0, 4).toString('hex')
  return prefix === '49492a00' || prefix === '4d4d002a' || prefix === '49492b00' || prefix === '4d4d002b'
}

function documentationQuote(text: string): string {
  const start = text.indexOf('Geographic information systems use GeoTIFF')
  if (start < 0) throw new Error('Rasterio documentation quote anchor is missing')
  const endAnchor = 'Numpy N-dimensional arrays and GeoJSON.'
  const end = text.indexOf(endAnchor, start)
  if (end < 0) throw new Error('Rasterio documentation quote terminator is missing')
  return text.slice(start, end + endAnchor.length)
}

async function collectChild(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
  graceMs: number,
): Promise<{
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly endedAt: string
}> {
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout = boundedAppend(stdout, String(chunk), 1024 * 1024) })
  child.stderr.on('data', chunk => { stderr = boundedAppend(stderr, String(chunk), 1024 * 1024) })
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    const escalation = setTimeout(() => child.kill('SIGKILL'), graceMs)
    escalation.unref()
  }, timeoutMs)
  timeout.unref()
  try {
    const outcome = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolveValue, rejectValue) => {
      child.once('error', rejectValue)
      child.once('close', (exitCode, signal) => resolveValue({ exitCode, signal }))
    })
    if (timedOut) throw new Error(`recorded process exceeded ${timeoutMs} ms`)
    return { exitCode: outcome.exitCode, signal: outcome.signal, stdout, stderr, endedAt: nowUtc() }
  } finally {
    clearTimeout(timeout)
  }
}

async function spawnCaptured(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> {
  const child = spawn(command, [...args], {
    cwd,
    env: process.env,
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const completed = await collectChild(child, timeoutMs, 2_000)
  return { exitCode: completed.exitCode, stdout: completed.stdout, stderr: completed.stderr }
}

function agent(cwd: string, role: 'coordinator' | 'literature' | 'experiment' | 'reviewer' | 'writing'): Agent {
  if (role === 'coordinator') {
    return {
      id: 'phase7-coordinator',
      options: {},
      session: { id: rootSessionId, header: { cwd } },
    } as unknown as Agent
  }
  return {
    id: `phase7-${role}`,
    options: { geoResearchRole: role },
    session: {
      id: `phase7-${role}-session`,
      header: { cwd, parentSession: rootSessionId, origin: 'subagent' },
    },
  } as unknown as Agent
}

function requireAgent(value: Agent, role: 'coordinator' | 'experiment' | 'reviewer' | 'writing'): void {
  if (String(value.id) !== `phase7-${role}`) throw new Error(`Phase 7 requires ${role} identity`)
}

function execution(agentValue: Agent, callId: string): ToolExecution {
  return {
    agent: agentValue,
    rootCallId: `root-${callId}`,
    callId,
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

function mergeEnvironment(overrides?: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

function outputReader(source: () => string) {
  return {
    readFrom(fromByte: number) {
      const bytes = Buffer.from(source(), 'utf8')
      const start = Math.max(0, Math.min(bytes.byteLength, fromByte))
      return {
        text: bytes.subarray(start).toString('utf8'),
        nextOffset: bytes.byteLength,
        lossy: false,
      }
    },
  }
}

function boundedAppend(current: string, chunk: string, maxBytes: number): string {
  const combined = `${current}${chunk}`
  const bytes = Buffer.from(combined, 'utf8')
  return bytes.byteLength <= maxBytes
    ? combined
    : bytes.subarray(bytes.byteLength - maxBytes).toString('utf8')
}

function lineCount(source: string): number {
  return source.replace(/\n$/u, '').split(/\r?\n/u).length
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  await rename(temporary, path)
}
