import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  REPOSITORY_AUDIT_SCHEMA,
  REPRODUCTION_PLAN_SCHEMA,
  REPRODUCTION_REPORT_CANDIDATE_SCHEMA,
  REPRODUCTION_REPORT_SCHEMA,
  REPRODUCTION_TEST_SPEC_SCHEMA,
  digestJson,
  parseRepositoryAudit,
  parseReproductionPlanBody,
  parseReproductionReport,
  parseReproductionReportCandidate,
  parseReproductionTestSpecRecord,
  type RepositoryAudit,
  type ReproductionPlanBody,
  type ReproductionReport,
  type ReproductionReportCandidate,
  type ReproductionTestSpecRecord,
} from '../src/index.js'

const schemaCases = [
  ['repository-audit.schema.json', 'GeoResearch Repository Audit', REPOSITORY_AUDIT_SCHEMA],
  ['reproduction-plan.schema.json', 'GeoResearch Reproduction Plan', REPRODUCTION_PLAN_SCHEMA],
  ['reproduction-test-spec.schema.json', 'GeoResearch Reproduction TestSpec', REPRODUCTION_TEST_SPEC_SCHEMA],
  [
    'reproduction-report-candidate.schema.json',
    'GeoResearch Reproduction Report Candidate',
    REPRODUCTION_REPORT_CANDIDATE_SCHEMA,
  ],
  ['reproduction-report.schema.json', 'GeoResearch Reproduction Report', REPRODUCTION_REPORT_SCHEMA],
] as const

describe('Phase 4 frozen contracts', () => {
  it.each(schemaCases)('keeps %s in runtime parity', async (file, title, runtime) => {
    const bundled = JSON.parse(await readFile(resolve(
      import.meta.dirname,
      '..',
      '..',
      'bundle',
      'schemas',
      file,
    ), 'utf8')) as Record<string, unknown>
    const { $schema, $id, title: bundledTitle, ...schema } = bundled
    expect($schema).toBe('https://json-schema.org/draft/2020-12/schema')
    expect($id).toBe(`https://georesearch.local/schemas/${file}`)
    expect(bundledTitle).toBe(title)
    expect(schema).toEqual(runtime)
  })

  it('parses a strict RepositoryAudit and rejects ungrounded structure', () => {
    const audit = repositoryAudit()
    expect(parseRepositoryAudit(audit)).toEqual(audit)
    expect(() => parseRepositoryAudit({ ...audit, unexpected: true })).toThrow(/unsupported fields/u)
    expect(() => parseRepositoryAudit({
      ...audit,
      repository: { ...audit.repository, tags: ['v1', 'v1'] },
    })).toThrow(/must be unique/u)
    expect(() => parseRepositoryAudit({
      ...audit,
      methodCodeDeltas: [{
        ...audit.methodCodeDeltas[0],
        codeLocator: { ...audit.methodCodeDeltas[0]?.codeLocator, path: '../escape.ts' },
      }],
    })).toThrow(/inside the repository/u)
  })

  it('enforces plan result, tolerance, and step references', () => {
    const body = reproductionPlanBody()
    expect(parseReproductionPlanBody(body)).toEqual(body)
    expect(() => parseReproductionPlanBody({
      ...body,
      tolerances: [{ resultId: 'unknown', absolute: 0.1, relative: null }],
    })).toThrow(/unknown resultId/u)
    expect(() => parseReproductionPlanBody({
      ...body,
      tolerances: [{ resultId: 'accuracy', absolute: null, relative: null }],
    })).toThrow(/requires absolute or relative/u)
    expect(() => parseReproductionPlanBody({ ...body, steps: [] })).toThrow(/must not be empty/u)
  })

  it('parses Project-bound TestSpecs but leaves dynamic smoke rejection to the Host', () => {
    const record = reproductionTestSpec()
    expect(parseReproductionTestSpecRecord(record)).toEqual(record)
    expect(parseReproductionTestSpecRecord({
      ...record,
      spec: { ...record.spec, runner: 'smoke' },
    }).spec.runner).toBe('smoke')
    expect(() => parseReproductionTestSpecRecord({
      ...record,
      spec: { ...record.spec, cwdRelative: '../outside' },
    })).toThrow(/inside the repository/u)
  })

  it('keeps report candidates strict and report records reviewer-addressable', () => {
    const candidate = reproductionReportCandidate()
    expect(parseReproductionReportCandidate(candidate)).toEqual(candidate)
    expect(() => parseReproductionReportCandidate({
      ...candidate,
      runIds: ['run-1', 'run-1'],
    })).toThrow(/must be unique/u)
    expect(() => parseReproductionReportCandidate({
      ...candidate,
      necessaryModifications: [{ path: '../outside.py', description: 'change', reason: 'test' }],
    })).toThrow(/inside the repository/u)

    const body = {
      ...candidate,
      reportId: 'report-1',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      workspaceBindingVersion: 1,
      planDigest: digestJson({ plan: 1 }),
      baselineAuditDigest: digestJson({ audit: 'baseline' }),
      finalAuditDigest: digestJson({ audit: 'final' }),
      reportArtifact: {
        artifactId: 'artifact-report',
        digest: digestJson({ artifact: 'report' }),
        kind: 'reproduction-report',
      },
      reviewStatus: 'pending' as const,
      committedAt: '2026-08-18T00:00:05.000Z',
    }
    const report: ReproductionReport = { ...body, digest: digestJson(body) }
    expect(parseReproductionReport(report)).toEqual(report)
    expect(parseReproductionReport({ ...report, reviewStatus: 'accepted' })).toMatchObject({
      reviewStatus: 'accepted',
      digest: report.digest,
    })
  })
})

function repositoryAudit(): RepositoryAudit {
  const body = {
    schemaVersion: 1 as const,
    auditId: 'audit-1',
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
      tags: ['v1'],
      targetRef: 'v1',
      targetCommit: 'a'.repeat(40),
      targetMatchesHead: true,
      dirty: false,
      changes: [],
    },
    sourceTreeDigest: digestJson({ tree: 1 }),
    languages: [{ language: 'TypeScript', fileCount: 1 }],
    buildSystems: [{ name: 'Node.js package scripts', manifestPaths: ['package.json'] }],
    entryPoints: ['src/index.ts'],
    configurationFiles: ['package.json'],
    dataDependencyPaths: ['data/README.md'],
    environmentFiles: ['package.json'],
    testPaths: ['tests/index.spec.ts'],
    methodCodeDeltas: [{
      deltaId: 'delta-1',
      evidenceId: 'evidence-1',
      paperStatement: 'The method uses a fixed threshold.',
      classification: 'matches' as const,
      codeLocator: {
        path: 'src/index.ts',
        lineStart: 1,
        lineEnd: 2,
        fileDigest: digestJson({ file: 1 }),
        lineDigest: digestJson({ lines: 1 }),
      },
      summary: 'The implementation uses the described threshold.',
      likelyImpact: 'No material difference.',
      limitations: [],
    }],
    blockers: [],
    auditedAt: '2026-08-18T00:00:00.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

function reproductionPlanBody(): ReproductionPlanBody {
  return {
    schemaVersion: 1,
    planId: 'plan-1',
    sourceId: 'source-1',
    repositoryAuditId: 'audit-1',
    targetRepository: {
      remoteUrl: 'https://github.com/example/repository.git',
      commit: 'a'.repeat(40),
    },
    targetData: ['public fixture'],
    targetResults: [{
      resultId: 'accuracy',
      description: 'Reported validation accuracy.',
      metric: 'accuracy',
      expectedValue: '0.90',
      unit: null,
      evidenceId: 'evidence-1',
    }],
    scope: 'metric-equivalent',
    environmentRequirements: ['Node.js 22'],
    missingMaterials: [],
    steps: [{
      stepId: 'test',
      kind: 'test',
      description: 'Run the registered test suite.',
      expectedOutputs: ['test report'],
    }],
    expectedOutputs: ['test report'],
    tolerances: [{ resultId: 'accuracy', absolute: 0.01, relative: null }],
    blockers: [],
  }
}

function reproductionTestSpec(): ReproductionTestSpecRecord {
  const spec = {
    schemaVersion: 1 as const,
    testSpecId: 'test-spec-1',
    runner: 'vitest' as const,
    argv: ['vitest', 'run'],
    cwdRelative: '.',
    timeoutMs: 30_000,
    graceMs: 1_000,
    environment: {},
  }
  const body = {
    schemaVersion: 1 as const,
    projectId: 'project-1',
    workspaceId: 'workspace-1',
    workspaceBindingVersion: 1,
    planId: 'plan-1',
    repositoryAuditId: 'audit-1',
    sourceTreeDigest: digestJson({ tree: 1 }),
    spec,
    specDigest: digestJson(spec),
    registeredAt: '2026-08-18T00:00:01.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

function reproductionReportCandidate(): ReproductionReportCandidate {
  return {
    schemaVersion: 1,
    kind: 'reproduction-report',
    planId: 'plan-1',
    baselineAuditId: 'audit-1',
    finalAuditId: 'audit-2',
    runIds: ['run-1'],
    status: 'metric-equivalent',
    metricResults: [{
      resultId: 'accuracy',
      expectedValue: '0.90',
      observedValue: '0.90',
      unit: null,
      comparison: 'within-tolerance',
    }],
    paperDescription: 'The paper reports validation accuracy.',
    officialCodeBehavior: 'The official repository evaluates the same split.',
    localImplementationAndEnvironment: 'The registered test ran in the bound workspace.',
    necessaryModifications: [],
    resultDifferences: [],
    differenceSources: [],
    unresolvedDetails: [],
    diagnostics: [],
    limitations: ['Single public fixture.'],
  }
}
