import { randomBytes } from 'node:crypto'
import {
  credentialReference,
  operationIdentity,
  parentSessionId,
  roleOf,
  type Agent,
  type CredentialProvider,
  type CredentialRef,
  type ToolExecution,
} from '@georesearch/dsh-compat-rc5'
import {
  GeoResearchError,
  canonicalJson,
  digestPhase3Body,
  normalizeLiteratureSearchRequest,
  operationKeyFor,
  parseEvidenceCandidate,
  parseLiteratureSearchResult,
  requestDigestFor,
  type CitationCheckResult,
  type ContinuationAdvanceOutcome,
  type EvidenceCandidate,
  type EvidenceRecord,
  type JsonValue,
  type LiteratureContinuationOwner,
  type LiteratureContinuationProviderBinding,
  type LiteratureContinuationRecord,
  type LiteratureContinuationReservation,
  type LiteratureItem,
  type LiteratureProviderTrace,
  type LiteratureSearchChainRecord,
  type LiteratureSearchRequest,
  type LiteratureSearchResult,
  type LiteratureStopReason,
  type LiteratureWarning,
  type PaperPageText,
  type PaperReadLineage,
  type PaperReadRequest,
  type PaperReadResult,
  type ProjectStateFile,
  type Sha256Digest,
  type SourceRecord,
} from '@georesearch/dsh-contracts'
import type { GeoResearchInstallation } from '@georesearch/dsh-installation-guard'
import {
  PDFJS_PARSER_VERSION,
  PDF_READ_LIMITS,
  readPdfDocument,
} from '@georesearch/dsh-file-service/pdf'
import type {
  EvidenceRecordCommitRequest,
  GeoResearchProjectService,
  ResolvedArtifactReadLease,
  ResolvedProject,
  SourceRecordCommitRequest,
} from '@georesearch/dsh-project-service'
import {
  CrossrefLiteratureProvider,
  type LiteratureProvider,
  type LiteratureProviderCredential,
} from '@georesearch/dsh-evidence-providers'
import {
  ContinuationFileStore,
  continuationDigest,
  continuationStateBinding,
  type ContinuationRecoveryReport,
  type PaperReadReceipt,
} from './store.js'

const PROVIDER_ID = 'georesearch-pdf-read'
const PROVIDER_VERSION = '1.0.0'
const PARSER_ID = 'pdfjs-dist'
const TRANSITION_RETRIES = 6

type ProjectGateway = Pick<
  GeoResearchProjectService,
  | 'resolveAgent'
  | 'withVerifiedReadLease'
  | 'loadProject'
  | 'listProjectStates'
  | 'commitSourceRecord'
  | 'commitEvidenceRecord'
>

type InstallationGateway = Pick<
  GeoResearchInstallation,
  'operatorScopeId' | 'credentialFingerprint' | 'sealPrivateState' | 'openPrivateState'
>

type CredentialGateway = Pick<CredentialProvider, 'resolve'>

export interface EvidenceFaultContext {
  readonly projectId: string
  readonly continuationIdDigest: Sha256Digest
  readonly reservationEpoch: number
  readonly fence: Sha256Digest
}

export interface EvidenceFaultHooks {
  readonly afterDispatchBarrier?: (context: EvidenceFaultContext) => void | Promise<void>
  readonly afterProviderResponseBeforeOutcome?: (context: EvidenceFaultContext) => void | Promise<void>
  readonly afterOutcomeBeforeConsume?: (context: EvidenceFaultContext) => void | Promise<void>
}

export interface EvidenceCoordinatorConfig {
  readonly home: string
  readonly credentialRef?: string | null
  readonly pageSize?: number
  readonly maxPagesPerCall?: number
  readonly maxTransparentNoItemPagesPerCall?: number
  readonly maxChainItems?: number
  readonly continuationTtlMs?: number
  readonly pdfTimeoutMs?: number
  readonly pdfMaxInputBytes?: number
  readonly pdfMaxDocumentPages?: number
  readonly pdfMaxPagesPerCall?: number
  readonly pdfMaxPageTextBytes?: number
  readonly pdfMaxResultTextBytes?: number
  readonly lockTimeoutMs?: number
  readonly reservationLeaseMs?: number
}

export interface EvidenceCoordinatorDependencies {
  readonly projects: ProjectGateway
  readonly installation: InstallationGateway
  readonly credentials: CredentialGateway
  readonly provider?: LiteratureProvider
  readonly store?: ContinuationFileStore
  readonly now?: () => string
  readonly randomToken?: () => string
  readonly faults?: EvidenceFaultHooks
}

export interface EvidenceRecoveryResult extends ContinuationRecoveryReport {
  readonly replayedOutcomeIds: readonly Sha256Digest[]
  readonly replayErrors: readonly string[]
}

interface LiteratureOperationContext {
  readonly agent: Agent
  readonly resolved: ResolvedProject
  readonly owner: LiteratureContinuationOwner
}

interface SearchAdvance {
  readonly items: readonly LiteratureItem[]
  readonly warnings: readonly LiteratureWarning[]
  readonly pagesAdvanced: number
  readonly nextUpstreamState: JsonValue | null
  readonly done: boolean
  readonly stopReason?: LiteratureStopReason
  readonly requestId: string | null
  readonly allowContinuation: boolean
}

interface PdfRangeRead {
  readonly pageCount: number
  readonly completedEnd: number
  readonly pages: readonly PaperPageText[]
  readonly metadata: PaperReadResult['metadata']
  readonly partialReason?: 'page-limit' | 'result-text-limit'
}

interface ReservedAdvanceResult {
  readonly result: LiteratureSearchResult
  readonly advanceId: Sha256Digest
}

export class EvidenceCoordinator {
  readonly provider: LiteratureProvider
  readonly store: ContinuationFileStore
  readonly lineage: PaperReadLineage

  private readonly projects: ProjectGateway
  private readonly installation: InstallationGateway
  private readonly credentials: CredentialGateway
  private readonly configuredCredentialRef: CredentialRef | null
  private readonly pageSize: number
  private readonly maxPagesPerCall: number
  private readonly maxTransparentNoItemPagesPerCall: number
  private readonly maxChainItems: number
  private readonly continuationTtlMs: number
  private readonly pdfTimeoutMs: number
  private readonly pdfMaxInputBytes: number
  private readonly pdfMaxDocumentPages: number
  private readonly pdfMaxPagesPerCall: number
  private readonly pdfMaxPageTextBytes: number
  private readonly pdfMaxResultTextBytes: number
  private readonly clock: () => string
  private readonly token: () => string
  private readonly faults: EvidenceFaultHooks
  private readonly initialFlights = new Map<string, Promise<LiteratureSearchResult>>()
  private readonly advanceFlights = new Map<string, Promise<ReservedAdvanceResult>>()

  constructor(config: EvidenceCoordinatorConfig, dependencies: EvidenceCoordinatorDependencies) {
    this.projects = dependencies.projects
    this.installation = dependencies.installation
    this.credentials = dependencies.credentials
    this.provider = dependencies.provider ?? new CrossrefLiteratureProvider()
    this.clock = dependencies.now ?? (() => new Date().toISOString())
    this.token = dependencies.randomToken ?? (() => randomBytes(32).toString('base64url'))
    this.faults = dependencies.faults ?? {}
    this.configuredCredentialRef = config.credentialRef === undefined || config.credentialRef === null
      ? null
      : credentialReference(config.credentialRef)
    if (this.configuredCredentialRef !== null && !this.provider.capability.supportsCredentialRef) {
      throw new GeoResearchError('LITERATURE_PROVIDER_INCOMPATIBLE', 'configured provider does not support credential references')
    }
    this.pageSize = boundedInteger(config.pageSize ?? 25, 1, this.provider.capability.maxPageSize, 'pageSize')
    this.maxPagesPerCall = boundedInteger(config.maxPagesPerCall ?? 4, 1, 20, 'maxPagesPerCall')
    this.maxTransparentNoItemPagesPerCall = boundedInteger(
      config.maxTransparentNoItemPagesPerCall ?? 2,
      1,
      this.maxPagesPerCall,
      'maxTransparentNoItemPagesPerCall',
    )
    this.maxChainItems = boundedInteger(config.maxChainItems ?? 1_000, 1, 10_000, 'maxChainItems')
    this.continuationTtlMs = boundedInteger(
      config.continuationTtlMs ?? 24 * 60 * 60 * 1_000,
      60_000,
      30 * 24 * 60 * 60 * 1_000,
      'continuationTtlMs',
    )
    this.pdfTimeoutMs = boundedInteger(config.pdfTimeoutMs ?? 30_000, 1_000, 120_000, 'pdfTimeoutMs')
    this.pdfMaxInputBytes = boundedInteger(
      config.pdfMaxInputBytes ?? PDF_READ_LIMITS.maxInputBytes,
      1,
      PDF_READ_LIMITS.maxInputBytes,
      'pdfMaxInputBytes',
    )
    this.pdfMaxDocumentPages = boundedInteger(
      config.pdfMaxDocumentPages ?? PDF_READ_LIMITS.maxDocumentPages,
      1,
      PDF_READ_LIMITS.maxDocumentPages,
      'pdfMaxDocumentPages',
    )
    this.pdfMaxPagesPerCall = boundedInteger(
      config.pdfMaxPagesPerCall ?? PDF_READ_LIMITS.maxPagesPerCall,
      1,
      PDF_READ_LIMITS.maxPagesPerCall,
      'pdfMaxPagesPerCall',
    )
    this.pdfMaxPageTextBytes = boundedInteger(
      config.pdfMaxPageTextBytes ?? PDF_READ_LIMITS.maxPageTextBytes,
      1,
      PDF_READ_LIMITS.maxPageTextBytes,
      'pdfMaxPageTextBytes',
    )
    this.pdfMaxResultTextBytes = boundedInteger(
      config.pdfMaxResultTextBytes ?? PDF_READ_LIMITS.maxResultTextBytes,
      this.pdfMaxPageTextBytes,
      PDF_READ_LIMITS.maxResultTextBytes,
      'pdfMaxResultTextBytes',
    )
    this.store = dependencies.store ?? new ContinuationFileStore({
      home: config.home,
      ...(config.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: config.lockTimeoutMs }),
      ...(config.reservationLeaseMs === undefined ? {} : { reservationLeaseMs: config.reservationLeaseMs }),
      now: this.clock,
    })
    this.lineage = Object.freeze({
      providerId: PROVIDER_ID,
      providerVersion: PROVIDER_VERSION,
      parserId: PARSER_ID,
      parserVersion: PDFJS_PARSER_VERSION,
      configDigest: digestPhase3Body({
        domain: 'georesearch.paper-read-config/v1',
        maxInputBytes: this.pdfMaxInputBytes,
        maxDocumentPages: this.pdfMaxDocumentPages,
        maxPagesPerCall: this.pdfMaxPagesPerCall,
        maxPageTextBytes: this.pdfMaxPageTextBytes,
        maxResultTextBytes: this.pdfMaxResultTextBytes,
        timeoutMs: this.pdfTimeoutMs,
      }),
    })
  }

  async literatureSearch(execution: ToolExecution, value: unknown): Promise<LiteratureSearchResult> {
    const context = await this.literatureContext(execution, 'literature_search')
    let request: LiteratureSearchRequest
    try {
      request = normalizeLiteratureSearchRequest(value)
    } catch (error) {
      throw new GeoResearchError('LITERATURE_INVALID_REQUEST', 'literature search arguments are invalid', { cause: error })
    }
    const operationKey = operationKeyFor(operationIdentity(
      execution,
      context.resolved.stateFile.projectId,
      'literature_search',
    ))
    const requestDigest = digestPhase3Body(request)
    const replay = await this.store.initialReplay(context.resolved.stateFile.projectId, operationKey, requestDigest)
    if (replay !== undefined) return replay
    const flightKey = `${context.resolved.stateFile.projectId}\0${operationKey}`
    const existing = this.initialFlights.get(flightKey)
    if (existing !== undefined) return await existing
    const flight = this.runInitialSearch(context, request, operationKey, requestDigest, execution.signal)
    this.initialFlights.set(flightKey, flight)
    try {
      return await flight
    } finally {
      if (this.initialFlights.get(flightKey) === flight) this.initialFlights.delete(flightKey)
    }
  }

  async literatureContinue(execution: ToolExecution, continuationId: string): Promise<LiteratureSearchResult> {
    const context = await this.literatureContext(execution, 'literature_continue')
    const projectId = context.resolved.stateFile.projectId
    const operationKey = operationKeyFor(operationIdentity(execution, projectId, 'literature_continue'))
    const continuationIdDigest = continuationDigest(continuationId)
    const requestDigest = digestPhase3Body({
      domain: 'georesearch.literature-continue-request/v1',
      continuationIdDigest,
    })
    const resolvedCredential = await this.resolveCredential(projectId)
    const reservation = await this.store.reserve(
      projectId,
      continuationId,
      context.owner,
      resolvedCredential.providerBinding,
      operationKey,
      requestDigest,
    )
    if (reservation.kind === 'replay') return reservation.result
    const flightKey = advanceFlightKey(projectId, continuationIdDigest, reservation.reservation.operationKey)
    if (reservation.kind === 'same-operation-in-progress') {
      const existing = this.advanceFlights.get(flightKey)
      if (existing !== undefined) return (await existing).result
      throw new GeoResearchError(
        'LITERATURE_CONTINUATION_RECOVERY_REQUIRED',
        'the matching continuation operation is owned by another process or requires lease recovery',
      )
    }
    const flight = this.runReservedAdvance(
      projectId,
      reservation.continuation,
      reservation.reservation,
      resolvedCredential.credential,
      execution.signal,
    )
    this.advanceFlights.set(flightKey, flight)
    try {
      return (await flight).result
    } finally {
      if (this.advanceFlights.get(flightKey) === flight) this.advanceFlights.delete(flightKey)
    }
  }

  async paperRead(execution: ToolExecution, request: PaperReadRequest): Promise<PaperReadResult> {
    const context = await this.literatureContext(execution, 'paper_read')
    const pageStart = request.pageStart ?? 1
    if (!Number.isSafeInteger(pageStart) || pageStart < 1) {
      throw new GeoResearchError('PDF_PAGE_RANGE_INVALID', 'pageStart must be a positive integer')
    }
    if (request.pageEnd !== undefined
      && (!Number.isSafeInteger(request.pageEnd) || request.pageEnd < pageStart)) {
      throw new GeoResearchError('PDF_PAGE_RANGE_INVALID', 'pageEnd must be an integer at or after pageStart')
    }
    const artifact = context.resolved.stateFile.state.artifacts[request.artifactId]
    if (artifact === undefined || artifact.materialization !== 'committed' || artifact.validity !== 'current') {
      throw new GeoResearchError('PDF_ARTIFACT_REQUIRED', 'paper_read requires a current committed Artifact')
    }
    if (artifact.mediaType !== 'application/pdf') {
      throw new GeoResearchError('PDF_ARTIFACT_REQUIRED', `artifact ${request.artifactId} is not application/pdf`)
    }
    if (artifact.size > this.pdfMaxInputBytes) {
      throw new GeoResearchError('PDF_INPUT_TOO_LARGE', `PDF exceeds ${this.pdfMaxInputBytes} bytes`)
    }
    const timeout = AbortSignal.timeout(this.pdfTimeoutMs)
    const signal = AbortSignal.any([execution.signal, timeout])
    let parsed: PdfRangeRead
    let leaseDigest: Sha256Digest
    try {
      parsed = await this.projects.withVerifiedReadLease(
        context.agent,
        request.artifactId,
        { maxBytes: this.pdfMaxInputBytes, signal },
        async lease => {
          leaseDigest = lease.digest
          return await this.readPdfRange(lease, pageStart, request.pageEnd ?? null, signal)
        },
      )
    } catch (error) {
      if (timeout.aborted && !execution.signal.aborted) {
        throw new GeoResearchError('PDF_TIMEOUT', `PDF parsing exceeded ${this.pdfTimeoutMs} ms`, { cause: error })
      }
      throw normalizePdfError(error)
    }
    const pdfDigest = leaseDigest!
    const createdAt = this.clock()
    const readReceiptId = `paper-read-${this.token()}`
    const receiptBody = {
      schemaVersion: 1 as const,
      readReceiptId,
      projectBindingId: context.owner.projectBindingId,
      rootSessionId: context.owner.rootSessionId,
      operatorScopeId: context.owner.operatorScopeId,
      artifactId: request.artifactId,
      artifactDigest: pdfDigest,
      pageCount: parsed.pageCount,
      pageStart,
      pageEnd: parsed.completedEnd,
      pageTextDigests: Object.fromEntries(parsed.pages.map(page => [
        String(page.page),
        digestPhase3Body({ page: page.page, text: page.text, textBytes: page.textBytes }),
      ])) as Readonly<Record<string, Sha256Digest>>,
      lineage: this.lineage,
      createdAt,
    }
    const receipt: PaperReadReceipt = {
      ...receiptBody,
      readReceiptDigest: digestPhase3Body(receiptBody),
    }
    await this.store.savePaperReadReceipt(context.resolved.stateFile.projectId, receipt)
    const requestedEnd = request.pageEnd ?? null
    const requestedTarget = requestedEnd ?? parsed.pageCount
    const completeness = parsed.completedEnd >= requestedTarget ? 'complete' : 'partial'
    const warnings: LiteratureWarning[] = []
    const textStatus = parsed.pages.some(page => page.text.trim().length > 0)
      ? 'extractable'
      : 'no-extractable-text'
    if (textStatus === 'no-extractable-text') {
      warnings.push({
        code: 'PDF_NO_EXTRACTABLE_TEXT',
        message: 'No extractable digital text was found in the completed page range.',
      })
    }
    return {
      artifactId: request.artifactId,
      pdfDigest,
      pageCount: parsed.pageCount,
      requestedRange: { start: pageStart, end: requestedEnd },
      completedRange: { start: pageStart, end: parsed.completedEnd },
      completeness,
      ...(completeness === 'complete'
        ? {}
        : {
            partialReason: parsed.partialReason ?? 'page-limit',
            nextPageStart: parsed.completedEnd + 1,
          }),
      textStatus,
      metadata: parsed.metadata,
      pages: parsed.pages,
      warnings,
      lineage: this.lineage,
      readReceiptId: receipt.readReceiptId,
      readReceiptDigest: receipt.readReceiptDigest,
    }
  }

  async sourceResolve(
    execution: ToolExecution,
    chainId: string,
    generation: number,
    providerItemId: string,
  ): Promise<SourceRecord> {
    const context = await this.literatureContext(execution, 'source_resolve')
    const projectId = context.resolved.stateFile.projectId
    const material = await this.store.sourceMaterial(
      projectId,
      chainId,
      generation,
      providerItemId,
      context.owner,
    )
    const stableIdentifier = sourceStableIdentifier(material.item)
    const sourceId = `source-${digestPhase3Body({
      domain: 'georesearch.source-id/v1',
      providerId: material.providerTrace.providerId,
      stableIdentifier,
    }).slice('sha256:'.length)}`
    const body = {
      schemaVersion: 1 as const,
      sourceId,
      title: material.item.title,
      authors: material.item.authors,
      year: material.item.year,
      venue: material.item.venue,
      stableIdentifier,
      sourceType: material.item.sourceType,
      versionRelation: { kind: 'none' as const, relatedIdentifier: null },
      retrievedAt: material.providerTrace.retrievedAt,
      providerTrace: material.providerTrace,
      codeRefs: [],
      dataRefs: [],
      status: 'resolved' as const,
      searchChain: { chainId, generation, providerItemId },
    }
    const source: SourceRecord = { ...body, digest: digestPhase3Body(body) }
    const existing = (await this.projects.loadProject(projectId)).state.sources?.[sourceId]
    if (existing !== undefined) return requireCompatibleSource(existing, source)
    const operationKey = operationKeyFor(operationIdentity(execution, projectId, 'source_resolve'))
    const requestDigest = requestDigestFor('source_resolve', {
      chainId,
      generation,
      providerItemId,
    })
    try {
      await this.commitSourceWithRetry(projectId, { operationKey, requestDigest, source })
    } catch (error) {
      if (error instanceof GeoResearchError && error.code === 'SOURCE_INVALID') {
        const concurrent = (await this.projects.loadProject(projectId)).state.sources?.[sourceId]
        if (concurrent !== undefined) return requireCompatibleSource(concurrent, source)
      }
      throw error
    }
    return source
  }

  async evidenceCandidate(execution: ToolExecution, value: unknown): Promise<EvidenceCandidate> {
    const context = await this.literatureContext(execution, 'evidence_candidate')
    let candidate: EvidenceCandidate
    try {
      candidate = parseEvidenceCandidate(value)
    } catch (error) {
      throw new GeoResearchError('EVIDENCE_CANDIDATE_INVALID', 'evidence candidate schema is invalid', { cause: error })
    }
    await this.validateEvidenceCandidate(context.agent, context.resolved, context.owner.rootSessionId, candidate)
    return candidate
  }

  async commitEvidenceCandidate(execution: ToolExecution, value: unknown): Promise<EvidenceRecord> {
    const agent = exactAgent(execution, 'commitEvidenceCandidate')
    if (roleOf(agent) !== undefined || parentSessionId(agent) !== undefined) {
      throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', 'only the root GeoResearch coordinator may commit evidence')
    }
    const resolved = await this.projects.resolveAgent(agent)
    let candidate: EvidenceCandidate
    try {
      candidate = parseEvidenceCandidate(value)
    } catch (error) {
      throw new GeoResearchError('EVIDENCE_CANDIDATE_INVALID', 'evidence candidate schema is invalid', { cause: error })
    }
    const receipt = await this.validateEvidenceCandidate(agent, resolved, String(agent.session.id), candidate)
    const evidenceId = `evidence-${digestPhase3Body({
      domain: 'georesearch.evidence-id/v1',
      candidate,
      readReceiptDigest: receipt.readReceiptDigest,
    }).slice('sha256:'.length)}`
    const current = await this.projects.loadProject(resolved.stateFile.projectId)
    const existing = current.state.evidence?.[evidenceId]
    if (existing !== undefined) return existing
    const body = {
      ...candidate,
      evidenceId,
      artifactDigest: receipt.artifactDigest,
      extractionLineage: receipt.lineage,
      reviewStatus: 'pending' as const,
      committedAt: this.clock(),
    }
    const { reviewStatus: ignoredReviewStatus, ...stableBody } = body
    void ignoredReviewStatus
    const evidence: EvidenceRecord = { ...body, digest: digestPhase3Body(stableBody) }
    const operationKey = operationKeyFor(operationIdentity(execution, resolved.stateFile.projectId, 'evidence.commit'))
    const requestDigest = requestDigestFor('evidence.commit', candidate as unknown as JsonValue)
    return await this.commitEvidenceWithRetry(
      resolved.stateFile.projectId,
      { operationKey, requestDigest, evidence },
    )
  }

  async citationCheck(execution: ToolExecution, evidenceId: string): Promise<CitationCheckResult> {
    const context = await this.literatureContext(execution, 'citation_check')
    const state = await this.projects.loadProject(context.resolved.stateFile.projectId)
    const evidence = state.state.evidence?.[evidenceId]
    if (evidence === undefined) throw new GeoResearchError('EVIDENCE_NOT_FOUND', `evidence ${evidenceId} is unknown`)
    const sourceRegistered = state.state.sources?.[evidence.sourceId] !== undefined
    const artifact = state.state.artifacts[evidence.artifactId]
    const artifactCurrent = artifact?.materialization === 'committed' && artifact.validity === 'current'
    const artifactDigestMatches = artifact?.digest === evidence.artifactDigest
    let receipt: PaperReadReceipt | undefined
    try {
      receipt = await this.store.paperReadReceipt(state.projectId, evidence.paperReadReceiptId)
    } catch (error) {
      if (!(error instanceof GeoResearchError) || error.code !== 'EVIDENCE_READ_RECEIPT_NOT_FOUND') throw error
    }
    const pageRangeCovered = receipt !== undefined
      && receipt.artifactId === evidence.artifactId
      && receipt.artifactDigest === evidence.artifactDigest
      && receipt.pageStart <= evidence.locator.pageStart
      && receipt.pageEnd >= evidence.locator.pageEnd
    const parserLineagePresent = nonEmptyLineage(evidence.extractionLineage)
      && receipt !== undefined
      && canonicalJson(receipt.lineage) === canonicalJson(evidence.extractionLineage)
    const checks = {
      sourceRegistered,
      artifactCurrent,
      artifactDigestMatches,
      pageRangeCovered,
      parserLineagePresent,
    }
    const warnings = Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([check]) => ({
        code: `CITATION_${check.replace(/[A-Z]/gu, character => `_${character}`).toUpperCase()}_FAILED`,
        message: `Citation check ${check} did not pass.`,
      }))
    const status = Object.values(checks).every(Boolean)
      ? 'valid'
      : sourceRegistered && pageRangeCovered && parserLineagePresent
        ? 'stale'
        : 'invalid'
    return { evidenceId, sourceId: evidence.sourceId, status, checks, warnings }
  }

  async recoverAll(force = true): Promise<EvidenceRecoveryResult[]> {
    const states = await this.projects.listProjectStates()
    const results: EvidenceRecoveryResult[] = []
    for (const state of states) results.push(await this.recoverProject(state.projectId, force))
    return results
  }

  async recoverProject(projectId: string, force = false): Promise<EvidenceRecoveryResult> {
    const initial = await this.store.recover(projectId)
    const replayedOutcomeIds: Sha256Digest[] = []
    const replayErrors: string[] = []
    for (const continuationIdDigest of initial.pendingReplayContinuationDigests) {
      const recovered = await this.store.reserveRecovery(projectId, continuationIdDigest, force)
      if (recovered === undefined) continue
      try {
        const resolvedCredential = await this.resolveCredential(projectId)
        if (!sameProviderBinding(recovered.continuation.providerBinding, resolvedCredential.providerBinding)) {
          await this.store.revoke(projectId, continuationIdDigest, 'LITERATURE_PROVIDER_INCOMPATIBLE')
          replayErrors.push(`${continuationIdDigest}: provider or credential binding changed`)
          continue
        }
        const result = await this.runReservedAdvance(
          projectId,
          recovered.continuation,
          recovered.reservation,
          resolvedCredential.credential,
          undefined,
        )
        replayedOutcomeIds.push(result.advanceId)
      } catch (error) {
        replayErrors.push(`${continuationIdDigest}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return { ...initial, replayedOutcomeIds, replayErrors }
  }

  drain(): Promise<void> {
    return this.provider.drain()
  }

  dispose(): Promise<void> {
    return this.provider.dispose()
  }

  private async runInitialSearch(
    context: LiteratureOperationContext,
    request: LiteratureSearchRequest,
    operationKey: Sha256Digest,
    requestDigest: Sha256Digest,
    signal: AbortSignal,
  ): Promise<LiteratureSearchResult> {
    const projectId = context.resolved.stateFile.projectId
    const resolvedCredential = await this.resolveCredential(projectId)
    const summary = await this.advancePages(
      request,
      this.provider.initialUpstreamState(),
      new Set(),
      resolvedCredential.credential,
      signal,
    )
    const chainId = `chain-${digestPhase3Body({
      domain: 'georesearch.search-chain-id/v1',
      projectBindingId: context.owner.projectBindingId,
      rootSessionId: context.owner.rootSessionId,
      requestDigest,
      providerBinding: resolvedCredential.providerBinding,
      operationKey,
    }).slice('sha256:'.length)}`
    const now = this.clock()
    const continuation = summary.allowContinuation && summary.nextUpstreamState !== null
      ? this.createContinuation(
          chainId,
          1,
          context.owner,
          resolvedCredential.providerBinding,
          summary.nextUpstreamState,
          now,
        )
      : undefined
    const result = this.searchResult(
      requestDigest,
      chainId,
      1,
      0,
      0,
      summary,
      resolvedCredential.providerBinding,
      continuation?.reference,
      now,
    )
    const itemsByProviderId = Object.fromEntries(result.items.map(item => [item.providerItemId, item]))
    const chain: LiteratureSearchChainRecord = {
      schemaVersion: 1,
      chainId,
      owner: context.owner,
      request,
      requestDigest,
      providerBinding: resolvedCredential.providerBinding,
      pagesAdvanced: summary.pagesAdvanced,
      uniqueItemCount: result.items.length,
      seenProviderItemIds: result.items.map(item => item.providerItemId).sort(),
      itemsByProviderId,
      createdAt: now,
      updatedAt: now,
    }
    return await this.store.commitInitial(projectId, {
      operationKey,
      requestDigest,
      chain,
      ...(continuation === undefined ? {} : { continuation: continuation.record }),
      result,
    })
  }

  private async runReservedAdvance(
    projectId: string,
    continuation: LiteratureContinuationRecord,
    reservation: LiteratureContinuationReservation,
    credential: LiteratureProviderCredential,
    signal: AbortSignal | undefined,
  ): Promise<ReservedAdvanceResult> {
    const binding = continuationStateBinding(
      continuation.continuationIdDigest,
      continuation.chainId,
      continuation.generation,
      continuation.owner,
      continuation.providerBinding,
    )
    let upstreamState: JsonValue
    try {
      upstreamState = this.installation.openPrivateState(continuation.encryptedUpstreamState, binding)
      if (digestPhase3Body(upstreamState) !== continuation.upstreamStateDigest) {
        throw new GeoResearchError('LITERATURE_CONTINUATION_REVOKED', 'continuation state digest is invalid')
      }
    } catch (error) {
      await this.store.revoke(projectId, continuation.continuationIdDigest, 'LITERATURE_CONTINUATION_REVOKED')
      throw error
    }
    let dispatched = false
    try {
      await this.store.markDispatched(projectId, continuation.continuationIdDigest, reservation)
      dispatched = true
      const faultContext = evidenceFaultContext(projectId, continuation.continuationIdDigest, reservation)
      await this.faults.afterDispatchBarrier?.(faultContext)
      const chain = await this.store.chain(projectId, continuation.chainId, continuation.owner)
      const summary = await this.advancePages(
        chain.request,
        upstreamState,
        new Set(chain.seenProviderItemIds),
        credential,
        signal,
      )
      const now = this.clock()
      const generation = continuation.generation + 1
      const successor = summary.allowContinuation && summary.nextUpstreamState !== null
        ? this.createContinuation(
            continuation.chainId,
            generation,
            continuation.owner,
            continuation.providerBinding,
            summary.nextUpstreamState,
            now,
          )
        : undefined
      const result = this.searchResult(
        chain.requestDigest,
        chain.chainId,
        generation,
        chain.pagesAdvanced,
        chain.uniqueItemCount,
        summary,
        continuation.providerBinding,
        successor?.reference,
        now,
      )
      await this.faults.afterProviderResponseBeforeOutcome?.(faultContext)
      const advanceId = digestPhase3Body({
        domain: 'georesearch.continuation-advance/v1',
        continuationIdDigest: continuation.continuationIdDigest,
        generation: continuation.generation,
        reservationEpoch: reservation.reservationEpoch,
        operationKey: reservation.operationKey,
      })
      const outcome: ContinuationAdvanceOutcome = {
        schemaVersion: 1,
        advanceId,
        continuationIdDigest: continuation.continuationIdDigest,
        chainId: continuation.chainId,
        generation: continuation.generation,
        reservationEpoch: reservation.reservationEpoch,
        fence: reservation.fence,
        operationKey: reservation.operationKey,
        requestDigest: reservation.requestDigest,
        providerId: continuation.providerBinding.providerId,
        providerVersion: continuation.providerBinding.providerVersion,
        credentialBindingEpoch: continuation.providerBinding.credentialBindingEpoch,
        upstreamPagesAdvanced: summary.pagesAdvanced,
        exactResult: result,
        exactResultDigest: digestPhase3Body(result),
        ...(successor === undefined
          ? {}
          : {
              successor: {
                continuationId: successor.reference.continuationId,
                continuationIdDigest: successor.record.continuationIdDigest,
                generation: successor.record.generation,
                encryptedUpstreamState: successor.record.encryptedUpstreamState,
                upstreamStateDigest: successor.record.upstreamStateDigest,
                expiresAt: successor.record.expiresAt,
              },
            }),
        createdAt: now,
      }
      await this.store.recordOutcome(projectId, outcome)
      await this.faults.afterOutcomeBeforeConsume?.(faultContext)
      return {
        result: await this.store.consumeOutcome(projectId, outcome.advanceId),
        advanceId: outcome.advanceId,
      }
    } catch (error) {
      if (!dispatched) {
        await this.store.releaseUndispatched(projectId, continuation.continuationIdDigest, reservation)
          .catch(() => undefined)
      }
      if (error instanceof GeoResearchError && error.code === 'LITERATURE_PAGINATION_STALLED') {
        await this.store.revoke(projectId, continuation.continuationIdDigest, error.code)
      }
      throw error
    }
  }

  private async advancePages(
    request: LiteratureSearchRequest,
    initialState: JsonValue,
    previouslySeen: ReadonlySet<string>,
    credential: LiteratureProviderCredential,
    signal: AbortSignal | undefined,
  ): Promise<SearchAdvance> {
    const chainRemaining = this.maxChainItems - previouslySeen.size
    if (chainRemaining <= 0) {
      throw new GeoResearchError('LITERATURE_CHAIN_LIMIT_REACHED', `search chain reached ${this.maxChainItems} unique items`)
    }
    const callLimit = Math.min(request.maxResults, chainRemaining)
    const seen = new Set(previouslySeen)
    const items: LiteratureItem[] = []
    const warnings: LiteratureWarning[] = []
    let currentState = initialState
    let pagesAdvanced = 0
    let transparentNoItemPages = 0
    let requestId: string | null = null
    while (pagesAdvanced < this.maxPagesPerCall) {
      const pageSize = Math.min(this.pageSize, callLimit - items.length)
      let page
      try {
        page = await this.provider.searchPage({
          request,
          upstreamState: currentState,
          credential,
          pageSize,
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (error) {
        if (items.length === 0) throw error
        const stopReason = providerStopReason(error)
        warnings.push({
          code: error instanceof GeoResearchError ? error.code : 'LITERATURE_PROVIDER_FAILURE',
          message: error instanceof Error ? error.message : 'literature provider failed after partial progress',
        })
        return {
          items,
          warnings,
          pagesAdvanced,
          nextUpstreamState: currentState,
          done: false,
          stopReason,
          requestId,
          allowContinuation: true,
        }
      }
      if (page.items.length > pageSize) {
        throw new GeoResearchError('LITERATURE_PROVIDER_FAILURE', 'provider returned more items than requested')
      }
      warnings.push(...page.warnings)
      requestId = page.requestId ?? requestId
      if (!page.done && page.nextUpstreamState === null) {
        throw new GeoResearchError('LITERATURE_PROVIDER_INCOMPATIBLE', 'provider omitted the next pagination state')
      }
      if (!page.done && page.nextUpstreamState !== null
        && digestPhase3Body(page.nextUpstreamState) === digestPhase3Body(currentState)) {
        throw new GeoResearchError('LITERATURE_PAGINATION_STALLED', 'provider pagination state did not advance')
      }
      const before = items.length
      for (const item of page.items) {
        if (seen.has(item.providerItemId)) continue
        seen.add(item.providerItemId)
        items.push(item)
      }
      pagesAdvanced += 1
      if (page.done) {
        return {
          items,
          warnings,
          pagesAdvanced,
          nextUpstreamState: null,
          done: true,
          requestId,
          allowContinuation: false,
        }
      }
      currentState = page.nextUpstreamState as JsonValue
      const newItems = items.length - before
      transparentNoItemPages = newItems === 0 ? transparentNoItemPages + 1 : 0
      if (items.length >= callLimit) {
        const atChainLimit = previouslySeen.size + items.length >= this.maxChainItems
        if (atChainLimit) {
          warnings.push({
            code: 'LITERATURE_CHAIN_LIMIT_REACHED',
            message: `Search chain reached the configured ${this.maxChainItems} unique item limit.`,
          })
        }
        return {
          items,
          warnings,
          pagesAdvanced,
          nextUpstreamState: atChainLimit ? null : currentState,
          done: false,
          stopReason: 'result-limit',
          requestId,
          allowContinuation: !atChainLimit,
        }
      }
      if (items.length === 0 && transparentNoItemPages >= this.maxTransparentNoItemPagesPerCall) {
        return {
          items,
          warnings,
          pagesAdvanced,
          nextUpstreamState: currentState,
          done: false,
          stopReason: 'no-new-items',
          requestId,
          allowContinuation: true,
        }
      }
    }
    return {
      items,
      warnings,
      pagesAdvanced,
      nextUpstreamState: currentState,
      done: false,
      stopReason: items.length === 0 ? 'no-new-items' : 'page-limit',
      requestId,
      allowContinuation: true,
    }
  }

  private searchResult(
    requestDigest: Sha256Digest,
    chainId: string,
    generation: number,
    priorPages: number,
    priorItems: number,
    summary: SearchAdvance,
    providerBinding: LiteratureContinuationProviderBinding,
    continuationRef: LiteratureSearchResult['continuationRef'],
    retrievedAt: string,
  ): LiteratureSearchResult {
    const providerTrace: LiteratureProviderTrace = {
      providerId: providerBinding.providerId,
      providerVersion: providerBinding.providerVersion,
      retrievedAt,
      credentialRef: providerBinding.credentialRef,
      credentialBindingEpoch: providerBinding.credentialBindingEpoch,
      requestId: summary.requestId,
    }
    const common = {
      items: summary.items,
      warnings: summary.warnings,
      providerTrace,
      searchChainTrace: {
        chainId,
        generation,
        requestDigest,
        pagesAdvancedTotal: priorPages + summary.pagesAdvanced,
        uniqueItemsTotal: priorItems + summary.items.length,
      },
      trace: { pagesAdvanced: summary.pagesAdvanced },
    }
    const raw: LiteratureSearchResult = summary.done
      ? { ...common, completeness: 'complete' }
      : {
          ...common,
          completeness: 'partial',
          stopReason: summary.stopReason ?? (summary.items.length === 0 ? 'no-new-items' : 'page-limit'),
          ...(continuationRef === undefined ? {} : { continuationRef }),
        }
    return parseLiteratureSearchResult(raw)
  }

  private createContinuation(
    chainId: string,
    generation: number,
    owner: LiteratureContinuationOwner,
    providerBinding: LiteratureContinuationProviderBinding,
    upstreamState: JsonValue,
    now: string,
  ): {
    readonly record: LiteratureContinuationRecord
    readonly reference: NonNullable<LiteratureSearchResult['continuationRef']>
  } {
    const continuationId = this.token()
    const continuationIdDigest = continuationDigest(continuationId)
    const expiresAt = new Date(new Date(now).getTime() + this.continuationTtlMs).toISOString()
    const stateBinding = continuationStateBinding(
      continuationIdDigest,
      chainId,
      generation,
      owner,
      providerBinding,
    )
    return {
      record: {
        schemaVersion: 1,
        continuationIdDigest,
        chainId,
        generation,
        state: 'active',
        owner,
        providerBinding,
        encryptedUpstreamState: this.installation.sealPrivateState(upstreamState, stateBinding),
        upstreamStateDigest: digestPhase3Body(upstreamState),
        expiresAt,
        createdAt: now,
        updatedAt: now,
        reservationEpoch: 0,
      },
      reference: { continuationId, generation, expiresAt },
    }
  }

  private async resolveCredential(projectId: string): Promise<{
    readonly credential: LiteratureProviderCredential
    readonly providerBinding: LiteratureContinuationProviderBinding
  }> {
    let value: string | null = null
    let fingerprint: Sha256Digest | null = null
    if (this.configuredCredentialRef !== null) {
      const resolved = await this.credentials.resolve(this.configuredCredentialRef)
      if (resolved === undefined) {
        throw new GeoResearchError(
          'LITERATURE_AUTH_REQUIRED',
          `credential reference ${String(this.configuredCredentialRef)} is not configured`,
        )
      }
      value = resolved.value
      fingerprint = this.installation.credentialFingerprint(value)
    }
    const ref = this.configuredCredentialRef === null ? null : String(this.configuredCredentialRef)
    const bound = await this.store.bindCredential(
      projectId,
      this.provider.capability.providerId,
      ref,
      fingerprint,
    )
    return {
      credential: { ref, value, bindingEpoch: bound.epoch },
      providerBinding: {
        providerId: this.provider.capability.providerId,
        providerVersion: this.provider.capability.providerVersion,
        continuationFormatDigest: this.provider.capability.continuationFormatDigest,
        credentialRef: ref,
        credentialBindingEpoch: bound.epoch,
      },
    }
  }

  private async literatureContext(execution: ToolExecution, operation: string): Promise<LiteratureOperationContext> {
    const agent = exactAgent(execution, operation)
    if (roleOf(agent) !== 'literature') {
      throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', `${operation} requires the literature role`)
    }
    const rootSession = parentSessionId(agent)
    if (rootSession === undefined) {
      throw new GeoResearchError('GEORESEARCH_UNMANAGED_DELEGATED_SESSION', `${operation} requires a managed child session`)
    }
    const resolved = await this.projects.resolveAgent(agent)
    return {
      agent,
      resolved,
      owner: {
        projectBindingId: resolved.stateFile.state.projectBinding.bindingId,
        rootSessionId: String(rootSession),
        operatorScopeId: this.installation.operatorScopeId,
        profileId: 'georesearch',
        requiredRole: 'literature',
      },
    }
  }

  private async readPdfRange(
    lease: ResolvedArtifactReadLease,
    pageStart: number,
    requestedEnd: number | null,
    signal: AbortSignal,
  ): Promise<PdfRangeRead> {
    const pages: PaperPageText[] = []
    let metadata: PaperReadResult['metadata'] | undefined
    let pageCount: number | undefined
    let resultBytes = 0
    let partialReason: PdfRangeRead['partialReason']
    for (let page = pageStart; ; page += 1) {
      signal.throwIfAborted()
      const parsed = await readPdfDocument(lease.bytes, {
        page,
        maxPages: 1,
        renderImages: false,
        maxInputBytes: this.pdfMaxInputBytes,
        maxDocumentPages: this.pdfMaxDocumentPages,
        maxPageTextBytes: this.pdfMaxPageTextBytes,
        maxResultTextBytes: this.pdfMaxResultTextBytes,
      }, signal)
      pageCount ??= parsed.pageCount
      metadata ??= parsed.metadata
      if (parsed.pageCount !== pageCount) throw new GeoResearchError('PDF_INVALID', 'PDF page count changed during parsing')
      if (requestedEnd !== null && requestedEnd > pageCount) {
        throw new GeoResearchError('PDF_PAGE_RANGE_INVALID', `pageEnd ${requestedEnd} exceeds document page count ${pageCount}`)
      }
      const parsedPage = parsed.pages[0]
      if (parsedPage === undefined || parsedPage.page !== page) {
        throw new GeoResearchError('PDF_INVALID', `PDF parser did not return requested page ${page}`)
      }
      if (resultBytes + parsedPage.textBytes > this.pdfMaxResultTextBytes) {
        if (pages.length === 0) {
          throw new GeoResearchError('PDF_RESULT_TEXT_TOO_LARGE', 'the first completed PDF page exceeds the result text limit')
        }
        partialReason = 'result-text-limit'
        break
      }
      pages.push({ page, text: parsedPage.text, textBytes: parsedPage.textBytes })
      resultBytes += parsedPage.textBytes
      const target = requestedEnd ?? pageCount
      if (page >= target) break
      if (pages.length >= this.pdfMaxPagesPerCall) {
        partialReason = 'page-limit'
        break
      }
    }
    const completed = pages.at(-1)
    if (pageCount === undefined || metadata === undefined || completed === undefined) {
      throw new GeoResearchError('PDF_INVALID', 'PDF parser returned no complete pages')
    }
    return {
      pageCount,
      completedEnd: completed.page,
      pages,
      metadata,
      ...(partialReason === undefined ? {} : { partialReason }),
    }
  }

  private async validateEvidenceCandidate(
    agent: Agent,
    resolved: ResolvedProject,
    rootSessionId: string,
    candidate: EvidenceCandidate,
  ): Promise<PaperReadReceipt> {
    const projectId = resolved.stateFile.projectId
    const state = await this.projects.loadProject(projectId)
    if (state.state.sources?.[candidate.sourceId] === undefined) {
      throw new GeoResearchError('EVIDENCE_SOURCE_NOT_FOUND', `source ${candidate.sourceId} is not registered`)
    }
    const receipt = await this.store.paperReadReceipt(projectId, candidate.paperReadReceiptId)
    if (receipt.projectBindingId !== state.state.projectBinding.bindingId
      || receipt.rootSessionId !== rootSessionId
      || receipt.operatorScopeId !== this.installation.operatorScopeId
      || receipt.artifactId !== candidate.artifactId) {
      throw new GeoResearchError('EVIDENCE_READ_RECEIPT_MISMATCH', 'paper read receipt owner or artifact does not match')
    }
    if (candidate.locator.pageStart < receipt.pageStart || candidate.locator.pageEnd > receipt.pageEnd) {
      throw new GeoResearchError('EVIDENCE_READ_RECEIPT_MISMATCH', 'evidence page range is outside the completed receipt range')
    }
    if (canonicalJson(receipt.lineage) !== canonicalJson(this.lineage)) {
      throw new GeoResearchError('EVIDENCE_READ_RECEIPT_MISMATCH', 'paper parser lineage is no longer current')
    }
    const artifact = state.state.artifacts[candidate.artifactId]
    if (artifact === undefined || artifact.digest !== receipt.artifactDigest
      || artifact.materialization !== 'committed' || artifact.validity !== 'current') {
      throw new GeoResearchError('EVIDENCE_READ_RECEIPT_MISMATCH', 'paper Artifact is no longer current')
    }
    const timeout = AbortSignal.timeout(this.pdfTimeoutMs)
    let reread: PdfRangeRead
    try {
      reread = await this.projects.withVerifiedReadLease(
        agent,
        candidate.artifactId,
        { maxBytes: this.pdfMaxInputBytes, signal: timeout },
        lease => this.readPdfRange(lease, candidate.locator.pageStart, candidate.locator.pageEnd, timeout),
      )
    } catch (error) {
      if (timeout.aborted) throw new GeoResearchError('PDF_TIMEOUT', 'evidence receipt revalidation timed out', { cause: error })
      throw normalizePdfError(error)
    }
    if (reread.completedEnd !== candidate.locator.pageEnd) {
      throw new GeoResearchError('EVIDENCE_READ_RECEIPT_MISMATCH', 'evidence revalidation did not complete every cited page')
    }
    for (const page of reread.pages) {
      const digest = digestPhase3Body({ page: page.page, text: page.text, textBytes: page.textBytes })
      if (receipt.pageTextDigests[String(page.page)] !== digest) {
        throw new GeoResearchError('EVIDENCE_READ_RECEIPT_MISMATCH', `paper page ${page.page} no longer matches its receipt`)
      }
    }
    if (candidate.quotedText !== undefined) {
      const completedText = reread.pages.map(page => page.text).join('\n')
      if (!completedText.includes(candidate.quotedText)) {
        throw new GeoResearchError('EVIDENCE_CANDIDATE_INVALID', 'quotedText is not present in the completed cited pages')
      }
    }
    return receipt
  }

  private async commitSourceWithRetry(
    projectId: string,
    request: Omit<SourceRecordCommitRequest, 'expectedGeneration'>,
  ): Promise<ProjectStateFile> {
    for (let attempt = 0; attempt < TRANSITION_RETRIES; attempt += 1) {
      const state = await this.projects.loadProject(projectId)
      try {
        return await this.projects.commitSourceRecord(projectId, {
          ...request,
          expectedGeneration: state.generation,
        })
      } catch (error) {
        if (!(error instanceof GeoResearchError) || error.code !== 'PROJECT_GENERATION_CONFLICT') throw error
      }
    }
    throw new GeoResearchError('PROJECT_GENERATION_CONFLICT', 'source record could not acquire a current project generation')
  }

  private async commitEvidenceWithRetry(
    projectId: string,
    request: Omit<EvidenceRecordCommitRequest, 'expectedGeneration'>,
  ): Promise<EvidenceRecord> {
    for (let attempt = 0; attempt < TRANSITION_RETRIES; attempt += 1) {
      const state = await this.projects.loadProject(projectId)
      const existing = state.state.evidence?.[request.evidence.evidenceId]
      if (existing !== undefined) return existing
      try {
        const committed = await this.projects.commitEvidenceRecord(projectId, {
          ...request,
          expectedGeneration: state.generation,
        })
        const evidence = committed.state.evidence?.[request.evidence.evidenceId]
        if (evidence === undefined) throw new GeoResearchError('PROJECT_RECOVERY_REQUIRED', 'evidence commit is not visible')
        return evidence
      } catch (error) {
        if (!(error instanceof GeoResearchError) || error.code !== 'PROJECT_GENERATION_CONFLICT') throw error
      }
    }
    throw new GeoResearchError('PROJECT_GENERATION_CONFLICT', 'evidence record could not acquire a current project generation')
  }
}

function exactAgent(execution: Pick<ToolExecution, 'agent'>, operation: string): Agent {
  if (execution.agent === undefined) {
    throw new GeoResearchError('GEORESEARCH_ROLE_MISMATCH', `${operation} requires an exact live Agent`)
  }
  return execution.agent
}

function sourceStableIdentifier(item: LiteratureItem): SourceRecord['stableIdentifier'] {
  if (item.doi !== null) return { kind: 'doi', value: item.doi }
  if (item.stableIdentifier.startsWith('provider:')) {
    return { kind: 'provider', value: item.stableIdentifier.slice('provider:'.length) }
  }
  if (item.url !== null) return { kind: 'url', value: item.url }
  return { kind: 'other', value: item.stableIdentifier }
}

function requireCompatibleSource(existing: SourceRecord, candidate: SourceRecord): SourceRecord {
  const stableExisting = {
    schemaVersion: existing.schemaVersion,
    sourceId: existing.sourceId,
    title: existing.title,
    authors: existing.authors,
    year: existing.year,
    venue: existing.venue,
    stableIdentifier: existing.stableIdentifier,
    sourceType: existing.sourceType,
    versionRelation: existing.versionRelation,
    providerId: existing.providerTrace.providerId,
    codeRefs: existing.codeRefs,
    dataRefs: existing.dataRefs,
    status: existing.status,
  }
  const stableCandidate = {
    schemaVersion: candidate.schemaVersion,
    sourceId: candidate.sourceId,
    title: candidate.title,
    authors: candidate.authors,
    year: candidate.year,
    venue: candidate.venue,
    stableIdentifier: candidate.stableIdentifier,
    sourceType: candidate.sourceType,
    versionRelation: candidate.versionRelation,
    providerId: candidate.providerTrace.providerId,
    codeRefs: candidate.codeRefs,
    dataRefs: candidate.dataRefs,
    status: candidate.status,
  }
  if (canonicalJson(stableExisting) !== canonicalJson(stableCandidate)) {
    throw new GeoResearchError(
      'SOURCE_INVALID',
      `source ${candidate.sourceId} already has incompatible bibliographic metadata`,
    )
  }
  return existing
}

function providerStopReason(error: unknown): LiteratureStopReason {
  if (!(error instanceof GeoResearchError)) return 'provider-failure'
  switch (error.code) {
    case 'LITERATURE_RATE_LIMITED': return 'rate-limited'
    case 'LITERATURE_TIMEOUT': return 'timeout'
    case 'LITERATURE_CANCELLED': return 'cancelled'
    default: return 'provider-failure'
  }
}

function normalizePdfError(error: unknown): Error {
  if (error instanceof GeoResearchError && error.code.startsWith('PDF_')) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/page .* text exceeds/iu.test(message)) {
    return new GeoResearchError('PDF_PAGE_TEXT_TOO_LARGE', message, error instanceof Error ? { cause: error } : undefined)
  }
  if (/result text exceeds/iu.test(message)) {
    return new GeoResearchError('PDF_RESULT_TEXT_TOO_LARGE', message, error instanceof Error ? { cause: error } : undefined)
  }
  if (/page count exceeds/iu.test(message)) {
    return new GeoResearchError('PDF_DOCUMENT_TOO_LARGE', message, error instanceof Error ? { cause: error } : undefined)
  }
  if (/outside the document|pageEnd|pageStart/iu.test(message)) {
    return new GeoResearchError('PDF_PAGE_RANGE_INVALID', message, error instanceof Error ? { cause: error } : undefined)
  }
  if (/input exceeds/iu.test(message)) {
    return new GeoResearchError('PDF_INPUT_TOO_LARGE', message, error instanceof Error ? { cause: error } : undefined)
  }
  return new GeoResearchError('PDF_INVALID', message, error instanceof Error ? { cause: error } : undefined)
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function evidenceFaultContext(
  projectId: string,
  continuationIdDigest: Sha256Digest,
  reservation: LiteratureContinuationReservation,
): EvidenceFaultContext {
  return {
    projectId,
    continuationIdDigest,
    reservationEpoch: reservation.reservationEpoch,
    fence: reservation.fence,
  }
}

function advanceFlightKey(
  projectId: string,
  continuationIdDigest: Sha256Digest,
  operationKey: Sha256Digest,
): string {
  return `${projectId}\0${continuationIdDigest}\0${operationKey}`
}

function sameProviderBinding(
  left: LiteratureContinuationProviderBinding,
  right: LiteratureContinuationProviderBinding,
): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function nonEmptyLineage(lineage: PaperReadLineage): boolean {
  return lineage.providerId.length > 0
    && lineage.providerVersion.length > 0
    && lineage.parserId.length > 0
    && lineage.parserVersion.length > 0
    && /^sha256:[0-9a-f]{64}$/u.test(lineage.configDigest)
}
