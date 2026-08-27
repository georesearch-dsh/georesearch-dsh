import type { ToolExecution } from '@georesearch/dsh-compat-rc5'
import {
  digestJson,
  type RepositoryAudit,
  type ReproductionPlan,
  type ReproductionReportCandidate,
  type ReproductionTestSpecRecord,
  type RunRecord,
} from '@georesearch/dsh-contracts'
import { describe, expect, it, vi } from 'vitest'
import { ReproductionCoordinator, reproductionTools } from '../src/index.js'

describe('Phase 4 reproduction report boundary', () => {
  it('rejects a baseline audit that is not the audit bound to the plan', async () => {
    const planAudit = repositoryAudit('audit-plan', digestJson({ tree: 'plan' }))
    const unrelated = repositoryAudit('audit-unrelated', digestJson({ tree: 'unrelated' }))
    const plan = reproductionPlan(planAudit)
    const run = succeededRun('run-unrelated', unrelated.sourceTreeDigest, digestJson({ arbitrary: true }))
    const fixture = coordinatorFixture({
      audits: [planAudit, unrelated],
      plan,
      runs: [run],
      testSpecs: [],
    })

    await expect(fixture.coordinator.commitReproductionReportCandidate(
      rootExecution(),
      reportCandidate({
        planId: plan.planId,
        baselineAuditId: unrelated.auditId,
        finalAuditId: unrelated.auditId,
        runIds: [run.runId],
        status: 'functionally-reproduced',
      }),
    )).rejects.toMatchObject({ code: 'REPRODUCTION_REPORT_INVALID' })
  })

  it('rejects a succeeded run that is not bound to the plan TestSpecs', async () => {
    const audit = repositoryAudit('audit-plan', digestJson({ tree: 'clean' }))
    const plan = reproductionPlan(audit)
    const run = succeededRun('run-arbitrary', audit.sourceTreeDigest, digestJson({ arbitrary: true }))
    const fixture = coordinatorFixture({ audits: [audit], plan, runs: [run], testSpecs: [] })

    await expect(fixture.coordinator.commitReproductionReportCandidate(
      rootExecution(),
      reportCandidate({
        planId: plan.planId,
        baselineAuditId: audit.auditId,
        finalAuditId: audit.auditId,
        runIds: [run.runId],
        status: 'functionally-reproduced',
      }),
    )).rejects.toMatchObject({ code: 'REPRODUCTION_REPORT_INVALID' })
  })

  it('rejects exactly-reproduced after the audited source tree changed', async () => {
    const baseline = repositoryAudit('audit-baseline', digestJson({ tree: 'baseline' }))
    const final = repositoryAudit('audit-final', digestJson({ tree: 'modified' }))
    const plan = reproductionPlan(baseline)
    const spec = reproductionTestSpec(plan, final)
    const run = succeededRun('run-modified', final.sourceTreeDigest, spec.specDigest)
    const fixture = coordinatorFixture({ audits: [baseline, final], plan, runs: [run], testSpecs: [spec] })

    await expect(fixture.coordinator.commitReproductionReportCandidate(
      rootExecution(),
      reportCandidate({
        planId: plan.planId,
        baselineAuditId: baseline.auditId,
        finalAuditId: final.auditId,
        runIds: [run.runId],
        status: 'exactly-reproduced',
      }),
    )).rejects.toMatchObject({ code: 'REPRODUCTION_BASELINE_MODIFIED' })
  })

  it('rejects a success claim stronger than the declared plan scope', async () => {
    const audit = repositoryAudit('audit-plan', digestJson({ tree: 'clean' }))
    const plan = { ...reproductionPlan(audit), scope: 'partial' as const }
    const planBody = { ...plan }
    delete (planBody as Partial<ReproductionPlan>).digest
    const scopedPlan = { ...planBody, digest: digestJson(planBody) } as ReproductionPlan
    const spec = reproductionTestSpec(scopedPlan, audit)
    const run = succeededRun('run-partial', audit.sourceTreeDigest, spec.specDigest)
    const fixture = coordinatorFixture({ audits: [audit], plan: scopedPlan, runs: [run], testSpecs: [spec] })

    await expect(fixture.coordinator.commitReproductionReportCandidate(
      rootExecution(),
      reportCandidate({
        planId: scopedPlan.planId,
        baselineAuditId: audit.auditId,
        finalAuditId: audit.auditId,
        runIds: [run.runId],
        status: 'exactly-reproduced',
      }),
    )).rejects.toMatchObject({ code: 'REPRODUCTION_REPORT_INVALID' })
  })

  it('commits a diagnosed missing-data report as a reviewer-readable JSON Artifact', async () => {
    const audit = repositoryAudit('audit-plan', digestJson({ tree: 'clean' }))
    const basePlan = reproductionPlan(audit)
    const planBody = {
      ...basePlan,
      missingMaterials: ['private pretraining corpus'],
      blockers: [{ code: 'DATASET_NOT_PUBLIC', message: 'The dataset is unavailable.', retryable: false }],
    }
    delete (planBody as Partial<ReproductionPlan>).digest
    const plan = { ...planBody, digest: digestJson(planBody) } as ReproductionPlan
    const fixture = coordinatorFixture({ audits: [audit], plan, runs: [], testSpecs: [] })
    const candidate = reportCandidate({
      planId: plan.planId,
      baselineAuditId: audit.auditId,
      finalAuditId: audit.auditId,
      runIds: [],
      status: 'blocked-by-missing-data',
      diagnostics: [{
        code: 'DATASET_NOT_PUBLIC',
        message: 'The required pretraining corpus is not distributed with the repository.',
        relatedRunIds: [],
        relatedArtifactIds: [],
      }],
    })

    const report = await fixture.coordinator.commitReproductionReportCandidate(rootExecution(), candidate)

    expect(report).toMatchObject({
      status: 'blocked-by-missing-data',
      reviewStatus: 'pending',
      reportArtifact: {
        artifactId: 'artifact-report',
        kind: 'reproduction-report',
      },
    })
    expect(fixture.host.requireRootCoordinator).toHaveBeenCalledOnce()
    expect(fixture.generatedDocument).toMatchObject({
      kind: 'reproduction-report',
      planId: plan.planId,
      status: 'blocked-by-missing-data',
    })
    expect(fixture.committedReport()).toEqual(report)
  })

  it('rejects metric results that rewrite the expected value or unit from the plan', async () => {
    const audit = repositoryAudit('audit-plan', digestJson({ tree: 'clean' }))
    const basePlan = reproductionPlan(audit)
    const planBody = {
      ...basePlan,
      targetResults: [{
        resultId: 'accuracy',
        description: 'Validation accuracy.',
        metric: 'accuracy',
        expectedValue: '0.90',
        unit: 'fraction',
        evidenceId: null,
      }],
    }
    delete (planBody as Partial<ReproductionPlan>).digest
    const plan = { ...planBody, digest: digestJson(planBody) } as ReproductionPlan
    const spec = reproductionTestSpec(plan, audit)
    const run = succeededRun('run-metric', audit.sourceTreeDigest, spec.specDigest)
    const fixture = coordinatorFixture({ audits: [audit], plan, runs: [run], testSpecs: [spec] })

    await expect(fixture.coordinator.commitReproductionReportCandidate(
      rootExecution(),
      reportCandidate({
        planId: plan.planId,
        baselineAuditId: audit.auditId,
        finalAuditId: audit.auditId,
        runIds: [run.runId],
        status: 'metric-equivalent',
        metricResults: [{
          resultId: 'accuracy',
          expectedValue: '0.95',
          observedValue: '0.90',
          unit: 'percent',
          comparison: 'within-tolerance',
        }],
      }),
    )).rejects.toMatchObject({ code: 'REPRODUCTION_REPORT_INVALID' })
  })

  it('exposes only Experiment candidate tools at the model boundary', () => {
    expect(reproductionTools({} as never).map(tool => tool.name)).toEqual([
      'repository_audit',
      'reproduction_plan_candidate',
      'test_spec_candidate',
    ])
  })
})

interface FixtureInput {
  readonly audits: readonly RepositoryAudit[]
  readonly plan: ReproductionPlan
  readonly runs: readonly RunRecord[]
  readonly testSpecs: readonly ReproductionTestSpecRecord[]
}

function coordinatorFixture(input: FixtureInput) {
  let committed: unknown
  const generatedDocument: Record<string, unknown> = {}
  const state = {
    projectId: 'project-1',
    generation: 7,
    state: {
      sources: {},
      evidence: {},
      repositoryAudits: Object.fromEntries(input.audits.map(audit => [audit.auditId, audit])),
      reproductionPlans: { [input.plan.planId]: input.plan },
      reproductionTestSpecs: Object.fromEntries(input.testSpecs.map(spec => [spec.spec.testSpecId, spec])),
      reproductionReports: {},
      runs: Object.fromEntries(input.runs.map(run => [run.runId, run])),
      artifacts: {},
    },
  }
  const projects = {
    resolveAgent: vi.fn(async () => ({
      stateFile: state,
      binding: { workspaceId: 'workspace-1', bindingVersion: 1 },
      workspace: { canonicalPath: 'D:/workspace' },
    })),
    loadProject: vi.fn(async () => state),
    commitRepositoryAudit: vi.fn(),
    commitReproductionPlan: vi.fn(),
    commitGeneratedArtifact: vi.fn(async (_agent, request) => {
      const chunks: Uint8Array[] = []
      for await (const chunk of request.source) chunks.push(chunk)
      Object.assign(generatedDocument, JSON.parse(Buffer.concat(chunks).toString('utf8')))
      return {
        projectId: 'project-1',
        workspaceId: 'workspace-1',
        generation: 8,
        artifact: {
          schemaVersion: 1,
          artifactId: 'artifact-report',
          digest: digestJson(generatedDocument),
          kind: 'reproduction-report',
          size: Buffer.byteLength(JSON.stringify(generatedDocument)),
          mediaType: 'application/json',
          workspaceId: 'workspace-1',
          materialization: 'committed',
          integrity: 'verified',
          validity: 'current',
          objectPath: 'objects/report.json',
          lineage: {
            inputDigests: request.inputDigests ?? [],
            transformationType: request.transformationType,
            outputDigest: digestJson(generatedDocument),
          },
          committedAt: '2026-08-18T00:00:10.000Z',
        },
      }
    }),
    commitReproductionReport: vi.fn(async (_projectId, request) => {
      committed = request.reproductionReport
      return state
    }),
  }
  const host = {
    requireExperiment: vi.fn(),
    requireRootCoordinator: vi.fn(),
  }
  return {
    coordinator: new ReproductionCoordinator({
      projects: projects as never,
      runs: { testSpecCandidate: vi.fn() } as never,
      repository: {} as never,
      host,
    }, () => '2026-08-18T00:00:10.000Z'),
    host,
    generatedDocument,
    committedReport: () => committed,
  }
}

function repositoryAudit(auditId: string, sourceTreeDigest: `sha256:${string}`): RepositoryAudit {
  const body = {
    schemaVersion: 1 as const,
    auditId,
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    workspaceBindingVersion: 1,
    sourceId: 'source-1',
    sourceDigest: digestJson({ source: 1 }),
    repository: {
      capability: {
        providerId: 'git-cli' as const,
        providerVersion: '1.0.0',
        shell: false as const,
        readOnlyCommands: true as const,
        maxFiles: 20_000,
        maxChanges: 2_000,
        maxHashedBytes: 268_435_456,
      },
      canonicalRoot: 'D:/workspace',
      gitDir: 'D:/workspace/.git',
      gitCommonDir: 'D:/workspace/.git',
      remoteUrl: 'https://github.com/example/repository.git',
      headCommit: 'a'.repeat(40),
      branch: 'main',
      detached: false,
      tags: [],
      targetRef: 'HEAD',
      targetCommit: 'a'.repeat(40),
      targetMatchesHead: true,
      dirty: sourceTreeDigest !== digestJson({ tree: 'clean' }),
      changes: [],
    },
    sourceTreeDigest,
    languages: [{ language: 'Python', fileCount: 1 }],
    buildSystems: [{ name: 'Python packaging', manifestPaths: ['pyproject.toml'] }],
    entryPoints: ['train.py'],
    configurationFiles: ['pyproject.toml'],
    dataDependencyPaths: ['data'],
    environmentFiles: ['pyproject.toml'],
    testPaths: ['tests'],
    methodCodeDeltas: [],
    blockers: [],
    auditedAt: '2026-08-18T00:00:00.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

function reproductionPlan(audit: RepositoryAudit): ReproductionPlan {
  const body = {
    schemaVersion: 1 as const,
    planId: 'plan-1',
    sourceId: audit.sourceId,
    repositoryAuditId: audit.auditId,
    targetRepository: { remoteUrl: audit.repository.remoteUrl, commit: audit.repository.targetCommit as string },
    targetData: [],
    targetResults: [],
    scope: 'exact' as const,
    environmentRequirements: ['Python'],
    missingMaterials: [],
    steps: [{ stepId: 'test', kind: 'test' as const, description: 'Run tests.', expectedOutputs: ['result'] }],
    expectedOutputs: ['result'],
    tolerances: [],
    blockers: [],
    projectId: audit.projectId,
    workspaceId: audit.workspaceId,
    workspaceBindingVersion: audit.workspaceBindingVersion,
    repositoryAuditDigest: audit.digest,
    sourceTreeDigest: audit.sourceTreeDigest,
    status: 'candidate' as const,
    createdAt: '2026-08-18T00:00:01.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

function reproductionTestSpec(plan: ReproductionPlan, audit: RepositoryAudit): ReproductionTestSpecRecord {
  const spec = {
    schemaVersion: 1 as const,
    testSpecId: 'phase4-test',
    runner: 'pytest' as const,
    argv: ['python', '-m', 'pytest'],
    cwdRelative: '.',
    timeoutMs: 30_000,
    graceMs: 1_000,
    environment: {},
  }
  const body = {
    schemaVersion: 1 as const,
    projectId: plan.projectId,
    workspaceId: plan.workspaceId,
    workspaceBindingVersion: plan.workspaceBindingVersion,
    planId: plan.planId,
    repositoryAuditId: audit.auditId,
    sourceTreeDigest: audit.sourceTreeDigest,
    spec,
    specDigest: digestJson(spec),
    registeredAt: '2026-08-18T00:00:02.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

function succeededRun(
  runId: string,
  sourceTreeDigest: `sha256:${string}`,
  experimentSpecDigest: `sha256:${string}`,
): RunRecord {
  const argv = ['python', '-m', 'pytest']
  return {
    schemaVersion: 1,
    runId,
    kind: 'local-test',
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    workspaceBindingVersion: 1,
    experimentSpecDigest,
    sourceTreeDigest,
    environmentDigest: digestJson({}),
    datasetDigests: [],
    argv,
    argvDigest: digestJson(argv),
    cwd: { canonicalPath: 'D:/workspace', volumeIdentity: 'volume', fileIdentity: 'file' },
    state: 'succeeded',
    launchId: `launch-${runId}`,
    resourceLimits: { timeoutMs: 30_000, graceMs: 1_000, stdoutMaxBytes: 1024, stderrMaxBytes: 1024 },
    stdoutPath: `runs/${runId}/stdout.log`,
    stderrPath: `runs/${runId}/stderr.log`,
    startedAt: '2026-08-18T00:00:03.000Z',
    endedAt: '2026-08-18T00:00:04.000Z',
    exitCode: 0,
    sandbox: { mode: 'workspace-write', enforcement: 'partial' },
    outputArtifactRefs: [],
  }
}

function reportCandidate(overrides: Partial<ReproductionReportCandidate>): ReproductionReportCandidate {
  return {
    schemaVersion: 1,
    kind: 'reproduction-report',
    planId: 'plan-1',
    baselineAuditId: 'audit-plan',
    finalAuditId: 'audit-plan',
    runIds: [],
    status: 'blocked-by-environment',
    metricResults: [],
    paperDescription: 'The paper describes the target method.',
    officialCodeBehavior: 'The official code behavior was audited.',
    localImplementationAndEnvironment: 'The bound local environment was inspected.',
    necessaryModifications: [],
    resultDifferences: [],
    differenceSources: [],
    unresolvedDetails: [],
    diagnostics: [{
      code: 'ENVIRONMENT_UNAVAILABLE',
      message: 'The required runtime is unavailable.',
      relatedRunIds: [],
      relatedArtifactIds: [],
    }],
    limitations: [],
    ...overrides,
  }
}

function rootExecution(): ToolExecution {
  return {
    agent: { id: 'root-coordinator', session: { id: 'root-session' } },
    rootCallId: 'phase4-report',
    callId: 'phase4-report',
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}
