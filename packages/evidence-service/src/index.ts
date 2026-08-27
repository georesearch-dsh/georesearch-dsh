import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@georesearch/dsh-installation-guard'
import type {} from '@georesearch/dsh-policy'
import type {} from '@georesearch/dsh-project-service'
import {
  registerTool,
  resolveDshHome,
  type Agent,
  type ContentBlock,
  type ToolDefinition,
  type ToolExecution,
} from '@georesearch/dsh-compat-rc5'
import {
  EVIDENCE_CANDIDATE_SCHEMA,
  GeoResearchError,
  LITERATURE_CONTINUE_REQUEST_SCHEMA,
  LITERATURE_SEARCH_REQUEST_SCHEMA,
  LITERATURE_SEARCH_RESULT_SCHEMA,
  PAPER_READ_RESULT_SCHEMA,
  SOURCE_RECORD_SCHEMA,
  parseLiteratureContinuationRequest,
  type CitationCheckResult,
  type EvidenceCandidate,
  type EvidenceRecord,
  type JsonValue,
  type LiteratureSearchResult,
  type PaperReadRequest,
  type PaperReadResult,
  type SourceRecord,
} from '@georesearch/dsh-contracts'
import {
  EvidenceCoordinator,
  type EvidenceCoordinatorConfig,
  type EvidenceRecoveryResult,
} from './coordinator.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    geoResearchEvidence: GeoResearchEvidenceService
  }
}

export const name = 'georesearch-evidence-service'
export const inject = [
  'geoResearchInstallation',
  'geoResearchPolicy',
  'geoResearchProjects',
  'credentials',
  'tools',
]

export interface Config extends Omit<EvidenceCoordinatorConfig, 'home'> {
  readonly home?: string
}

export class GeoResearchEvidenceService extends Service {
  readonly coordinator: EvidenceCoordinator

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'geoResearchEvidence')
    this.coordinator = new EvidenceCoordinator({
      home: resolveDshHome(config.home),
      ...definedConfig(config),
    }, {
      projects: ctx.geoResearchProjects,
      installation: ctx.geoResearchInstallation,
      credentials: ctx.credentials,
    })
    ctx.effect(
      () => async () => this.coordinator.dispose(),
      'georesearch-evidence-service: provider disposal',
    )
  }

  literatureSearch(execution: ToolExecution, value: unknown): Promise<LiteratureSearchResult> {
    return this.coordinator.literatureSearch(execution, value)
  }

  literatureContinue(execution: ToolExecution, continuationId: string): Promise<LiteratureSearchResult> {
    return this.coordinator.literatureContinue(execution, continuationId)
  }

  paperRead(execution: ToolExecution, request: PaperReadRequest): Promise<PaperReadResult> {
    return this.coordinator.paperRead(execution, request)
  }

  sourceResolve(
    execution: ToolExecution,
    chainId: string,
    generation: number,
    providerItemId: string,
  ): Promise<SourceRecord> {
    return this.coordinator.sourceResolve(execution, chainId, generation, providerItemId)
  }

  evidenceCandidate(execution: ToolExecution, value: unknown): Promise<EvidenceCandidate> {
    return this.coordinator.evidenceCandidate(execution, value)
  }

  commitEvidenceCandidate(execution: ToolExecution, value: unknown): Promise<EvidenceRecord> {
    return this.coordinator.commitEvidenceCandidate(execution, value)
  }

  citationCheck(execution: ToolExecution, evidenceId: string): Promise<CitationCheckResult> {
    return this.coordinator.citationCheck(execution, evidenceId)
  }

  recoverAll(force = true): Promise<EvidenceRecoveryResult[]> {
    return this.coordinator.recoverAll(force)
  }

  recoverProject(projectId: string, force = false): Promise<EvidenceRecoveryResult> {
    return this.coordinator.recoverProject(projectId, force)
  }

  drain(): Promise<void> {
    return this.coordinator.drain()
  }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  ctx.geoResearchInstallation.assertCurrent()
  const service = new GeoResearchEvidenceService(ctx, config)
  for (const tool of evidenceTools(ctx)) registerTool(ctx, tool)
  // Candidate activation probes must not migrate user data before active.json commits.
  if (ctx.geoResearchInstallation.maintenanceTransactionId === undefined) {
    const recovered = await service.recoverAll(true)
    for (const report of recovered) {
      if (report.replayErrors.length > 0) {
        ctx.logger.warn(
          `GeoResearch Phase 3 recovery left ${report.replayErrors.length} continuation(s) pending in ${report.projectId}`,
        )
      }
    }
  }
}

export function evidenceTools(ctx: Context): readonly ToolDefinition[] {
  return [
    {
      name: 'literature_search',
      description: 'Search the fixed replay-safe literature provider and create a private crash-safe Search Chain.',
      parameters: LITERATURE_SEARCH_REQUEST_SCHEMA,
      output: { schema: LITERATURE_SEARCH_RESULT_SCHEMA, render: renderJson },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        assertLiteratureExecution(ctx, execution, 'literature_search')
        ctx.geoResearchInstallation.assertCurrent()
        return await ctx.geoResearchEvidence.literatureSearch(execution, args)
      },
    },
    {
      name: 'literature_continue',
      description: 'Advance exactly one opaque literature continuation without accepting query, cursor, page, or provider overrides.',
      parameters: LITERATURE_CONTINUE_REQUEST_SCHEMA,
      output: { schema: LITERATURE_SEARCH_RESULT_SCHEMA, render: renderJson },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        assertLiteratureExecution(ctx, execution, 'literature_continue')
        ctx.geoResearchInstallation.assertCurrent()
        const request = parseLiteratureContinuationRequest(args)
        return await ctx.geoResearchEvidence.literatureContinue(execution, request.continuationId)
      },
    },
    {
      name: 'paper_read',
      description: 'Read bounded digital text from one current registered PDF Artifact through a same-byte verified lease.',
      parameters: PAPER_READ_PARAMETERS,
      output: { schema: PAPER_READ_RESULT_SCHEMA, render: renderJson },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        assertLiteratureExecution(ctx, execution, 'paper_read')
        ctx.geoResearchInstallation.assertCurrent()
        return await ctx.geoResearchEvidence.paperRead(execution, paperReadRequest(args))
      },
    },
    {
      name: 'source_resolve',
      description: 'Resolve and Host-register one exact provider item previously returned by an owned Search Chain generation.',
      parameters: SOURCE_RESOLVE_PARAMETERS,
      output: { schema: SOURCE_RECORD_SCHEMA, render: renderJson },
      isConcurrencySafe: () => false,
      async execute(args, execution) {
        assertLiteratureExecution(ctx, execution, 'source_resolve')
        ctx.geoResearchInstallation.assertCurrent()
        const request = sourceResolveRequest(args)
        return await ctx.geoResearchEvidence.sourceResolve(
          execution,
          request.chainId,
          request.generation,
          request.providerItemId,
        )
      },
    },
    {
      name: 'evidence_candidate',
      description: 'Validate a page-grounded Evidence Candidate against a registered SourceRecord and private paper-read receipt without committing it.',
      parameters: EVIDENCE_CANDIDATE_SCHEMA,
      output: { schema: EVIDENCE_CANDIDATE_SCHEMA, render: renderJson },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        assertLiteratureExecution(ctx, execution, 'evidence_candidate')
        ctx.geoResearchInstallation.assertCurrent()
        return await ctx.geoResearchEvidence.evidenceCandidate(execution, args)
      },
    },
    {
      name: 'citation_check',
      description: 'Check whether one committed EvidenceRecord still has a current Source, Artifact, page receipt, digest, and parser lineage.',
      parameters: CITATION_CHECK_PARAMETERS,
      output: { schema: CITATION_CHECK_RESULT_SCHEMA, render: renderJson },
      isConcurrencySafe: () => true,
      async execute(args, execution) {
        assertLiteratureExecution(ctx, execution, 'citation_check')
        ctx.geoResearchInstallation.assertCurrent()
        const request = exactRecord(args, 'citation_check arguments', ['evidenceId'])
        return await ctx.geoResearchEvidence.citationCheck(
          execution,
          nonEmptyText(request.evidenceId, 'evidenceId'),
        )
      },
    },
  ]
}

const PAPER_READ_PARAMETERS: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    artifactId: { type: 'string', minLength: 1 },
    pageStart: { type: 'integer', minimum: 1 },
    pageEnd: { type: 'integer', minimum: 1 },
  },
  required: ['artifactId'],
})

const SOURCE_RESOLVE_PARAMETERS: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    chainId: { type: 'string', minLength: 1 },
    generation: { type: 'integer', minimum: 1 },
    providerItemId: { type: 'string', minLength: 1 },
  },
  required: ['chainId', 'generation', 'providerItemId'],
})

const CITATION_CHECK_PARAMETERS: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: { evidenceId: { type: 'string', minLength: 1 } },
  required: ['evidenceId'],
})

const CITATION_CHECK_RESULT_SCHEMA: Readonly<Record<string, unknown>> = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    evidenceId: { type: 'string', minLength: 1 },
    sourceId: { type: 'string', minLength: 1 },
    status: { type: 'string', enum: ['valid', 'stale', 'invalid'] },
    checks: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sourceRegistered: { type: 'boolean' },
        artifactCurrent: { type: 'boolean' },
        artifactDigestMatches: { type: 'boolean' },
        pageRangeCovered: { type: 'boolean' },
        parserLineagePresent: { type: 'boolean' },
      },
      required: [
        'sourceRegistered', 'artifactCurrent', 'artifactDigestMatches',
        'pageRangeCovered', 'parserLineagePresent',
      ],
    },
    warnings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          code: { type: 'string', minLength: 1 },
          message: { type: 'string', minLength: 1 },
        },
        required: ['code', 'message'],
      },
    },
  },
  required: ['evidenceId', 'sourceId', 'status', 'checks', 'warnings'],
})

function assertLiteratureExecution(ctx: Context, execution: ToolExecution, operation: string): Agent {
  const agent = execution.agent
  if (agent === undefined
    || ctx.geoResearchPolicy.actorFor(agent) !== 'literature'
    || !ctx.geoResearchPolicy.isManagedChild(agent)) {
    throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', `${operation} requires a managed literature child`)
  }
  return agent
}

function paperReadRequest(value: unknown): PaperReadRequest {
  const record = exactRecord(value, 'paper_read arguments', ['artifactId', 'pageStart', 'pageEnd'])
  return {
    artifactId: nonEmptyText(record.artifactId, 'artifactId'),
    ...(record.pageStart === undefined ? {} : { pageStart: positiveInteger(record.pageStart, 'pageStart') }),
    ...(record.pageEnd === undefined ? {} : { pageEnd: positiveInteger(record.pageEnd, 'pageEnd') }),
  }
}

function sourceResolveRequest(value: unknown): {
  readonly chainId: string
  readonly generation: number
  readonly providerItemId: string
} {
  const record = exactRecord(value, 'source_resolve arguments', ['chainId', 'generation', 'providerItemId'])
  return {
    chainId: nonEmptyText(record.chainId, 'chainId'),
    generation: positiveInteger(record.generation, 'generation'),
    providerItemId: nonEmptyText(record.providerItemId, 'providerItemId'),
  }
}

function definedConfig(config: Config): Omit<EvidenceCoordinatorConfig, 'home'> {
  return {
    ...(config.credentialRef === undefined ? {} : { credentialRef: config.credentialRef }),
    ...(config.pageSize === undefined ? {} : { pageSize: config.pageSize }),
    ...(config.maxPagesPerCall === undefined ? {} : { maxPagesPerCall: config.maxPagesPerCall }),
    ...(config.maxTransparentNoItemPagesPerCall === undefined
      ? {}
      : { maxTransparentNoItemPagesPerCall: config.maxTransparentNoItemPagesPerCall }),
    ...(config.maxChainItems === undefined ? {} : { maxChainItems: config.maxChainItems }),
    ...(config.continuationTtlMs === undefined ? {} : { continuationTtlMs: config.continuationTtlMs }),
    ...(config.pdfTimeoutMs === undefined ? {} : { pdfTimeoutMs: config.pdfTimeoutMs }),
    ...(config.pdfMaxInputBytes === undefined ? {} : { pdfMaxInputBytes: config.pdfMaxInputBytes }),
    ...(config.pdfMaxDocumentPages === undefined ? {} : { pdfMaxDocumentPages: config.pdfMaxDocumentPages }),
    ...(config.pdfMaxPagesPerCall === undefined ? {} : { pdfMaxPagesPerCall: config.pdfMaxPagesPerCall }),
    ...(config.pdfMaxPageTextBytes === undefined ? {} : { pdfMaxPageTextBytes: config.pdfMaxPageTextBytes }),
    ...(config.pdfMaxResultTextBytes === undefined ? {} : { pdfMaxResultTextBytes: config.pdfMaxResultTextBytes }),
    ...(config.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: config.lockTimeoutMs }),
    ...(config.reservationLeaseMs === undefined ? {} : { reservationLeaseMs: config.reservationLeaseMs }),
  }
}

function renderJson(_args: unknown, value: JsonValue): ContentBlock[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

function exactRecord(value: unknown, field: string, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${field} must be an object`)
  const record = value as Record<string, unknown>
  const unexpected = Object.keys(record).filter(key => !fields.includes(key))
  if (unexpected.length > 0) throw new TypeError(`${field} contains unsupported fields: ${unexpected.join(', ')}`)
  return record
}

function nonEmptyText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${field} must be non-empty`)
  return value
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new TypeError(`${field} must be a positive integer`)
  return value as number
}

export * from './coordinator.js'
export * from './store.js'
