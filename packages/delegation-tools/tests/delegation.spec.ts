import type { Context } from '@deepseek-ai/cordis'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { toHarnessToolDefinition, type Agent, type ToolExecution } from '@georesearch/dsh-compat-rc5'
import {
  DELEGATION_BOOTSTRAP_TOOL,
  digestJson,
  outputKindsForTask,
  type ProjectReducerState,
  type ValidationSubjectRef,
} from '@georesearch/dsh-contracts'
import { describe, expect, it, vi } from 'vitest'
import { createDelegationBootstrapTool, createDelegationTool } from '../src/index.js'

describe('managed delegation tool', () => {
  it('limits each structured-output schema to the selected task output kinds', async () => {
    const subject = resultSubject('result-cache-schema', { result: 'cache-schema' })
    const state = projectState({
      results: { [subject.subjectId]: { digest: subject.digest } } as never,
    })
    const start = vi.fn(async () => ({
      id: `child-cache-${start.mock.calls.length}`,
      result: Promise.resolve({
        stopReason: 'completed',
        structured: {
          result: {
            status: 'needs-user-decision',
            summary: 'A bounded choice is required.',
            questionCode: 'CACHE_SCHEMA_FIXTURE',
            subjectRefs: [],
            artifactRefs: [],
            question: 'Choose one option.',
            options: ['A'],
          },
        },
      }),
      dispose: vi.fn(async () => {}),
    }))
    const ctx = delegationContext(
      start,
      (_parent, _contract, operation: () => unknown) => operation(),
      undefined,
      undefined,
      undefined,
      state,
    )
    const cases = [
      ['literature', 'discovery', undefined],
      ['literature', 'evidence-synthesis', undefined],
      ['experiment', 'data-assessment', undefined],
      ['reviewer', 'proposal-review', [subject]],
      ['writing', 'outline', undefined],
    ] as const

    for (const [role, taskType, subjectRefs] of cases) {
      const tool = createDelegationTool(ctx, role, {
        strictRoleCapabilities: false,
        capabilityStage: 'phase6',
      })
      await tool.execute({
        taskType,
        task: `Exercise ${role}:${taskType}`,
        ...(subjectRefs === undefined ? {} : { subjectRefs }),
      }, execution())
    }

    const schemas = start.mock.calls.map(call => (
      call[1] as {
        readonly outputSchema: {
          readonly properties: {
            readonly result: {
              readonly oneOf: ReadonlyArray<{
                readonly properties?: {
                  readonly status?: { readonly const?: string }
                  readonly outputKind?: { readonly const?: string }
                }
              }>
            }
          }
        }
      }
    ).outputSchema)
    expect(schemas).toHaveLength(cases.length)
    for (const [index, [role, taskType]] of cases.entries()) {
      const completedKinds = schemas[index]!.properties.result.oneOf
        .filter(branch => branch.properties?.status?.const === 'completed')
        .map(branch => branch.properties?.outputKind?.const)
      expect(completedKinds).toEqual(outputKindsForTask(role, taskType))
    }
    expect(new Set(schemas.map(schema => JSON.stringify(schema))).size).toBeGreaterThan(1)
    expect(JSON.stringify(schemas[2]).length).toBeLessThan(20_000)
  })

  it('keeps the first child instruction prefix stable while task schemas remain scoped', async () => {
    const start = vi.fn(async () => ({
      id: `child-cache-prefix-${start.mock.calls.length}`,
      result: Promise.resolve({
        stopReason: 'completed',
        structured: {
          result: {
            status: 'needs-user-decision',
            summary: 'A bounded choice is required.',
            questionCode: 'CACHE_PREFIX_FIXTURE',
            subjectRefs: [],
            artifactRefs: [],
            question: 'Choose one option.',
            options: ['A'],
          },
        },
      }),
      dispose: vi.fn(async () => {}),
    }))
    const withManagedDelegation = vi.fn((_parent, _contract, operation: () => unknown) => operation())
    const ctx = delegationContext(start, withManagedDelegation)
    const tool = createDelegationTool(ctx, 'literature', {
      strictRoleCapabilities: false,
      capabilityStage: 'phase6',
    })

    await tool.execute({
      taskType: 'discovery',
      task: 'Find the dynamic primary source.',
      researchQuestion: 'Which source is authoritative?',
      constraints: ['Use primary literature.'],
    }, execution())
    await tool.execute({
      taskType: 'evidence-synthesis',
      task: 'Synthesize a different evidence set.',
      researchQuestion: 'What is supported and contested?',
      constraints: ['Separate observation from inference.'],
    }, execution())

    const requests = start.mock.calls.map(call => call[1] as {
      readonly label: string
      readonly prompt: readonly [{ readonly type: 'text'; readonly text: string }]
      readonly agentOptions: unknown
      readonly persona: string
      readonly toolFilter: unknown
      readonly maxDepth: number
      readonly outputSchema: unknown
    })
    const cacheSurfaces = requests.map(request => JSON.stringify({
      label: request.label,
      prompt: request.prompt,
      agentOptions: request.agentOptions,
      persona: request.persona,
      toolFilter: request.toolFilter,
      maxDepth: request.maxDepth,
    }))
    expect(cacheSurfaces[0]).toBe(cacheSurfaces[1])
    expect(requests[0]!.outputSchema).not.toEqual(requests[1]!.outputSchema)
    const prompt = JSON.parse(requests[0]!.prompt[0].text) as Record<string, unknown>
    expect(prompt).toMatchObject({ role: 'literature' })
    expect(JSON.stringify(prompt)).toContain('The result value must be the object itself, never JSON text.')
    for (const dynamic of [
      'taskType', 'requiredSkills', 'completionCriteria', 'allowedOutputKinds',
      'authority', 'researchQuestion', 'constraints', 'task',
    ]) {
      expect(prompt).not.toHaveProperty(dynamic)
    }

    const contracts = withManagedDelegation.mock.calls.map(call => call[1] as {
      readonly bootstrapPayload: Record<string, unknown>
    })
    expect(contracts[0]?.bootstrapPayload).toMatchObject({
      role: 'literature',
      taskType: 'discovery',
      task: 'Find the dynamic primary source.',
      researchQuestion: 'Which source is authoritative?',
    })
    expect(contracts[1]?.bootstrapPayload).toMatchObject({
      role: 'literature',
      taskType: 'evidence-synthesis',
      task: 'Synthesize a different evidence set.',
      researchQuestion: 'What is supported and contested?',
    })
  })

  it('inherits the parent current request route instead of its creation-time model', async () => {
    const start = vi.fn(async () => ({
      id: 'child-current-route',
      result: Promise.resolve({
        stopReason: 'completed',
        structured: {
          result: {
            status: 'needs-user-decision',
            summary: 'A bounded choice is required.',
            questionCode: 'CURRENT_ROUTE_FIXTURE',
            subjectRefs: [],
            artifactRefs: [],
            question: 'Choose one option.',
            options: ['A'],
          },
        },
      }),
      dispose: vi.fn(async () => {}),
    }))
    const ctx = delegationContext(start, (_parent, _contract, operation: () => unknown) => operation())
    const tool = createDelegationTool(ctx, 'literature', {
      strictRoleCapabilities: false,
      capabilityStage: 'phase6',
    })
    const parent = {
      id: 'parent-current-route',
      options: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        maxTokens: 64_000,
      },
      session: {
        requestHeader: () => ({
          config: {
            provider: 'deepseek-official',
            model: 'deepseek-v4-flash',
            maxTokens: 32_000,
          },
        }),
      },
    } as unknown as Agent

    await tool.execute(
      { taskType: 'discovery', task: 'Exercise the current model route.' },
      { agent: parent, signal: new AbortController().signal } as ToolExecution,
    )

    expect(start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      parent,
      agentOptions: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-flash',
        maxTokens: 16_384,
        geoResearchRole: 'literature',
      },
    }))
  })

  it('preserves a parent request cap below the specialist ceiling', async () => {
    const start = vi.fn(async () => ({
      id: 'child-lower-cap',
      result: Promise.resolve({
        stopReason: 'completed',
        structured: {
          result: {
            status: 'needs-user-decision',
            summary: 'A bounded choice is required.',
            questionCode: 'LOWER_CAP_FIXTURE',
            subjectRefs: [],
            artifactRefs: [],
            question: 'Choose one option.',
            options: ['A'],
          },
        },
      }),
      dispose: vi.fn(async () => {}),
    }))
    const ctx = delegationContext(start, (_parent, _contract, operation: () => unknown) => operation())
    const tool = createDelegationTool(ctx, 'literature', {
      strictRoleCapabilities: false,
      capabilityStage: 'phase6',
    })
    const parent = {
      id: 'parent-lower-cap',
      options: { maxTokens: 4_096 },
    } as unknown as Agent

    await tool.execute(
      { taskType: 'discovery', task: 'Keep the lower request cap.' },
      { agent: parent, signal: new AbortController().signal } as ToolExecution,
    )

    expect(start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      agentOptions: { maxTokens: 4_096, geoResearchRole: 'literature' },
    }))
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an invalid specialistMaxTokens value of %s',
    (specialistMaxTokens) => {
      expect(() => createDelegationTool({} as Context, 'literature', { specialistMaxTokens }))
        .toThrow('specialistMaxTokens must be a positive safe integer')
    },
  )

  it('returns the exact managed bootstrap payload from the Host', async () => {
    const payload = delegationBootstrapPayload()
    const consumeDelegationBootstrap = vi.fn(() => payload)
    const ctx = {
      geoResearchInstallation: { assertCurrent: vi.fn() },
      geoResearchPolicy: { consumeDelegationBootstrap },
    } as unknown as Context
    const tool = createDelegationBootstrapTool(ctx)
    const child = { id: 'child-bootstrap' } as Agent

    await expect(tool.execute({}, {
      agent: child,
      signal: new AbortController().signal,
    } as ToolExecution)).resolves.toEqual(payload)
    expect(consumeDelegationBootstrap).toHaveBeenCalledWith(child)
    expect(tool.name).toBe(DELEGATION_BOOTSTRAP_TOOL)
    const projected = toHarnessToolDefinition(tool)
    expect(() => assertObjectJsonSchema(projected.parameters)).not.toThrow()
    expect(() => assertObjectJsonSchema(projected.output.schema)).not.toThrow()
  })

  it('fixes the one-shot request and always disposes the run', async () => {
    const dispose = vi.fn(async () => {})
    const start = vi.fn(async (_provider: string, _request: unknown) => ({
      id: 'child-1',
      result: Promise.resolve({
        stopReason: 'completed',
        structured: {
          result: {
            status: 'completed',
            summary: 'evidence bounded',
            outputKind: 'literature-search-report',
            candidate: researchReport('literature-search-report'),
          },
        },
      }),
      dispose,
    }))
    const withManagedDelegation = vi.fn((_parent, _contract, operation: () => unknown) => operation())
    const ctx = delegationContext(start, withManagedDelegation, undefined, undefined, {
      role: 'literature',
      taskType: 'discovery',
      requiredSkills: ['literature-review'],
      loadedSkills: ['literature-review'],
      missingSkills: [],
    })
    const tool = createDelegationTool(ctx, 'literature', {
      strictRoleCapabilities: true,
      capabilityStage: 'phase1',
    })
    const parent = { id: 'parent-1' } as unknown as Agent
    const output = await tool.execute(
      { taskType: 'discovery', task: 'Find the primary source' },
      { agent: parent, signal: new AbortController().signal } as ToolExecution,
    )
    expect(output).toMatchObject({
      role: 'literature',
      taskType: 'discovery',
      subagentId: 'child-1',
      stopReason: 'completed',
      status: 'completed',
      requiredSkills: ['literature-review'],
      loadedSkills: ['literature-review'],
    })
    expect(withManagedDelegation).toHaveBeenCalledWith(parent, expect.objectContaining({
      role: 'literature',
      taskType: 'discovery',
      requiredSkills: ['literature-review'],
      bootstrapPayload: expect.objectContaining({
        role: 'literature',
        taskType: 'discovery',
        task: 'Find the primary source',
        constraints: [expect.stringMatching(/hard limit.*four findings.*fifth finding.*close the findings array/iu)],
      }),
    }), expect.any(Function))
    expect(start).toHaveBeenCalledWith('spawn', expect.objectContaining({
      parent,
      maxDepth: 1,
      agentOptions: { maxTokens: 16_384, geoResearchRole: 'literature' },
      toolFilter: { allow: ['read', 'skill', 'web_search', DELEGATION_BOOTSTRAP_TOOL] },
      outputSchema: expect.any(Object),
    }))
    const startRequest = start.mock.calls[0]?.[1] as {
      readonly outputSchema?: {
        readonly properties?: {
          readonly result?: {
            readonly oneOf?: ReadonlyArray<{
              readonly properties?: {
                readonly outputKind?: { readonly const?: string }
                readonly candidate?: {
                  readonly additionalProperties?: boolean
                  readonly required?: readonly string[]
                  readonly properties?: {
                    readonly methods?: { readonly description?: string }
                    readonly findings?: {
                      readonly description?: string
                      readonly maxItems?: number
                      readonly items?: {
                        readonly properties?: {
                          readonly statement?: { readonly description?: string }
                          readonly basisRefs?: { readonly description?: string }
                        }
                      }
                    }
                  }
                }
              }
            }>
          }
        }
      }
    }
    expect(() => assertObjectJsonSchema(startRequest.outputSchema)).not.toThrow()
    const completed = startRequest.outputSchema?.properties?.result?.oneOf
      ?.find(branch => branch.properties?.outputKind?.const === 'literature-search-report')
    expect(completed?.properties?.candidate).toMatchObject({
      additionalProperties: false,
      required: [
        'schemaVersion', 'kind', 'methods', 'findings', 'limitations',
        'recommendations', 'subjectRefs', 'artifactRefs',
      ],
    })
    expect(completed?.properties?.candidate?.properties?.methods?.description).toMatch(/1-4/iu)
    expect(completed?.properties?.candidate?.properties?.findings?.description).toMatch(/hard limit.*four findings/iu)
    expect(completed?.properties?.candidate?.properties?.findings?.maxItems).toBe(4)
    expect(completed?.properties?.candidate?.properties?.findings?.items?.properties?.statement?.description).toMatch(/2000 characters/iu)
    expect(completed?.properties?.candidate?.properties?.findings?.items?.properties?.basisRefs?.description).toMatch(/at most eight/iu)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('unwraps a validated user-decision result from the structured output envelope', async () => {
    const dispose = vi.fn(async () => {})
    const start = vi.fn(async () => ({
      id: 'child-decision',
      result: Promise.resolve({
        stopReason: 'completed',
        structured: {
          result: {
            status: 'needs-user-decision',
            summary: 'A source choice is required.',
            questionCode: 'CHOOSE_PRIMARY_SOURCE',
            subjectRefs: [],
            artifactRefs: [],
            question: 'Which primary source should be authoritative?',
            options: ['Source A', 'Source B'],
          },
        },
      }),
      dispose,
    }))
    const ctx = delegationContext(start, (_parent, _contract, operation: () => unknown) => operation())
    const tool = createDelegationTool(ctx, 'literature', {
      strictRoleCapabilities: true,
      capabilityStage: 'phase1',
    })

    await expect(tool.execute(
      { taskType: 'discovery', task: 'Select the authoritative primary source' },
      execution(),
    )).resolves.toMatchObject({
      status: 'needs-user-decision',
      questionCode: 'CHOOSE_PRIMARY_SOURCE',
      options: ['Source A', 'Source B'],
    })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('disposes a run that returns an invalid structured candidate', async () => {
    const dispose = vi.fn(async () => {})
    const start = vi.fn(async () => ({
      id: 'child-2',
      result: Promise.resolve({ stopReason: 'completed', structured: { result: { status: 'completed' } } }),
      dispose,
    }))
    const ctx = delegationContext(start, (_parent, _contract, operation: () => unknown) => operation())
    const tool = createDelegationTool(ctx, 'literature', {
      strictRoleCapabilities: true,
      capabilityStage: 'phase1',
    })
    await expect(tool.execute(
      { taskType: 'discovery', task: 'Find the primary source' },
      { agent: { id: 'parent-1' } as Agent, signal: new AbortController().signal } as ToolExecution,
    )).rejects.toMatchObject({ code: 'GEORESEARCH_SUBAGENT_OUTPUT_INVALID' })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('rejects a generic report that exceeds the compact finding budget', async () => {
    const dispose = vi.fn(async () => {})
    const candidate = researchReport('literature-search-report')
    candidate.findings = Array.from({ length: 5 }, (_, index) => ({
      findingId: `finding-${index + 1}`,
      statement: `Bounded finding ${index + 1}.`,
      basisRefs: [],
      confidence: 'moderate',
      limitations: [],
    }))
    const start = vi.fn(async () => ({
      id: 'child-over-budget',
      result: Promise.resolve({
        stopReason: 'completed',
        structured: {
          result: {
            status: 'completed',
            summary: 'Too many findings.',
            outputKind: 'literature-search-report',
            candidate,
          },
        },
      }),
      dispose,
    }))
    const ctx = delegationContext(start, (_parent, _contract, operation: () => unknown) => operation())
    const tool = createDelegationTool(ctx, 'literature', {
      strictRoleCapabilities: true,
      capabilityStage: 'phase1',
    })

    await expect(tool.execute(
      { taskType: 'discovery', task: 'Return a compact source report.' },
      execution(),
    )).rejects.toMatchObject({ code: 'GEORESEARCH_SUBAGENT_OUTPUT_INVALID' })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('commits a strict literature Evidence Candidate through the root Host wrapper', async () => {
    const candidate = {
      schemaVersion: 1,
      sourceId: 'source-1',
      artifactId: 'artifact-1',
      paperReadReceiptId: 'receipt-1',
      locator: { pageStart: 2, pageEnd: 2 },
      proposition: 'The observation supports the claim.',
      relation: 'supports',
      paraphrase: 'A bounded paraphrase.',
      limitations: ['Single source.'],
    }
    const evidenceRecord = {
      ...candidate,
      evidenceId: 'evidence-1',
      artifactDigest: `sha256:${'1'.repeat(64)}`,
      extractionLineage: {
        providerId: 'georesearch-pdf-read',
        providerVersion: '1.0.0',
        parserId: 'pdfjs-dist',
        parserVersion: '5.4.54',
        configDigest: `sha256:${'2'.repeat(64)}`,
      },
      reviewStatus: 'pending',
      committedAt: '2026-08-18T00:00:00.000Z',
      digest: `sha256:${'3'.repeat(64)}`,
    }
    const commit = vi.fn(async () => evidenceRecord)
    const dispose = vi.fn(async () => {})
    const start = vi.fn(async () => ({
      id: 'child-3',
      result: Promise.resolve({
        stopReason: 'completed',
        structured: {
          result: {
            status: 'completed',
            summary: 'candidate ready',
            outputKind: 'evidence-candidate',
            candidate,
          },
        },
      }),
      dispose,
    }))
    const ctx = delegationContext(
      start,
      (_parent, _contract, operation: () => unknown) => operation(),
      commit,
      undefined,
      {
        role: 'literature',
        taskType: 'evidence-extraction',
        requiredSkills: ['literature-review'],
        loadedSkills: ['literature-review'],
        missingSkills: [],
      },
    )
    const tool = createDelegationTool(ctx, 'literature', {
      strictRoleCapabilities: true,
      capabilityStage: 'phase1',
    })
    const execution = {
      agent: { id: 'parent-1' } as Agent,
      signal: new AbortController().signal,
    } as ToolExecution

    const output = await tool.execute({
      taskType: 'evidence-extraction',
      task: 'Commit bounded evidence',
    }, execution)

    expect(commit).toHaveBeenCalledWith(execution, candidate)
    expect(output).toMatchObject({ evidenceRecord })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('commits a strict Experiment ReproductionReport Candidate through the root Host wrapper', async () => {
    const candidate = {
      schemaVersion: 1,
      kind: 'reproduction-report',
      planId: 'plan-1',
      baselineAuditId: 'audit-baseline',
      finalAuditId: 'audit-final',
      runIds: [],
      status: 'blocked-by-environment',
      metricResults: [],
      paperDescription: 'The paper requires the original runtime.',
      officialCodeBehavior: 'The official code imports TensorFlow 1.x APIs.',
      localImplementationAndEnvironment: 'The required runtime is unavailable.',
      necessaryModifications: [],
      resultDifferences: [],
      differenceSources: ['Runtime incompatibility.'],
      unresolvedDetails: [],
      diagnostics: [{
        code: 'TENSORFLOW_1X_UNAVAILABLE',
        message: 'No compatible TensorFlow 1.x runtime is installed.',
        relatedRunIds: [],
        relatedArtifactIds: [],
      }],
      limitations: [],
    }
    const reproductionReport = {
      ...candidate,
      reportId: 'report-1',
      projectId: 'project-1',
      workspaceId: 'workspace-1',
      workspaceBindingVersion: 1,
      planDigest: `sha256:${'1'.repeat(64)}`,
      baselineAuditDigest: `sha256:${'2'.repeat(64)}`,
      finalAuditDigest: `sha256:${'3'.repeat(64)}`,
      reportArtifact: {
        artifactId: 'artifact-report',
        digest: `sha256:${'4'.repeat(64)}`,
        kind: 'reproduction-report',
      },
      reviewStatus: 'pending',
      committedAt: '2026-08-18T00:00:00.000Z',
      digest: `sha256:${'5'.repeat(64)}`,
    }
    const commit = vi.fn(async () => reproductionReport)
    const dispose = vi.fn(async () => {})
    const start = vi.fn(async () => ({
      id: 'child-experiment',
      result: Promise.resolve({
        stopReason: 'completed',
        structured: {
          result: {
            status: 'completed',
            summary: 'diagnosis ready',
            outputKind: 'reproduction-report',
            candidate,
          },
        },
      }),
      dispose,
    }))
    const ctx = delegationContext(
      start,
      (_parent, _contract, operation: () => unknown) => operation(),
      vi.fn(),
      commit,
      {
        role: 'experiment',
        taskType: 'reproduction',
        requiredSkills: ['paper-reproduction'],
        loadedSkills: ['paper-reproduction'],
        missingSkills: [],
      },
    )
    const tool = createDelegationTool(ctx, 'experiment', {
      strictRoleCapabilities: false,
      capabilityStage: 'phase4',
    })
    const execution = {
      agent: { id: 'root-coordinator' } as Agent,
      signal: new AbortController().signal,
    } as ToolExecution

    const output = await tool.execute({
      taskType: 'reproduction',
      task: 'Produce the final reproduction diagnosis',
    }, execution)

    expect(commit).toHaveBeenCalledWith(execution, candidate)
    expect(output).toMatchObject({ reproductionReport })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('rejects reviewer delegation without an exact subject handoff', async () => {
    const start = vi.fn()
    const ctx = delegationContext(
      start,
      (_parent, _contract, operation: () => unknown) => operation(),
      undefined,
      undefined,
      reviewerSkillState(),
    )
    const tool = createDelegationTool(ctx, 'reviewer', {
      strictRoleCapabilities: false,
      capabilityStage: 'phase6',
    })

    await expect(tool.execute(
      { taskType: 'proposal-review', task: 'Review the proposal' },
      execution(),
    )).rejects.toMatchObject({ code: 'GEORESEARCH_SPECIALIST_TASK_INVALID' })
    expect(start).not.toHaveBeenCalled()
  })

  it('rejects a reviewer candidate that changes the Host-supplied subjects', async () => {
    const expected = resultSubject('result-expected', { result: 'expected' })
    const other = resultSubject('result-other', { result: 'other' })
    const state = projectState({
      results: {
        [expected.subjectId]: { digest: expected.digest },
        [other.subjectId]: { digest: other.digest },
      } as never,
    })
    const dispose = vi.fn(async () => {})
    const start = vi.fn(async () => ({
      id: 'child-reviewer',
      result: Promise.resolve({
        stopReason: 'completed',
        structured: {
          result: {
            status: 'completed',
            summary: 'review complete',
            outputKind: 'review-assessment',
            candidate: reviewProposal([other]),
          },
        },
      }),
      dispose,
    }))
    const ctx = delegationContext(
      start,
      (_parent, _contract, operation: () => unknown) => operation(),
      undefined,
      undefined,
      reviewerSkillState(),
      state,
    )
    const tool = createDelegationTool(ctx, 'reviewer', {
      strictRoleCapabilities: false,
      capabilityStage: 'phase6',
    })

    await expect(tool.execute({
      taskType: 'proposal-review',
      task: 'Review the exact result',
      subjectRefs: [expected],
    }, execution())).rejects.toMatchObject({ code: 'GEORESEARCH_SUBAGENT_OUTPUT_INVALID' })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it.each([
    ['literature', 'evidence-extraction', 'evidence-candidate', ['literature-review']],
    ['experiment', 'reproduction', 'reproduction-report', ['paper-reproduction']],
  ] as const)('rejects an invalid %s specialist candidate before reporting completion', async (
    role,
    taskType,
    outputKind,
    requiredSkills,
  ) => {
    const dispose = vi.fn(async () => {})
    const start = vi.fn(async () => ({
      id: `child-invalid-${role}`,
      result: Promise.resolve({
        stopReason: 'completed',
        structured: {
          result: {
            status: 'completed',
            summary: 'invalid candidate',
            outputKind,
            candidate: { schemaVersion: 1 },
          },
        },
      }),
      dispose,
    }))
    const ctx = delegationContext(
      start,
      (_parent, _contract, operation: () => unknown) => operation(),
      vi.fn(),
      vi.fn(),
      { role, taskType, requiredSkills, loadedSkills: requiredSkills, missingSkills: [] },
    )
    const tool = createDelegationTool(ctx, role, {
      strictRoleCapabilities: false,
      capabilityStage: role === 'experiment' ? 'phase4' : 'phase3',
    })

    await expect(tool.execute({ taskType, task: 'Return a strict candidate' }, execution()))
      .rejects.toMatchObject({
        code: 'GEORESEARCH_SUBAGENT_OUTPUT_INVALID',
        message: expect.stringContaining('returned an invalid structured candidate:'),
      })
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('rejects a stale digest-bound handoff before spawning a child', async () => {
    const current = resultSubject('result-current', { result: 'current' })
    const stale = { ...current, digest: digestJson({ result: 'stale' }) }
    const state = projectState({
      results: { [current.subjectId]: { digest: current.digest } } as never,
    })
    const start = vi.fn()
    const ctx = delegationContext(
      start,
      (_parent, _contract, operation: () => unknown) => operation(),
      undefined,
      undefined,
      undefined,
      state,
    )
    const tool = createDelegationTool(ctx, 'literature', {
      strictRoleCapabilities: false,
      capabilityStage: 'phase3',
    })

    await expect(tool.execute({
      taskType: 'discovery',
      task: 'Use the handed-off result',
      subjectRefs: [stale],
    }, execution())).rejects.toMatchObject({ code: 'GEORESEARCH_SPECIALIST_TASK_INVALID' })
    expect(start).not.toHaveBeenCalled()
  })
})

function delegationContext(
  start: unknown,
  withManagedDelegation: unknown,
  commitEvidenceCandidate: unknown = vi.fn(),
  commitReproductionReportCandidate: unknown = vi.fn(),
  specialistSkillState: unknown = {
    role: 'literature',
    taskType: 'discovery',
    requiredSkills: ['literature-review'],
    loadedSkills: ['literature-review'],
    missingSkills: [],
  },
  state: ProjectReducerState = projectState(),
): Context {
  return {
    geoResearchInstallation: { assertCurrent: vi.fn() },
    geoResearchPolicy: {
      withManagedDelegation,
      specialistSkillStateById: () => specialistSkillState,
    },
    geoResearchEvidence: { commitEvidenceCandidate },
    geoResearchReproduction: { commitReproductionReportCandidate },
    geoResearchProjects: {
      resolveAgent: vi.fn(async () => ({
        stateFile: {
          schemaVersion: 1,
          projectId: state.projectId,
          generation: 1,
          lastEventSeq: 1,
          lastEventHash: digestJson({ event: 1 }),
          state,
          digest: digestJson(state),
        },
        binding: { workspaceId: 'workspace-1', bindingVersion: 1 },
        workspace: { workspaceId: 'workspace-1' },
      })),
    },
    tools: {
      schemas: () => [
        { name: 'read' }, { name: 'skill' }, { name: 'web_search' },
        { name: DELEGATION_BOOTSTRAP_TOOL },
      ],
    },
    subagents: {
      getProvider: () => ({
        capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
      }),
      start,
    },
  } as unknown as Context
}

function execution(): ToolExecution {
  return {
    agent: { id: 'parent-1' } as Agent,
    signal: new AbortController().signal,
  } as ToolExecution
}

function researchReport(kind: 'literature-search-report'): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind,
    methods: ['Crossref bounded search'],
    findings: [{
      findingId: 'finding-1',
      statement: 'A primary source was identified.',
      basisRefs: [],
      confidence: 'moderate',
      limitations: [],
    }],
    limitations: [],
    recommendations: [],
    subjectRefs: [],
    artifactRefs: [],
  }
}

function delegationBootstrapPayload(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    role: 'literature',
    taskType: 'discovery',
    requiredSkills: ['literature-review'],
    completionCriteria: ['Return a bounded source set.'],
    allowedOutputKinds: ['literature-search-report'],
    authority: {
      projectId: 'project-1',
      generation: 1,
      workspaceId: 'workspace-1',
      workspaceBindingVersion: 1,
      subjectRefs: [],
      artifactRefs: [],
    },
    researchQuestion: null,
    constraints: [],
    task: 'Find the primary source.',
  }
}

function reviewerSkillState(): Record<string, unknown> {
  return {
    role: 'reviewer',
    taskType: 'proposal-review',
    requiredSkills: ['scientific-validation', 'literature-review'],
    loadedSkills: ['scientific-validation', 'literature-review'],
    missingSkills: [],
  }
}

function resultSubject(subjectId: string, value: unknown): ValidationSubjectRef {
  return { kind: 'result', subjectId, digest: digestJson(value) }
}

function reviewProposal(subjectRefs: readonly ValidationSubjectRef[]): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'review',
    reviewId: 'review-1',
    subjectRefs,
    validationReportIds: [],
    findings: [],
    recommendation: 'accept',
    supersedesReviewIds: [],
  }
}

function projectState(overrides: Partial<ProjectReducerState> = {}): ProjectReducerState {
  return {
    schemaVersion: 1,
    projectId: 'project-1',
    projectBinding: {
      schemaVersion: 1,
      projectId: 'project-1',
      workspaceIds: ['workspace-1'],
      createdAt: '2026-08-18T00:00:00.000Z',
      updatedAt: '2026-08-18T00:00:00.000Z',
    },
    workspaceBindings: {},
    artifacts: {},
    runs: {},
    sources: {},
    evidence: {},
    repositoryAudits: {},
    reproductionPlans: {},
    reproductionTestSpecs: {},
    reproductionReports: {},
    geodataReports: {},
    datasetManifests: {},
    experimentSpecs: {},
    experimentAmendments: {},
    results: {},
    validationPlans: {},
    validationReports: {},
    reviewRecords: {},
    claims: {},
    writingPackets: {},
    manuscripts: {},
    manuscriptAudits: {},
    activeTaskIds: [],
    blockers: [],
    staleIndicators: [],
    ...overrides,
  }
}
