import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { assertObjectJsonSchema, assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import {
  PROJECT_SNAPSHOT_SCHEMA,
  RESEARCH_BRIEF_SCHEMA,
  REPOSITORY_AUDIT_SCHEMA,
  REPRODUCTION_PLAN_SCHEMA,
  REPRODUCTION_REPORT_CANDIDATE_SCHEMA,
  REPRODUCTION_TEST_SPEC_SCHEMA,
  RUN_RECORD_SCHEMA,
} from '@georesearch/dsh-contracts'
import { describe, expect, it, vi } from 'vitest'
import { startOneShot, toHarnessToolSchema } from '../src/index.js'

const UNSUPPORTED_KEYWORDS = new Set([
  '$id',
  '$schema',
  'allOf',
  'if',
  'minLength',
  'minimum',
  'pattern',
  'then',
  'uniqueItems',
])

describe('Harness rc.5 tool schema projection', () => {
  it.each([
    ['ResearchBrief', RESEARCH_BRIEF_SCHEMA],
    ['ProjectSnapshot', PROJECT_SNAPSHOT_SCHEMA],
    ['RunRecord', RUN_RECORD_SCHEMA],
    ['RepositoryAudit', REPOSITORY_AUDIT_SCHEMA],
    ['ReproductionPlan', REPRODUCTION_PLAN_SCHEMA],
    ['ReproductionTestSpec', REPRODUCTION_TEST_SPEC_SCHEMA],
    ['ReproductionReportCandidate', REPRODUCTION_REPORT_CANDIDATE_SCHEMA],
  ])('projects the authoritative %s schema into the enforced subset', (_name, schema) => {
    const projected = toHarnessToolSchema(schema)
    expect(() => assertSupportedJsonSchema(projected)).not.toThrow()
    expect(unsupportedPaths(projected)).toEqual([])
    expect(untypedConstPaths(projected)).toEqual([])
  })

  it('infers scalar types and degrades schema-valued additionalProperties to open JSON', () => {
    expect(toHarnessToolSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: { type: 'string' },
      properties: {
        schemaVersion: { const: 1, minimum: 1 },
        mode: { enum: ['fast', 'strict'] },
        values: {
          type: 'array',
          minItems: 1,
          uniqueItems: true,
          items: { type: 'string', minLength: 1 },
        },
      },
      required: ['schemaVersion', 'mode', 'values'],
      allOf: [{ if: { properties: { mode: { const: 'strict' } } }, then: { required: ['values'] } }],
    })).toEqual({
      type: 'object',
      additionalProperties: true,
      properties: {
        schemaVersion: { type: 'integer', const: 1 },
        mode: { type: 'string', enum: ['fast', 'strict'] },
        values: { type: 'array', minItems: 1, items: { type: 'string' } },
      },
      required: ['schemaVersion', 'mode', 'values'],
    })
  })

  it('projects JSON Schema nullable type arrays to the supported oneOf form', () => {
    expect(toHarnessToolSchema({
      type: 'object',
      properties: {
        remoteUrl: { type: ['string', 'null'], minLength: 1 },
      },
      required: ['remoteUrl'],
      additionalProperties: false,
    })).toEqual({
      type: 'object',
      properties: {
        remoteUrl: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['remoteUrl'],
      additionalProperties: false,
    })
  })

  it('projects one-shot subagent output schemas before Harness validation', async () => {
    const authoritativeSchema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { const: 'completed' },
        summary: { type: 'string', minLength: 1 },
      },
      required: ['status', 'summary'],
    }
    const start = vi.fn(async (_provider: string, request: SubagentStartRequest) => {
      assertObjectJsonSchema(request.outputSchema)
      return {} as SubagentRun
    })
    const ctx = {
      subagents: {
        getProvider: () => ({
          capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
        }),
        start,
      },
    } as unknown as Context
    const request: SubagentStartRequest = {
      prompt: [],
      parent: {} as Agent,
      signal: new AbortController().signal,
      outputSchema: authoritativeSchema as NonNullable<SubagentStartRequest['outputSchema']>,
    }

    await expect(startOneShot(ctx, request)).resolves.toBeDefined()
    const projected = start.mock.calls[0]?.[1].outputSchema
    expect(projected).toEqual(toHarnessToolSchema(authoritativeSchema))
    expect(projected).not.toBe(request.outputSchema)
  })
})

function unsupportedPaths(value: unknown, path = 'schema'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => unsupportedPaths(entry, `${path}[${index}]`))
  }
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, entry]) => [
    ...(UNSUPPORTED_KEYWORDS.has(key) ? [`${path}.${key}`] : []),
    ...unsupportedPaths(entry, `${path}.${key}`),
  ])
}

function untypedConstPaths(value: unknown, path = 'schema'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => untypedConstPaths(entry, `${path}[${index}]`))
  }
  if (typeof value !== 'object' || value === null) return []
  const record = value as Record<string, unknown>
  return [
    ...(Object.hasOwn(record, 'const') && !Object.hasOwn(record, 'type') && !Object.hasOwn(record, 'oneOf')
      ? [path]
      : []),
    ...Object.entries(record).flatMap(([key, entry]) => untypedConstPaths(entry, `${path}.${key}`)),
  ]
}
