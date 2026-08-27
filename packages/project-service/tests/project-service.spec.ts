import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { toHarnessToolDefinition, type Agent, type ToolExecution } from '@georesearch/dsh-compat-rc5'
import {
  digestJson,
  digestPhase3Body,
  type RepositoryAudit,
  type ReproductionPlan,
  type ReproductionReport,
  type ReproductionTestSpecRecord,
  type SourceRecord,
} from '@georesearch/dsh-contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectCoordinator, projectTools } from '../src/index.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Agent-bound project resolution', () => {
  it('attaches from the live Session cwd and ignores a forged project-ref hint', async () => {
    const fixture = await coordinatorFixture()
    const first = await fixture.coordinator.resolveAgent(agentAt(fixture.workspace), { attachIfMissing: true })
    await mkdir(join(fixture.workspace, '.georesearch'))
    await writeFile(join(fixture.workspace, '.georesearch', 'project-ref.json'), JSON.stringify({
      schemaVersion: 1,
      projectId: 'project-forged',
      workspaceId: 'workspace-forged',
    }))
    const second = await fixture.coordinator.resolveAgent(agentAt(fixture.workspace))
    expect(second.stateFile.projectId).toBe(first.stateFile.projectId)
    expect(second.binding.workspaceId).toBe(first.binding.workspaceId)
  })

  it('requires confirmation before rebinding the same directory identity at a new path', async () => {
    const fixture = await coordinatorFixture()
    const original = await fixture.coordinator.resolveAgent(agentAt(fixture.workspace), { attachIfMissing: true })
    const moved = join(fixture.root, 'workspace-moved')
    await rename(fixture.workspace, moved)
    await expect(fixture.coordinator.resolveAgent(agentAt(moved)))
      .rejects.toMatchObject({ code: 'PROJECT_REBIND_CONFIRMATION_REQUIRED' })
    const rebound = await fixture.coordinator.resolveAgent(agentAt(moved), { confirmRebind: true })
    expect(rebound.stateFile.projectId).toBe(original.stateFile.projectId)
    expect(rebound.binding.bindingVersion).toBe(2)
    expect(rebound.binding.canonicalPath.toLowerCase()).toBe(moved.toLowerCase())
  })

  it('binds different worktrees under one project but gives each a workspace ID', async () => {
    const root = await temporaryRoot('georesearch-worktrees-')
    const primary = join(root, 'primary')
    const secondary = join(root, 'secondary')
    const common = join(primary, '.git')
    const secondaryGit = join(common, 'worktrees', 'secondary')
    await mkdir(secondaryGit, { recursive: true })
    await mkdir(secondary, { recursive: true })
    await writeFile(join(secondary, '.git'), `gitdir: ${secondaryGit}\n`)
    await writeFile(join(secondaryGit, 'commondir'), '../..\n')
    const coordinator = new ProjectCoordinator({ home: join(root, 'home') })
    const first = await coordinator.resolveAgent(agentAt(primary), { attachIfMissing: true })
    const second = await coordinator.resolveAgent(agentAt(secondary), { attachIfMissing: true })
    expect(second.stateFile.projectId).toBe(first.stateFile.projectId)
    expect(second.binding.workspaceId).not.toBe(first.binding.workspaceId)
    expect(second.stateFile.state.projectBinding.workspaceIds).toHaveLength(2)
  })

  it('creates a new project for a clone with a different repository identity', async () => {
    const root = await temporaryRoot('georesearch-clones-')
    const left = join(root, 'left')
    const right = join(root, 'right')
    await mkdir(join(left, '.git'), { recursive: true })
    await mkdir(join(right, '.git'), { recursive: true })
    const coordinator = new ProjectCoordinator({ home: join(root, 'home') })
    const first = await coordinator.resolveAgent(agentAt(left), { attachIfMissing: true })
    const second = await coordinator.resolveAgent(agentAt(right), { attachIfMissing: true })
    expect(second.stateFile.projectId).not.toBe(first.stateFile.projectId)
  })
})

describe('Project mutations', () => {
  it('commits and exactly replays a user-confirmed ResearchBrief', async () => {
    const fixture = await coordinatorFixture()
    const execution = executionAt(fixture.workspace, 'brief-call')
    const first = await fixture.coordinator.commitResearchBrief(execution, 1, researchBriefBody('Original'))
    const replay = await fixture.coordinator.commitResearchBrief(execution, 1, researchBriefBody('Original'))
    expect(replay).toEqual(first)
    expect(first.generation).toBe(2)
    expect(first.brief.digest).toMatch(/^sha256:[0-9a-f]{64}$/u)
    await expect(fixture.coordinator.commitResearchBrief(execution, 1, researchBriefBody('Modified')))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('commits an Artifact and exposes only verified project-visible metadata', async () => {
    const fixture = await coordinatorFixture()
    await fixture.coordinator.resolveAgent(agentAt(fixture.workspace), { attachIfMissing: true })
    await writeFile(join(fixture.workspace, 'result.txt'), 'result')
    const committed = await fixture.coordinator.commitArtifact(executionAt(fixture.workspace, 'artifact-call'), {
      expectedGeneration: 1,
      sourceRelativePath: 'result.txt',
      kind: 'result',
      mediaType: 'text/plain',
      transformationType: 'snapshot',
    })
    const read = await fixture.coordinator.readArtifact(agentAt(fixture.workspace), committed.artifact.artifactId)
    expect(read.digest).toBe(committed.artifact.digest)
    expect(read.integrity).toBe('verified')
  })

  it('publishes a bounded Markdown deliverable and registers its exact Artifact', async () => {
    const fixture = await coordinatorFixture()
    const execution = executionAt(fixture.workspace, 'deliverable-call')
    const first = await fixture.coordinator.publishDeliverable(execution, {
      expectedGeneration: 1,
      relativePath: 'reports/swot-tsunami-proposal.md',
      content: '# SWOT tsunami proposal\n\nTraceable draft.\n',
      kind: 'research-proposal',
      mediaType: 'text/markdown',
    })
    const replay = await fixture.coordinator.publishDeliverable(execution, {
      expectedGeneration: 1,
      relativePath: 'reports/swot-tsunami-proposal.md',
      content: '# SWOT tsunami proposal\n\nTraceable draft.\n',
      kind: 'research-proposal',
      mediaType: 'text/markdown',
    })

    expect(replay).toEqual(first)
    expect(first).toMatchObject({
      generation: 2,
      relativePath: 'deliverables/reports/swot-tsunami-proposal.md',
      artifact: {
        kind: 'research-proposal',
        mediaType: 'text/markdown',
        sourceRelativePath: 'deliverables/reports/swot-tsunami-proposal.md',
        integrity: 'verified',
        validity: 'current',
      },
    })
    expect(await readFile(join(fixture.workspace, first.relativePath), 'utf8'))
      .toBe('# SWOT tsunami proposal\n\nTraceable draft.\n')
    const state = await fixture.coordinator.loadProject(first.projectId)
    expect(state.generation).toBe(2)
    expect(state.state.artifacts[first.artifact.artifactId]).toEqual(first.artifact)
  })

  it('requires an exact old digest before replacing a deliverable and supersedes the prior Artifact', async () => {
    const fixture = await coordinatorFixture()
    const first = await fixture.coordinator.publishDeliverable(executionAt(fixture.workspace, 'deliverable-v1'), {
      expectedGeneration: 1,
      relativePath: 'report.md',
      content: 'version one\n',
      kind: 'research-report',
      mediaType: 'text/markdown',
    })

    await expect(fixture.coordinator.publishDeliverable(executionAt(fixture.workspace, 'deliverable-v2-denied'), {
      expectedGeneration: 2,
      relativePath: 'report.md',
      content: 'version two\n',
      kind: 'research-report',
      mediaType: 'text/markdown',
    })).rejects.toMatchObject({ code: 'DELIVERABLE_OVERWRITE_REQUIRES_DIGEST' })
    expect(await readFile(join(fixture.workspace, 'deliverables', 'report.md'), 'utf8')).toBe('version one\n')

    const second = await fixture.coordinator.publishDeliverable(executionAt(fixture.workspace, 'deliverable-v2'), {
      expectedGeneration: 2,
      relativePath: 'report.md',
      content: 'version two\n',
      kind: 'research-report',
      mediaType: 'text/markdown',
      expectedDigest: first.digest,
    })
    const state = await fixture.coordinator.loadProject(second.projectId)
    expect(second.generation).toBe(3)
    expect(await readFile(join(fixture.workspace, 'deliverables', 'report.md'), 'utf8')).toBe('version two\n')
    expect(state.state.artifacts[first.artifact.artifactId]?.validity).toBe('superseded')
    expect(state.state.artifacts[second.artifact.artifactId]?.validity).toBe('current')
  })

  it('recovers the same publish operation after materialization completed before Project commit', async () => {
    const fixture = await coordinatorFixture()
    const execution = executionAt(fixture.workspace, 'deliverable-recovery')
    const materialize = fixture.coordinator.artifacts.materializeDeliverable.bind(fixture.coordinator.artifacts)
    vi.spyOn(fixture.coordinator.artifacts, 'materializeDeliverable')
      .mockImplementationOnce(async input => {
        await materialize(input)
        throw new Error('simulated interruption after materialization')
      })
      .mockImplementation(materialize)
    const request = {
      expectedGeneration: 1,
      relativePath: 'recovered.md',
      content: 'recoverable content\n',
      kind: 'research-report',
      mediaType: 'text/markdown',
    } as const

    await expect(fixture.coordinator.publishDeliverable(execution, request))
      .rejects.toThrow('simulated interruption after materialization')
    expect(await readFile(join(fixture.workspace, 'deliverables', 'recovered.md'), 'utf8'))
      .toBe('recoverable content\n')
    expect((await fixture.coordinator.resolveAgent(agentAt(fixture.workspace))).stateFile.generation).toBe(1)

    const recovered = await fixture.coordinator.publishDeliverable(execution, request)
    expect(recovered.generation).toBe(2)
    expect((await fixture.coordinator.loadProject(recovered.projectId)).state.artifacts)
      .toHaveProperty(recovered.artifact.artifactId)
  })

  it('rejects a deliverables junction or symbolic link without writing outside the workspace', async () => {
    const fixture = await coordinatorFixture()
    const outside = await temporaryRoot('georesearch-deliverable-outside-')
    await symlink(outside, join(fixture.workspace, 'deliverables'), process.platform === 'win32' ? 'junction' : 'dir')

    await expect(fixture.coordinator.publishDeliverable(executionAt(fixture.workspace, 'deliverable-link'), {
      expectedGeneration: 1,
      relativePath: 'escaped.md',
      content: 'must stay inside\n',
      kind: 'research-report',
      mediaType: 'text/markdown',
    })).rejects.toMatchObject({ code: 'ARTIFACT_UNSAFE_FILE_TYPE' })
    await expect(readFile(join(outside, 'escaped.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([
    ['../outside.md', 'text/markdown', 'content', 'DELIVERABLE_INVALID'],
    ['C:/outside.md', 'text/markdown', 'content', 'DELIVERABLE_INVALID'],
    ['payload.ps1', 'text/plain', 'content', 'DELIVERABLE_INVALID'],
    ['report.md', 'text/plain', 'content', 'DELIVERABLE_INVALID'],
    ['report.md', 'text/markdown', 'x'.repeat(2 * 1024 * 1024 + 1), 'DELIVERABLE_TOO_LARGE'],
  ])('rejects an unsafe deliverable request for %s', async (relativePath, mediaType, content, code) => {
    const fixture = await coordinatorFixture()
    await expect(fixture.coordinator.publishDeliverable(executionAt(fixture.workspace, `unsafe-${code}`), {
      expectedGeneration: 1,
      relativePath,
      content,
      kind: 'research-report',
      mediaType,
    })).rejects.toMatchObject({ code })
  })

  it('registers Phase 2 project tools without model-supplied projectId or cwd', () => {
    const tools = projectTools({} as Context)
    expect(tools.map(tool => tool.name)).toEqual([
      'research_project_status',
      'research_brief_commit',
      'artifact_commit',
      'deliverable_publish',
      'artifact_read',
    ])
    for (const tool of tools) {
      const properties = (tool.parameters as Record<string, unknown>).properties as Record<string, unknown>
      expect(properties).not.toHaveProperty('projectId')
      expect(properties).not.toHaveProperty('cwd')
      const projected = toHarnessToolDefinition(tool)
      expect(JSON.stringify(projected)).not.toMatch(/minLength|minimum|pattern/)
    }
  })

  it('advertises the canonical ResearchBrief confirmation timestamp to the model', () => {
    const tool = projectTools({} as Context).find(candidate => candidate.name === 'research_brief_commit')!
    const parameters = tool.parameters as Record<string, unknown>
    const brief = (parameters.properties as Record<string, unknown>).brief as Record<string, unknown>
    const confirmation = (brief.properties as Record<string, unknown>).userConfirmation as Record<string, unknown>
    const confirmedAt = (confirmation.properties as Record<string, unknown>).confirmedAt as Record<string, unknown>

    expect(confirmedAt).toMatchObject({
      pattern: '^(?:\\d{4}|[+-]\\d{6})-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$',
      examples: ['2026-08-26T00:00:00.000Z'],
    })
    expect(confirmedAt.description).toMatch(/canonical UTC.*millisecond/iu)

    const projected = toHarnessToolDefinition(tool)
    const projectedParameters = projected.parameters as Record<string, unknown>
    const projectedBrief = (projectedParameters.properties as Record<string, unknown>).brief as Record<string, unknown>
    const projectedConfirmation = (projectedBrief.properties as Record<string, unknown>).userConfirmation as Record<string, unknown>
    const projectedConfirmedAt = (projectedConfirmation.properties as Record<string, unknown>).confirmedAt as Record<string, unknown>
    expect(projectedConfirmedAt).not.toHaveProperty('pattern')
    expect(projectedConfirmedAt).toMatchObject({
      description: confirmedAt.description,
      examples: ['2026-08-26T00:00:00.000Z'],
    })
  })

  it('commits concurrent uploaded streams without losing either Artifact', async () => {
    const fixture = await coordinatorFixture()
    const agent = agentAt(fixture.workspace)
    await fixture.coordinator.resolveAgent(agent, { attachIfMissing: true })
    const uploaded = await Promise.all(Array.from({ length: 8 }, (_, index) => (
      fixture.coordinator.commitUploadedArtifact(agent, {
        attachmentId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        source: byteStream(`upload-${index + 1}`),
        maxBytes: 1024,
        mediaType: 'text/plain',
      })
    )))
    expect(new Set(uploaded.map(result => result.artifact.artifactId)).size).toBe(8)
    for (const result of uploaded) expect(result.artifact).not.toHaveProperty('sourceRelativePath')
    const state = await fixture.coordinator.loadProject(uploaded[0]!.projectId)
    expect(state.generation).toBe(9)
    expect(Object.keys(state.state.artifacts).sort()).toEqual(
      uploaded.map(result => result.artifact.artifactId).sort(),
    )
  })

  it('rolls back a newly committed uploaded Artifact at the unchanged project generation', async () => {
    const fixture = await coordinatorFixture()
    const agent = agentAt(fixture.workspace)
    await fixture.coordinator.resolveAgent(agent, { attachIfMissing: true })
    const attachmentId = '00000000-0000-4000-8000-000000000099'
    const committed = await fixture.coordinator.commitUploadedArtifact(agent, {
      attachmentId,
      source: byteStream('rollback-me'),
      maxBytes: 1024,
      mediaType: 'text/plain',
    })

    expect(committed.artifact.lineage.configDigest).toBe(digestJson({
      domain: 'georesearch.uploaded-attachment/v1',
      attachmentId,
    }))
    await fixture.coordinator.rollbackUploadedArtifact(agent, {
      attachmentId,
      expectedGeneration: committed.generation,
      artifact: {
        artifactId: committed.artifact.artifactId,
        digest: committed.artifact.digest,
        kind: committed.artifact.kind,
      },
    })
    const state = await fixture.coordinator.loadProject(committed.projectId)
    expect(state.state.artifacts).not.toHaveProperty(committed.artifact.artifactId)
  })

  it('persists the Phase 4 Audit, Plan, TestSpec, and diagnosed Report chain', async () => {
    const fixture = await coordinatorFixture()
    const agent = agentAt(fixture.workspace)
    const resolved = await fixture.coordinator.resolveAgent(agent, { attachIfMissing: true })
    const projectId = resolved.stateFile.projectId
    const source = sourceRecord()
    await fixture.coordinator.commitSourceRecord(projectId, {
      expectedGeneration: 1,
      operationKey: digestJson({ operation: 'source' }),
      requestDigest: digestJson({ request: 'source' }),
      source,
    })
    const audit = repositoryAudit(projectId, resolved.binding.workspaceId, resolved.binding.bindingVersion, source)
    await fixture.coordinator.commitRepositoryAudit(projectId, {
      expectedGeneration: 2,
      operationKey: digestJson({ operation: 'audit' }),
      requestDigest: digestJson({ request: 'audit' }),
      repositoryAudit: audit,
    })
    const repeatedAuditBody = { ...audit, auditedAt: '2026-08-18T00:00:09.000Z' }
    delete (repeatedAuditBody as Partial<RepositoryAudit>).digest
    const repeatedAudit = { ...repeatedAuditBody, digest: digestJson(repeatedAuditBody) } as RepositoryAudit
    const repeatedState = await fixture.coordinator.commitRepositoryAudit(projectId, {
      expectedGeneration: 3,
      operationKey: digestJson({ operation: 'audit-repeat' }),
      requestDigest: digestJson({ request: 'audit-repeat' }),
      repositoryAudit: repeatedAudit,
    })
    expect(repeatedState.generation).toBe(3)
    expect(repeatedState.state.repositoryAudits?.[audit.auditId]).toEqual(audit)
    const plan = reproductionPlan(audit)
    await fixture.coordinator.commitReproductionPlan(projectId, {
      expectedGeneration: 3,
      operationKey: digestJson({ operation: 'plan' }),
      requestDigest: digestJson({ request: 'plan' }),
      reproductionPlan: plan,
    })
    const repeatedPlanBody = { ...plan, createdAt: '2026-08-18T00:00:10.000Z' }
    delete (repeatedPlanBody as Partial<ReproductionPlan>).digest
    const repeatedPlan = { ...repeatedPlanBody, digest: digestJson(repeatedPlanBody) } as ReproductionPlan
    const repeatedPlanState = await fixture.coordinator.commitReproductionPlan(projectId, {
      expectedGeneration: 4,
      operationKey: digestJson({ operation: 'plan-repeat' }),
      requestDigest: digestJson({ request: 'plan-repeat' }),
      reproductionPlan: repeatedPlan,
    })
    expect(repeatedPlanState.generation).toBe(4)
    expect(repeatedPlanState.state.reproductionPlans?.[plan.planId]).toEqual(plan)
    const testSpec = reproductionTestSpec(plan, audit)
    await fixture.coordinator.commitReproductionTestSpec(projectId, {
      expectedGeneration: 4,
      operationKey: digestJson({ operation: 'test-spec' }),
      requestDigest: digestJson({ request: 'test-spec' }),
      reproductionTestSpec: testSpec,
    })
    const smokeSpec = {
      ...testSpec,
      spec: {
        ...testSpec.spec,
        testSpecId: 'phase4-dynamic-smoke',
        runner: 'smoke' as const,
        argv: ['node', '--version'],
      },
    }
    const smokeSpecBody = {
      ...smokeSpec,
      specDigest: digestJson(smokeSpec.spec),
      registeredAt: '2026-08-18T00:00:04.000Z',
    }
    delete (smokeSpecBody as Partial<ReproductionTestSpecRecord>).digest
    const smokeRecord = { ...smokeSpecBody, digest: digestJson(smokeSpecBody) } as ReproductionTestSpecRecord
    await expect(fixture.coordinator.commitReproductionTestSpec(projectId, {
      expectedGeneration: 5,
      operationKey: digestJson({ operation: 'test-spec-smoke' }),
      requestDigest: digestJson({ request: 'test-spec-smoke' }),
      reproductionTestSpec: smokeRecord,
    })).rejects.toMatchObject({ code: 'TEST_SPEC_INVALID' })
    const reportDocument = {
      schemaVersion: 1,
      kind: 'reproduction-report',
      planId: plan.planId,
      status: 'blocked-by-missing-data',
      diagnostics: [{ code: 'DATASET_NOT_PUBLIC', message: 'Dataset is unavailable.' }],
    }
    const generated = await fixture.coordinator.commitGeneratedArtifact(agent, {
      source: byteStream(`${JSON.stringify(reportDocument)}\n`),
      maxBytes: 1024 * 1024,
      kind: 'reproduction-report',
      mediaType: 'application/json',
      transformationType: 'georesearch.reproduction-report/v1',
      inputDigests: [plan.digest, audit.digest],
    })
    const report = reproductionReport(plan, audit, generated.artifact)
    await fixture.coordinator.commitReproductionReport(projectId, {
      expectedGeneration: 6,
      operationKey: digestJson({ operation: 'report' }),
      requestDigest: digestJson({ request: 'report' }),
      reproductionReport: report,
    })

    const reloaded = await new ProjectCoordinator({ home: fixture.home }).loadProject(projectId)
    expect(reloaded.state.repositoryAudits?.[audit.auditId]).toEqual(audit)
    expect(reloaded.state.reproductionPlans?.[plan.planId]).toEqual(plan)
    expect(reloaded.state.reproductionTestSpecs?.[testSpec.spec.testSpecId]).toEqual(testSpec)
    expect(reloaded.state.reproductionReports?.[report.reportId]).toEqual(report)
    expect(reloaded.generation).toBe(7)

    const reviewerRead = await fixture.coordinator.readArtifactForTool(agent, generated.artifact.artifactId)
    expect(reviewerRead).toMatchObject({
      contentStatus: 'included',
      content: { encoding: 'utf-8' },
    })
    expect(JSON.parse(reviewerRead.content?.text ?? '{}')).toEqual(reportDocument)
  })
})

async function* byteStream(text: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(text)
}

async function coordinatorFixture(): Promise<{
  readonly root: string
  readonly home: string
  readonly workspace: string
  readonly coordinator: ProjectCoordinator
}> {
  const root = await temporaryRoot('georesearch-project-service-')
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  await mkdir(workspace)
  return { root, home, workspace, coordinator: new ProjectCoordinator({ home }) }
}

function agentAt(cwd: string): Agent {
  return {
    id: 'agent-1',
    session: { id: 'session-1', header: { cwd } },
  } as unknown as Agent
}

function executionAt(cwd: string, callId: string): ToolExecution {
  return {
    agent: agentAt(cwd),
    rootCallId: callId,
    callId,
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

function researchBriefBody(title: string) {
  return {
    schemaVersion: 1,
    briefId: 'brief-1',
    title,
    researchQuestion: 'How does the signal change?',
    background: 'Established background.',
    motivation: 'A bounded scientific motivation.',
    region: { description: 'Test region', bbox: [0, 0, 1, 1], crs: 'EPSG:4326' },
    timeRange: { start: '2020-01-01', end: '2020-12-31' },
    researchSubjects: ['signal'],
    dataModalities: ['raster'],
    hypotheses: [{ hypothesisId: 'h1', statement: 'The signal increases.' }],
    expectedContributions: ['A reproducible estimate'],
    constraints: ['Local data only'],
    knownAssumptions: ['Stable calibration'],
    successCriteria: ['Predeclared metric passes'],
    userConfirmation: {
      confirmed: true,
      confirmedAt: '2026-08-16T00:00:00.000Z',
      confirmedBy: 'user',
      auditNote: 'Confirmed in the root session.',
    },
  }
}

function sourceRecord(): SourceRecord {
  const body = {
    schemaVersion: 1 as const,
    sourceId: 'source-phase4',
    title: 'Phase 4 public repository fixture',
    authors: [{ name: 'A. Researcher', orcid: null }],
    year: 2025,
    venue: 'Fixture Journal',
    stableIdentifier: { kind: 'doi' as const, value: '10.1234/phase4.fixture' },
    sourceType: 'journal-article',
    versionRelation: { kind: 'none' as const, relatedIdentifier: null },
    retrievedAt: '2026-08-18T00:00:00.000Z',
    providerTrace: {
      providerId: 'fixture',
      providerVersion: '1.0.0',
      retrievedAt: '2026-08-18T00:00:00.000Z',
      credentialRef: null,
      credentialBindingEpoch: 0,
      requestId: null,
    },
    codeRefs: [{ url: 'https://github.com/example/repository.git', label: 'official' }],
    dataRefs: [],
    status: 'resolved' as const,
    searchChain: { chainId: 'chain-phase4', generation: 1, providerItemId: '10.1234/phase4.fixture' },
  }
  return { ...body, digest: digestPhase3Body(body) }
}

function repositoryAudit(
  projectId: string,
  workspaceId: string,
  workspaceBindingVersion: number,
  source: SourceRecord,
): RepositoryAudit {
  const body = {
    schemaVersion: 1 as const,
    auditId: 'audit-phase4',
    projectId,
    workspaceId,
    workspaceBindingVersion,
    sourceId: source.sourceId,
    sourceDigest: source.digest,
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
    sourceTreeDigest: digestJson({ tree: 'phase4' }),
    languages: [{ language: 'Python', fileCount: 1 }],
    buildSystems: [{ name: 'Python packaging', manifestPaths: ['pyproject.toml'] }],
    entryPoints: ['train.py'],
    configurationFiles: ['pyproject.toml'],
    dataDependencyPaths: ['data'],
    environmentFiles: ['pyproject.toml'],
    testPaths: ['tests'],
    methodCodeDeltas: [],
    blockers: [],
    auditedAt: '2026-08-18T00:00:01.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

function reproductionPlan(audit: RepositoryAudit): ReproductionPlan {
  const body = {
    schemaVersion: 1 as const,
    planId: 'plan-phase4',
    sourceId: audit.sourceId,
    repositoryAuditId: audit.auditId,
    targetRepository: { remoteUrl: audit.repository.remoteUrl, commit: audit.repository.targetCommit as string },
    targetData: ['private pretraining corpus'],
    targetResults: [],
    scope: 'functional' as const,
    environmentRequirements: ['Python'],
    missingMaterials: ['private pretraining corpus'],
    steps: [{
      stepId: 'environment-check',
      kind: 'inspect' as const,
      description: 'Verify required data and environment.',
      expectedOutputs: ['diagnosis'],
    }],
    expectedOutputs: ['diagnosis'],
    tolerances: [],
    blockers: [{ code: 'DATASET_NOT_PUBLIC', message: 'Dataset is unavailable.', retryable: false }],
    projectId: audit.projectId,
    workspaceId: audit.workspaceId,
    workspaceBindingVersion: audit.workspaceBindingVersion,
    repositoryAuditDigest: audit.digest,
    sourceTreeDigest: audit.sourceTreeDigest,
    status: 'candidate' as const,
    createdAt: '2026-08-18T00:00:02.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

function reproductionTestSpec(plan: ReproductionPlan, audit: RepositoryAudit): ReproductionTestSpecRecord {
  const spec = {
    schemaVersion: 1 as const,
    testSpecId: 'phase4-environment-test',
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
    registeredAt: '2026-08-18T00:00:03.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

function reproductionReport(
  plan: ReproductionPlan,
  audit: RepositoryAudit,
  artifact: { readonly artifactId: string; readonly digest: `sha256:${string}`; readonly kind: string },
): ReproductionReport {
  const body = {
    schemaVersion: 1 as const,
    kind: 'reproduction-report' as const,
    planId: plan.planId,
    baselineAuditId: audit.auditId,
    finalAuditId: audit.auditId,
    runIds: [],
    status: 'blocked-by-missing-data' as const,
    metricResults: [],
    paperDescription: 'The paper requires a private pretraining corpus.',
    officialCodeBehavior: 'The repository references data that is not distributed.',
    localImplementationAndEnvironment: 'The bound workspace was audited without executing arbitrary code.',
    necessaryModifications: [],
    resultDifferences: [],
    differenceSources: ['Required data is unavailable.'],
    unresolvedDetails: ['Exact corpus composition is not public.'],
    diagnostics: [{
      code: 'DATASET_NOT_PUBLIC',
      message: 'The required pretraining corpus is unavailable.',
      relatedRunIds: [],
      relatedArtifactIds: [],
    }],
    limitations: ['No substitute dataset was used.'],
    reportId: 'report-phase4',
    projectId: plan.projectId,
    workspaceId: plan.workspaceId,
    workspaceBindingVersion: plan.workspaceBindingVersion,
    planDigest: plan.digest,
    baselineAuditDigest: audit.digest,
    finalAuditDigest: audit.digest,
    reportArtifact: {
      artifactId: artifact.artifactId,
      digest: artifact.digest,
      kind: artifact.kind,
    },
    reviewStatus: 'pending' as const,
    committedAt: '2026-08-18T00:00:04.000Z',
  }
  return { ...body, digest: digestJson(body) }
}

async function temporaryRoot(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix))
  temporaryRoots.push(path)
  return path
}
