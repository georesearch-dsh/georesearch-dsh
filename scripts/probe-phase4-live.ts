import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent, ToolExecution } from '@georesearch/dsh-compat-rc5'
import {
  digestJson,
  digestPhase3Body,
  nowUtc,
  type ReproductionReportCandidate,
  type SourceRecord,
} from '@georesearch/dsh-contracts'
import { ProjectCoordinator } from '../packages/project-service/lib/index.js'
import { GitRepositoryProvider } from '../packages/repository-providers/lib/index.js'
import {
  ReproductionCoordinator,
  type ReproductionHostPort,
} from '../packages/reproduction-service/lib/index.js'

class LiveHost implements ReproductionHostPort {
  requireExperiment(agent: Agent): void {
    if (String(agent.id) !== 'phase4-experiment') throw new Error('Phase 4 live candidate did not use Experiment identity')
  }

  requireRootCoordinator(agent: Agent): void {
    if (String(agent.id) !== 'phase4-coordinator') throw new Error('Phase 4 live report did not use root Coordinator identity')
  }
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const reportPath = resolve(root, 'dist', 'reports', 'phase4-live-activation.json')
const repositoryUrl = 'https://github.com/google-research/bert.git'
const temporaryRoot = await mkdtemp(join(tmpdir(), 'georesearch-phase4-live-'))
const repositoryRoot = join(temporaryRoot, 'bert')
const home = join(temporaryRoot, 'home')
const provider = new GitRepositoryProvider({ timeoutMs: 60_000 })
let providerDrained = false
let providerDisposed = false
let temporaryStateRemoved = false
let liveReport: Record<string, unknown> | undefined

try {
  await cloneRepository(repositoryUrl, repositoryRoot)
  const readme = await readBoundedText(join(repositoryRoot, 'README.md'), 2 * 1024 * 1024)
  const tensorflowRequirement = findLine(readme, /tensorflow.*1\.[0-9]+/iu)
    ?? findLine(readme, /tensorflow/iu)
  const pretrainedInstruction = findLine(readme, /pre-?trained.*(?:download|model)|download.*pre-?trained/iu)
  const expectedCheckpointFiles = [
    'uncased_L-12_H-768_A-12/bert_config.json',
    'uncased_L-12_H-768_A-12/bert_model.ckpt.index',
    'uncased_L-12_H-768_A-12/vocab.txt',
  ]
  const missingCheckpointFiles = []
  for (const path of expectedCheckpointFiles) {
    if (!await fileExists(join(repositoryRoot, ...path.split('/')))) missingCheckpointFiles.push(path)
  }
  if (missingCheckpointFiles.length === 0) {
    throw new Error('Phase 4 live fixture unexpectedly contains the external BERT checkpoint')
  }
  const tensorflow = await probeTensorFlow()

  const projects = new ProjectCoordinator({ home })
  const coordinatorAgent = rootAgent(repositoryRoot, 'phase4-root')
  const experimentAgent = childAgent(repositoryRoot, 'phase4-root', 'experiment')
  const reviewerAgent = childAgent(repositoryRoot, 'phase4-root', 'reviewer')
  const attached = await projects.resolveAgent(coordinatorAgent, { attachIfMissing: true })
  const source = bertSourceRecord(repositoryUrl)
  await projects.commitSourceRecord(attached.stateFile.projectId, {
    expectedGeneration: 1,
    operationKey: digestJson({ operation: 'phase4-live-source' }),
    requestDigest: digestJson({ source }),
    source,
  })

  const reproduction = new ReproductionCoordinator({
    projects,
    runs: {
      async testSpecCandidate() {
        throw new Error('Phase 4 live blocked diagnosis must not register a TestSpec')
      },
    },
    repository: provider,
    host: new LiveHost(),
  })
  const audit = await reproduction.repositoryAudit(
    execution(experimentAgent, 'phase4-live-audit'),
    { sourceId: source.sourceId, targetRef: 'HEAD', methodCodeDeltas: [] },
  )
  if (audit.repository.targetCommit === null || audit.repository.remoteUrl === null
    || audit.repository.dirty || !audit.repository.targetMatchesHead) {
    throw new Error('Phase 4 live repository audit did not produce a clean exact target')
  }

  const blockers = [{
    code: 'PRETRAINED_CHECKPOINT_NOT_MATERIALIZED',
    message: `The clean repository lacks ${missingCheckpointFiles.join(', ')}.`,
    retryable: true,
  }]
  if (!tensorflow.compatibleOneX) {
    blockers.push({
      code: 'TENSORFLOW_1X_UNAVAILABLE',
      message: tensorflow.message,
      retryable: true,
    })
  }
  const plan = await reproduction.reproductionPlanCandidate(
    execution(experimentAgent, 'phase4-live-plan'),
    {
      schemaVersion: 1,
      planId: 'bert-base-public-checkpoint-reproduction',
      sourceId: source.sourceId,
      repositoryAuditId: audit.auditId,
      targetRepository: {
        remoteUrl: audit.repository.remoteUrl,
        commit: audit.repository.targetCommit,
      },
      targetData: ['BERT-Base Uncased pre-trained checkpoint'],
      targetResults: [{
        resultId: 'bert-base-checkpoint-materialized',
        description: 'Official BERT-Base configuration, checkpoint index, and vocabulary are present.',
        metric: 'required-artifact-presence',
        expectedValue: '3/3',
        unit: 'files',
        evidenceId: null,
      }],
      scope: 'exact',
      environmentRequirements: [tensorflowRequirement ?? 'TensorFlow 1.x compatible runtime'],
      missingMaterials: missingCheckpointFiles,
      steps: [
        {
          stepId: 'inspect-repository',
          kind: 'inspect',
          description: 'Audit the clean official repository and exact target commit.',
          expectedOutputs: ['RepositoryAudit'],
        },
        {
          stepId: 'materialize-checkpoint',
          kind: 'inspect',
          description: 'Materialize and hash the official BERT-Base checkpoint files.',
          expectedOutputs: expectedCheckpointFiles,
        },
        {
          stepId: 'verify-environment',
          kind: 'inspect',
          description: 'Verify a compatible TensorFlow 1.x runtime before any repository code is executed.',
          expectedOutputs: ['environment diagnosis'],
        },
        {
          stepId: 'run-registered-test',
          kind: 'test',
          description: 'Register a bounded TestSpec only after the data and runtime blockers are cleared.',
          expectedOutputs: ['source-tree-bound RunRecord'],
        },
      ],
      expectedOutputs: ['checkpoint digest manifest', 'environment record', 'source-tree-bound RunRecord'],
      tolerances: [{ resultId: 'bert-base-checkpoint-materialized', absolute: 0, relative: null }],
      blockers,
    },
  )

  const finalAudit = await reproduction.repositoryAudit(
    execution(experimentAgent, 'phase4-live-final-audit'),
    { sourceId: source.sourceId, targetRef: 'HEAD', methodCodeDeltas: [] },
  )
  if (finalAudit.digest !== audit.digest) {
    throw new Error('Phase 4 live repository changed during the blocked diagnosis')
  }
  const diagnostics = [{
    code: 'PRETRAINED_CHECKPOINT_NOT_MATERIALIZED',
    message: [
      `Missing required files: ${missingCheckpointFiles.join(', ')}.`,
      pretrainedInstruction === undefined ? '' : `Repository instruction: ${pretrainedInstruction}`,
    ].filter(Boolean).join(' '),
    relatedRunIds: [],
    relatedArtifactIds: [],
  }]
  if (!tensorflow.compatibleOneX) {
    diagnostics.push({
      code: 'TENSORFLOW_1X_UNAVAILABLE',
      message: tensorflow.message,
      relatedRunIds: [],
      relatedArtifactIds: [],
    })
  }
  const candidate: ReproductionReportCandidate = {
    schemaVersion: 1,
    kind: 'reproduction-report',
    planId: plan.planId,
    baselineAuditId: audit.auditId,
    finalAuditId: finalAudit.auditId,
    runIds: [],
    status: 'blocked-by-missing-data',
    metricResults: [{
      resultId: 'bert-base-checkpoint-materialized',
      expectedValue: '3/3',
      observedValue: `${expectedCheckpointFiles.length - missingCheckpointFiles.length}/3`,
      unit: 'files',
      comparison: 'unavailable',
    }],
    paperDescription: 'BERT reproduction requires the trained model artifacts and the original TensorFlow-era environment.',
    officialCodeBehavior: [
      'The clean official repository contains model and task code but not the selected BERT-Base checkpoint files.',
      pretrainedInstruction ?? 'The README directs users to obtain pre-trained models separately.',
    ].join(' '),
    localImplementationAndEnvironment: [
      `No repository code was executed. Git commit ${audit.repository.targetCommit} was audited read-only.`,
      tensorflow.message,
    ].join(' '),
    necessaryModifications: [],
    resultDifferences: [`${missingCheckpointFiles.length} of 3 required checkpoint files are absent.`],
    differenceSources: [
      'The Git repository and the externally distributed pre-trained model are separate materials.',
      ...(tensorflow.compatibleOneX ? [] : ['The current Python environment does not expose a compatible TensorFlow 1.x package.']),
    ],
    unresolvedDetails: ['No substitute checkpoint or TensorFlow compatibility shim was accepted as the official baseline.'],
    diagnostics,
    limitations: ['This gate verifies a grounded failure diagnosis; it does not download model weights or execute BERT.'],
  }
  const report = await reproduction.commitReproductionReportCandidate(
    execution(coordinatorAgent, 'phase4-live-report-commit'),
    candidate,
  )
  const reviewerRead = await projects.readArtifactForTool(reviewerAgent, report.reportArtifact.artifactId)
  if (reviewerRead.contentStatus !== 'included' || reviewerRead.content === undefined) {
    throw new Error(`Reviewer could not read the report Artifact: ${reviewerRead.contentStatus}`)
  }
  const reviewerDocument = JSON.parse(reviewerRead.content.text) as Record<string, unknown>
  if (reviewerDocument.reportId !== report.reportId
    || reviewerDocument.status !== 'blocked-by-missing-data'
    || reviewerDocument.planId !== plan.planId) {
    throw new Error('Reviewer report Artifact does not match the committed ReproductionReport')
  }

  const finalProject = await projects.loadProject(attached.stateFile.projectId)
  liveReport = {
    schemaVersion: 1,
    phase: 'phase4-live-public-repository',
    checkedAt: nowUtc(),
    repository: {
      url: repositoryUrl,
      commit: audit.repository.targetCommit,
      sourceTreeDigest: audit.sourceTreeDigest,
      clean: !audit.repository.dirty,
      targetMatchesHead: audit.repository.targetMatchesHead,
      languages: audit.languages,
      buildSystems: audit.buildSystems,
      entryPoints: audit.entryPoints,
      testPaths: audit.testPaths,
    },
    grounding: {
      tensorflowRequirement: tensorflowRequirement ?? null,
      pretrainedInstruction: pretrainedInstruction ?? null,
      expectedCheckpointFiles,
      missingCheckpointFiles,
      tensorflow,
    },
    project: {
      projectId: finalProject.projectId,
      finalGeneration: finalProject.generation,
      repositoryAuditId: audit.auditId,
      reproductionPlanId: plan.planId,
      reproductionReportId: report.reportId,
      reportArtifactId: report.reportArtifact.artifactId,
      reportArtifactDigest: report.reportArtifact.digest,
    },
    handoff: {
      sourceRegistered: true,
      experimentAuditAndPlan: true,
      rootCoordinatorCommit: true,
      reviewerArtifactRead: true,
    },
    outcome: {
      status: report.status,
      diagnostics: report.diagnostics,
      runsExecuted: report.runIds.length,
      repositoryCodeExecuted: false,
    },
    checks: {
      publicRepositoryCloned: true,
      exactCommitAudited: true,
      readOnlyProvider: audit.repository.capability.shell === false
        && audit.repository.capability.readOnlyCommands === true,
      sourceTreeStable: finalAudit.digest === audit.digest,
      missingDataVerified: missingCheckpointFiles.length > 0,
      noArbitraryExecution: true,
      reportCommittedByRoot: true,
      reviewerReadVerified: true,
      blockedDiagnosisPreserved: report.status === 'blocked-by-missing-data',
    },
  }
} finally {
  try {
    await provider.drain()
    providerDrained = true
  } finally {
    try {
      await provider.dispose()
      providerDisposed = true
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
      temporaryStateRemoved = true
    }
  }
}

if (liveReport === undefined) throw new Error('Phase 4 live activation did not produce a report')
const finalReport = {
  ...liveReport,
  lifecycle: { providerDrained, providerDisposed, temporaryStateRemoved },
}
await atomicWriteJson(reportPath, finalReport)
process.stdout.write(`${JSON.stringify({
  reportPath,
  repository: repositoryUrl,
  status: (liveReport.outcome as Record<string, unknown>).status,
  reviewerReadVerified: true,
}, undefined, 2)}\n`)

function bertSourceRecord(codeUrl: string): SourceRecord {
  const body = {
    schemaVersion: 1 as const,
    sourceId: 'bert-arxiv-1810.04805',
    title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding',
    authors: [
      { name: 'Jacob Devlin', orcid: null },
      { name: 'Ming-Wei Chang', orcid: null },
      { name: 'Kenton Lee', orcid: null },
      { name: 'Kristina Toutanova', orcid: null },
    ],
    year: 2018,
    venue: 'arXiv',
    stableIdentifier: { kind: 'other' as const, value: 'arXiv:1810.04805' },
    sourceType: 'preprint',
    versionRelation: { kind: 'none' as const, relatedIdentifier: null },
    retrievedAt: nowUtc(),
    providerTrace: {
      providerId: 'phase4-live-source',
      providerVersion: '1.0.0',
      retrievedAt: nowUtc(),
      credentialRef: null,
      credentialBindingEpoch: 0,
      requestId: null,
    },
    codeRefs: [{ url: codeUrl, label: 'official repository' }],
    dataRefs: [{
      url: 'https://github.com/google-research/bert/blob/master/README.md',
      label: 'official pre-trained model instructions',
    }],
    status: 'resolved' as const,
    searchChain: {
      chainId: 'phase4-live-manual-source',
      generation: 1,
      providerItemId: 'arXiv:1810.04805',
    },
  }
  return { ...body, digest: digestPhase3Body(body) }
}

function rootAgent(cwd: string, sessionId: string): Agent {
  return {
    id: 'phase4-coordinator',
    options: {},
    session: { id: sessionId, header: { cwd } },
  } as unknown as Agent
}

function childAgent(cwd: string, rootSessionId: string, role: 'experiment' | 'reviewer'): Agent {
  return {
    id: `phase4-${role}`,
    options: { geoResearchRole: role },
    session: {
      id: `phase4-${role}-session`,
      header: { cwd, parentSession: rootSessionId, origin: 'subagent' },
    },
  } as unknown as Agent
}

function execution(agent: Agent, callId: string): ToolExecution {
  return {
    agent,
    rootCallId: callId,
    callId,
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

async function cloneRepository(url: string, destination: string): Promise<void> {
  const tlsBackend = process.platform === 'win32' ? ['-c', 'http.sslBackend=openssl'] : []
  const result = await spawnCaptured(
    'git',
    [...tlsBackend, 'clone', '--depth', '1', '--no-tags', url, destination],
    root,
    180_000,
  )
  if (result.code !== 0) throw new Error(`BERT repository clone failed: ${result.stderr.trim()}`)
}

async function probeTensorFlow(): Promise<{
  readonly pythonAvailable: boolean
  readonly pipShowExitCode: number | null
  readonly version: string | null
  readonly compatibleOneX: boolean
  readonly message: string
}> {
  try {
    const result = await spawnCaptured('python', ['-m', 'pip', 'show', 'tensorflow'], root, 30_000)
    const version = /^Version:\s*(.+)$/imu.exec(result.stdout)?.[1]?.trim() ?? null
    const compatibleOneX = version !== null && /^1\./u.test(version)
    return {
      pythonAvailable: true,
      pipShowExitCode: result.code,
      version,
      compatibleOneX,
      message: compatibleOneX
        ? `TensorFlow ${version} is installed; checkpoint materialization remains blocked.`
        : version === null
          ? 'python -m pip show tensorflow found no installed TensorFlow package.'
          : `TensorFlow ${version} is installed, not the repository's TensorFlow 1.x baseline.`,
    }
  } catch (error) {
    return {
      pythonAvailable: false,
      pipShowExitCode: null,
      version: null,
      compatibleOneX: false,
      message: `Python environment inspection failed: ${errorMessage(error)}`,
    }
  }
}

async function spawnCaptured(
  command: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error?: unknown, code?: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      error === undefined
        ? resolveRun({ code: code ?? 1, stdout, stderr })
        : rejectRun(error)
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout = boundedAppend(stdout, String(chunk)) })
    child.stderr.on('data', chunk => { stderr = boundedAppend(stderr, String(chunk)) })
    child.once('error', error => finish(error))
    child.once('close', code => finish(undefined, code ?? 1))
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`${command} exceeded ${timeoutMs} ms`))
    }, timeoutMs)
    timeout.unref()
  })
}

async function readBoundedText(path: string, maxBytes: number): Promise<string> {
  const info = await stat(path)
  if (!info.isFile() || info.size > maxBytes) throw new Error(`bounded text input is invalid: ${path}`)
  return await readFile(path, 'utf8')
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function findLine(source: string, pattern: RegExp): string | undefined {
  return source.split(/\r?\n/u).map(line => line.trim()).find(line => pattern.test(line))?.slice(0, 500)
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

function boundedAppend(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-256 * 1024)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
