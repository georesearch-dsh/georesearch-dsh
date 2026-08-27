import { createCanvas, PDFDocument } from '@napi-rs/canvas'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Agent, ToolExecution } from '@georesearch/dsh-compat-rc5'
import {
  digestPhase3Body,
  parseEvidenceRecord,
  type JsonValue,
  type ContinuationAdvanceOutcome,
  type LiteratureContinuationRecord,
  type LiteratureItem,
  type LiteratureProviderPage,
  type LiteratureSearchRequest,
} from '@georesearch/dsh-contracts'
import type {
  LiteratureProvider,
  LiteratureProviderPageRequest,
} from '@georesearch/dsh-evidence-providers'
import {
  createOperatorScopeRecord,
  openOperatorScopeRecord,
} from '@georesearch/dsh-installation-guard/operator-scope'
import { projectPaths } from '@georesearch/dsh-project-provider-files'
import { ProjectCoordinator } from '@georesearch/dsh-project-service'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EvidenceCoordinator,
  type EvidenceFaultHooks,
} from '../src/coordinator.js'
import { evidenceTools } from '../src/index.js'

const roots: string[] = []
const clock = () => '2026-08-18T00:00:00.000Z'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Phase 3 literature continuation state machine', () => {
  it('serializes source registration because it mutates shared project generation', () => {
    const tool = evidenceTools({} as never).find(candidate => candidate.name === 'source_resolve')
    expect(tool?.isConcurrencySafe?.()).toBe(false)
  })

  it('propagates the initial search cancellation signal to the Provider', async () => {
    const provider = twoPageProvider()
    const fixture = await evidenceFixture(provider)
    const controller = new AbortController()
    const execution = childExecution(fixture.workspace, 'root-1', 'search-signal')
    const result = await fixture.evidence.literatureSearch(
      { ...execution, signal: controller.signal },
      searchRequest(1),
    )
    expect(result.items).toHaveLength(1)
    expect(provider.calls[0]?.signal).toBe(controller.signal)
  })

  it('deduplicates transparent pages and exactly replays a consumed token without provider access', async () => {
    const provider = new FixtureProvider(request => {
      switch (cursor(request.upstreamState)) {
        case '*': return page([paper('paper-a')], 'cursor-2')
        case 'cursor-2': return page([paper('paper-a')], 'cursor-3')
        case 'cursor-3': return page([paper('paper-b')], null, true)
        default: throw new Error('unexpected cursor')
      }
    })
    const fixture = await evidenceFixture(provider)
    const first = await fixture.evidence.literatureSearch(
      childExecution(fixture.workspace, 'root-1', 'search-1'),
      searchRequest(1),
    )
    expect(first).toMatchObject({
      completeness: 'partial',
      stopReason: 'result-limit',
      trace: { pagesAdvanced: 1 },
    })
    const continuationId = first.continuationRef!.continuationId
    const advanced = await fixture.evidence.literatureContinue(
      childExecution(fixture.workspace, 'root-1', 'continue-1'),
      continuationId,
    )
    expect(advanced.items.map(item => item.providerItemId)).toEqual(['paper-b'])
    expect(advanced.searchChainTrace.generation).toBe(2)
    expect(advanced.trace.pagesAdvanced).toBe(2)
    expect(provider.calls).toHaveLength(3)

    const replay = await fixture.evidence.literatureContinue(
      childExecution(fixture.workspace, 'root-1', 'continue-retry'),
      continuationId,
    )
    expect(replay).toEqual(advanced)
    expect(provider.calls).toHaveLength(3)
  })

  it('persists dispatched-unknown before provider dispatch and recovers by replaying the same cursor', async () => {
    let failAtBarrier = true
    const faults: EvidenceFaultHooks = {
      afterDispatchBarrier: () => {
        if (!failAtBarrier) return
        failAtBarrier = false
        throw new Error('fixture crash after dispatch barrier')
      },
    }
    const provider = twoPageProvider()
    const fixture = await evidenceFixture(provider, { faults })
    const first = await fixture.evidence.literatureSearch(
      childExecution(fixture.workspace, 'root-1', 'search-barrier'),
      searchRequest(1),
    )
    await expect(fixture.evidence.literatureContinue(
      childExecution(fixture.workspace, 'root-1', 'continue-barrier'),
      first.continuationRef!.continuationId,
    )).rejects.toThrow(/fixture crash/)
    expect(provider.calls).toHaveLength(1)
    expect(await continuationStates(fixture.home, fixture.projectId)).toContain('dispatched-unknown')

    const recovered = await fixture.evidence.recoverProject(fixture.projectId, true)
    expect(recovered.replayErrors).toEqual([])
    expect(recovered.replayedOutcomeIds).toEqual(await outcomeIds(fixture.home, fixture.projectId))
    expect(provider.calls.map(call => cursor(call.upstreamState))).toEqual(['*', 'cursor-2'])
    expect(await continuationStates(fixture.home, fixture.projectId)).toContain('consumed')
  })

  it('re-dispatches after a response-before-Outcome crash but never after an Outcome-before-consume crash', async () => {
    let failBeforeOutcome = true
    const firstProvider = twoPageProvider()
    const firstFixture = await evidenceFixture(firstProvider, {
      faults: {
        afterProviderResponseBeforeOutcome: () => {
          if (!failBeforeOutcome) return
          failBeforeOutcome = false
          throw new Error('fixture crash before outcome')
        },
      },
    })
    const first = await firstFixture.evidence.literatureSearch(
      childExecution(firstFixture.workspace, 'root-1', 'search-response'),
      searchRequest(1),
    )
    await expect(firstFixture.evidence.literatureContinue(
      childExecution(firstFixture.workspace, 'root-1', 'continue-response'),
      first.continuationRef!.continuationId,
    )).rejects.toThrow(/before outcome/)
    expect(firstProvider.calls).toHaveLength(2)
    await firstFixture.evidence.recoverProject(firstFixture.projectId, true)
    expect(firstProvider.calls).toHaveLength(3)

    let failAfterOutcome = true
    const secondProvider = twoPageProvider()
    const secondFixture = await evidenceFixture(secondProvider, {
      faults: {
        afterOutcomeBeforeConsume: () => {
          if (!failAfterOutcome) return
          failAfterOutcome = false
          throw new Error('fixture crash after outcome')
        },
      },
    })
    const second = await secondFixture.evidence.literatureSearch(
      childExecution(secondFixture.workspace, 'root-2', 'search-outcome'),
      searchRequest(1),
    )
    await expect(secondFixture.evidence.literatureContinue(
      childExecution(secondFixture.workspace, 'root-2', 'continue-outcome'),
      second.continuationRef!.continuationId,
    )).rejects.toThrow(/after outcome/)
    expect(secondProvider.calls).toHaveLength(2)
    await secondFixture.evidence.recoverProject(secondFixture.projectId, true)
    expect(secondProvider.calls).toHaveLength(2)
    expect(await continuationStates(secondFixture.home, secondFixture.projectId)).toContain('consumed')
  })

  it('rejects a late response carrying a stale reservation epoch and fence', async () => {
    let failBeforeOutcome = true
    const provider = twoPageProvider()
    const fixture = await evidenceFixture(provider, {
      faults: {
        afterProviderResponseBeforeOutcome: () => {
          if (!failBeforeOutcome) return
          failBeforeOutcome = false
          throw new Error('fixture leaves stale response')
        },
      },
    })
    const first = await fixture.evidence.literatureSearch(
      childExecution(fixture.workspace, 'root-1', 'search-stale-fence'),
      searchRequest(1),
    )
    await expect(fixture.evidence.literatureContinue(
      childExecution(fixture.workspace, 'root-1', 'continue-stale-fence'),
      first.continuationRef!.continuationId,
    )).rejects.toThrow(/stale response/)
    const stale = await onlyContinuation(fixture.home, fixture.projectId, 'dispatched-unknown')
    const staleReservation = stale.reservation!
    const recovered = await fixture.evidence.store.reserveRecovery(
      fixture.projectId,
      stale.continuationIdDigest,
      true,
    )
    expect(recovered!.reservation.reservationEpoch).toBe(staleReservation.reservationEpoch + 1)
    await fixture.evidence.store.markDispatched(
      fixture.projectId,
      stale.continuationIdDigest,
      recovered!.reservation,
    )
    const staleOutcome: ContinuationAdvanceOutcome = {
      schemaVersion: 1,
      advanceId: digestPhase3Body({ domain: 'stale-fixture' }),
      continuationIdDigest: stale.continuationIdDigest,
      chainId: stale.chainId,
      generation: stale.generation,
      reservationEpoch: staleReservation.reservationEpoch,
      fence: staleReservation.fence,
      operationKey: staleReservation.operationKey,
      requestDigest: staleReservation.requestDigest,
      providerId: stale.providerBinding.providerId,
      providerVersion: stale.providerBinding.providerVersion,
      credentialBindingEpoch: stale.providerBinding.credentialBindingEpoch,
      upstreamPagesAdvanced: 1,
      exactResult: first,
      exactResultDigest: digestPhase3Body(first),
      createdAt: clock(),
    }
    await expect(fixture.evidence.store.recordOutcome(fixture.projectId, staleOutcome))
      .rejects.toMatchObject({ code: 'LITERATURE_OUTCOME_CONFLICT' })
  })

  it('rejects another root owner and revokes a continuation when its credential binding rotates', async () => {
    let secret = 'secret-one'
    const provider = twoPageProvider()
    const fixture = await evidenceFixture(provider, {
      credentialRef: 'CROSSREF_TOKEN',
      credentialValue: () => secret,
    })
    const first = await fixture.evidence.literatureSearch(
      childExecution(fixture.workspace, 'root-1', 'search-owner'),
      searchRequest(1),
    )
    await expect(fixture.evidence.literatureContinue(
      childExecution(fixture.workspace, 'root-2', 'continue-other-root'),
      first.continuationRef!.continuationId,
    )).rejects.toMatchObject({ code: 'LITERATURE_CONTINUATION_OWNER_MISMATCH' })
    secret = 'secret-two'
    await expect(fixture.evidence.literatureContinue(
      childExecution(fixture.workspace, 'root-1', 'continue-rotated'),
      first.continuationRef!.continuationId,
    )).rejects.toMatchObject({ code: 'LITERATURE_CONTINUATION_CREDENTIAL_BINDING_CHANGED' })
    expect(provider.calls).toHaveLength(1)
    expect(await continuationStates(fixture.home, fixture.projectId)).toContain('revoked')
  })

  it('revokes a continuation when a provider cursor stalls', async () => {
    const provider = new FixtureProvider(request => {
      const state = cursor(request.upstreamState)
      return state === '*'
        ? page([paper('paper-a')], 'cursor-2')
        : page([], 'cursor-2')
    })
    const fixture = await evidenceFixture(provider)
    const first = await fixture.evidence.literatureSearch(
      childExecution(fixture.workspace, 'root-1', 'search-stalled'),
      searchRequest(1),
    )
    await expect(fixture.evidence.literatureContinue(
      childExecution(fixture.workspace, 'root-1', 'continue-stalled'),
      first.continuationRef!.continuationId,
    )).rejects.toMatchObject({ code: 'LITERATURE_PAGINATION_STALLED' })
    expect(await continuationStates(fixture.home, fixture.projectId)).toContain('revoked')
  })
})

describe('Phase 3 PDF, source, and evidence chain', () => {
  it('reuses a compatible SourceRecord when the same DOI is resolved through another Search Chain', async () => {
    const provider = new FixtureProvider(() => page([paper('paper-a')], null, true))
    const fixture = await evidenceFixture(provider)
    const firstSearch = await fixture.evidence.literatureSearch(
      childExecution(fixture.workspace, 'root-1', 'search-source-first'),
      searchRequest(1),
    )
    const firstSource = await fixture.evidence.sourceResolve(
      childExecution(fixture.workspace, 'root-1', 'resolve-source-first'),
      firstSearch.searchChainTrace.chainId,
      firstSearch.searchChainTrace.generation,
      firstSearch.items[0]!.providerItemId,
    )
    const secondSearch = await fixture.evidence.literatureSearch(
      childExecution(fixture.workspace, 'root-1', 'search-source-second'),
      searchRequest(1),
    )
    expect(secondSearch.searchChainTrace.chainId).not.toBe(firstSearch.searchChainTrace.chainId)
    const generationBeforeSecondResolve = (await fixture.projects.loadProject(fixture.projectId)).generation

    const secondSource = await fixture.evidence.sourceResolve(
      childExecution(fixture.workspace, 'root-1', 'resolve-source-second'),
      secondSearch.searchChainTrace.chainId,
      secondSearch.searchChainTrace.generation,
      secondSearch.items[0]!.providerItemId,
    )

    expect(secondSource).toEqual(firstSource)
    const current = await fixture.projects.loadProject(fixture.projectId)
    expect(current.generation).toBe(generationBeforeSecondResolve)
    expect(Object.keys(current.state.sources ?? {})).toEqual([firstSource.sourceId])
  })

  it('rejects conflicting bibliographic metadata for an existing stable source identity', async () => {
    let searchCount = 0
    const provider = new FixtureProvider(() => {
      searchCount += 1
      const item = paper('paper-a')
      return page([searchCount === 1 ? item : { ...item, title: 'Conflicting title' }], null, true)
    })
    const fixture = await evidenceFixture(provider)
    const firstSearch = await fixture.evidence.literatureSearch(
      childExecution(fixture.workspace, 'root-1', 'search-conflict-first'),
      searchRequest(1),
    )
    await fixture.evidence.sourceResolve(
      childExecution(fixture.workspace, 'root-1', 'resolve-conflict-first'),
      firstSearch.searchChainTrace.chainId,
      firstSearch.searchChainTrace.generation,
      firstSearch.items[0]!.providerItemId,
    )
    const secondSearch = await fixture.evidence.literatureSearch(
      childExecution(fixture.workspace, 'root-1', 'search-conflict-second'),
      searchRequest(1),
    )

    await expect(fixture.evidence.sourceResolve(
      childExecution(fixture.workspace, 'root-1', 'resolve-conflict-second'),
      secondSearch.searchChainTrace.chainId,
      secondSearch.searchChainTrace.generation,
      secondSearch.items[0]!.providerItemId,
    )).rejects.toMatchObject({ code: 'SOURCE_INVALID' })
  })

  it('traces a committed EvidenceRecord through Search Chain, PDF digest, page receipt, quote, and parser lineage', async () => {
    const provider = new FixtureProvider(() => page([paper('paper-a')], null, true))
    const fixture = await evidenceFixture(provider)
    const child = childExecution(fixture.workspace, 'root-1', 'search-evidence')
    const search = await fixture.evidence.literatureSearch(child, searchRequest(5))
    const source = await fixture.evidence.sourceResolve(
      childExecution(fixture.workspace, 'root-1', 'source-evidence'),
      search.searchChainTrace.chainId,
      search.searchChainTrace.generation,
      search.items[0]!.providerItemId,
    )
    const uploaded = await fixture.projects.commitUploadedArtifact(rootAgent(fixture.workspace, 'root-1'), {
      attachmentId: '00000000-0000-4000-8000-000000000301',
      source: oneChunk(testPdf()),
      maxBytes: 1024 * 1024,
      mediaType: 'application/pdf',
    })
    const paperRead = await fixture.evidence.paperRead(
      childExecution(fixture.workspace, 'root-1', 'paper-evidence'),
      { artifactId: uploaded.artifact.artifactId, pageStart: 1, pageEnd: 1 },
    )
    expect(paperRead.pages[0]?.text).toContain('GeoResearch page one')
    expect(paperRead.pdfDigest).toBe(uploaded.artifact.digest)
    const candidate = {
      schemaVersion: 1 as const,
      sourceId: source.sourceId,
      artifactId: uploaded.artifact.artifactId,
      paperReadReceiptId: paperRead.readReceiptId,
      locator: { pageStart: 1, pageEnd: 1 },
      proposition: 'The fixture identifies its first page.',
      relation: 'supports' as const,
      paraphrase: 'The first page contains the GeoResearch fixture label.',
      quotedText: 'GeoResearch page one',
      limitations: ['Synthetic fixture'],
    }
    expect(await fixture.evidence.evidenceCandidate(
      childExecution(fixture.workspace, 'root-1', 'candidate-evidence'),
      candidate,
    )).toEqual(candidate)
    const record = await fixture.evidence.commitEvidenceCandidate(
      rootExecution(fixture.workspace, 'root-1', 'commit-evidence'),
      candidate,
    )
    expect(record).toMatchObject({
      sourceId: source.sourceId,
      artifactDigest: uploaded.artifact.digest,
      extractionLineage: paperRead.lineage,
      reviewStatus: 'pending',
    })
    expect(parseEvidenceRecord({ ...record, reviewStatus: 'accepted' })).toMatchObject({
      reviewStatus: 'accepted',
      digest: record.digest,
    })
    const citation = await fixture.evidence.citationCheck(
      childExecution(fixture.workspace, 'root-1', 'citation-evidence'),
      record.evidenceId,
    )
    expect(citation.status).toBe('valid')
    expect(Object.values(citation.checks).every(Boolean)).toBe(true)

    await expect(fixture.evidence.evidenceCandidate(
      childExecution(fixture.workspace, 'root-1', 'candidate-forged-quote'),
      { ...candidate, quotedText: 'fabricated quotation' },
    )).rejects.toMatchObject({ code: 'EVIDENCE_CANDIDATE_INVALID' })
    await expect(fixture.evidence.evidenceCandidate(
      childExecution(fixture.workspace, 'root-2', 'candidate-other-root'),
      candidate,
    )).rejects.toMatchObject({ code: 'EVIDENCE_READ_RECEIPT_MISMATCH' })
  })
})

class FixtureProvider implements LiteratureProvider {
  readonly capability = Object.freeze({
    providerId: 'fixture-literature',
    providerVersion: '1.0.0',
    continuationFormatDigest: digestPhase3Body({ domain: 'fixture-cursor/v1' }),
    replaySemantics: 'replay-safe-read' as const,
    maxPageSize: 25,
    supportsCredentialRef: true,
  })
  readonly calls: LiteratureProviderPageRequest[] = []
  private disposed = false

  constructor(private readonly handler: (request: LiteratureProviderPageRequest) => LiteratureProviderPage) {}

  initialUpstreamState(): JsonValue {
    return { cursor: '*' }
  }

  async searchPage(request: LiteratureProviderPageRequest): Promise<LiteratureProviderPage> {
    if (this.disposed) throw new Error('fixture provider disposed')
    this.calls.push(request)
    return this.handler(request)
  }

  async drain(): Promise<void> {}

  async dispose(): Promise<void> {
    this.disposed = true
  }
}

function twoPageProvider(): FixtureProvider {
  return new FixtureProvider(request => cursor(request.upstreamState) === '*'
    ? page([paper('paper-a')], 'cursor-2')
    : page([paper('paper-b')], null, true))
}

async function evidenceFixture(
  provider: FixtureProvider,
  options: {
    readonly faults?: EvidenceFaultHooks
    readonly credentialRef?: string
    readonly credentialValue?: () => string
  } = {},
): Promise<{
  readonly root: string
  readonly workspace: string
  readonly home: string
  readonly projectId: string
  readonly projects: ProjectCoordinator
  readonly evidence: EvidenceCoordinator
}> {
  const root = await mkdtemp(join(tmpdir(), 'georesearch-evidence-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const home = join(root, 'home')
  await mkdir(workspace, { recursive: true })
  const projects = new ProjectCoordinator({ home, now: clock })
  const attached = await projects.resolveAgent(rootAgent(workspace, 'root-1'), { attachIfMissing: true })
  const testKey = Buffer.alloc(32, 0x44).toString('base64url')
  const operatorRecord = await createOperatorScopeRecord(home, 'fixture-installation', { testKey })
  const installation = await openOperatorScopeRecord(home, 'fixture-installation', operatorRecord, { testKey })
  let tokenIndex = 0
  const evidence = new EvidenceCoordinator({
    home,
    credentialRef: options.credentialRef ?? null,
    pageSize: 1,
    maxPagesPerCall: 4,
    maxTransparentNoItemPagesPerCall: 2,
    reservationLeaseMs: 1_000,
  }, {
    projects,
    installation,
    credentials: {
      resolve: async () => ({ value: options.credentialValue?.() ?? 'fixture-secret', source: 'fixture' }),
    },
    provider,
    now: clock,
    randomToken: () => `token${String(++tokenIndex).padStart(38, '0')}`,
    ...(options.faults === undefined ? {} : { faults: options.faults }),
  })
  return {
    root,
    workspace,
    home,
    projectId: attached.stateFile.projectId,
    projects,
    evidence,
  }
}

function searchRequest(maxResults: number): LiteratureSearchRequest {
  return {
    query: 'fixture remote sensing',
    filters: { yearStart: null, yearEnd: null, publicationTypes: [] },
    maxResults,
  }
}

function paper(providerItemId: string): LiteratureItem {
  return {
    providerItemId,
    title: `Fixture ${providerItemId}`,
    authors: [{ name: 'Ada Lovelace', orcid: null }],
    year: 2025,
    venue: 'Fixture Journal',
    doi: `10.1234/${providerItemId}`,
    stableIdentifier: `doi:10.1234/${providerItemId}`,
    sourceType: 'journal-article',
    url: `https://doi.org/10.1234/${providerItemId}`,
  }
}

function page(
  items: readonly LiteratureItem[],
  nextCursor: string | null,
  done = false,
): LiteratureProviderPage {
  return {
    items,
    nextUpstreamState: nextCursor === null ? null : { cursor: nextCursor },
    done,
    warnings: [],
    requestId: `request-${nextCursor ?? 'done'}`,
  }
}

function cursor(value: JsonValue | null): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid fixture cursor')
  const cursorValue = value.cursor
  if (typeof cursorValue !== 'string') throw new Error('invalid fixture cursor')
  return cursorValue
}

function rootAgent(cwd: string, sessionId: string): Agent {
  return {
    id: `agent-${sessionId}`,
    options: {},
    session: { id: sessionId, header: { cwd } },
  } as unknown as Agent
}

function childAgent(cwd: string, rootSessionId: string): Agent {
  return {
    id: `agent-child-${rootSessionId}`,
    options: { geoResearchRole: 'literature' },
    session: {
      id: `child-${rootSessionId}`,
      header: { cwd, parentSession: rootSessionId, origin: 'subagent' },
    },
  } as unknown as Agent
}

function rootExecution(cwd: string, sessionId: string, callId: string): ToolExecution {
  return {
    agent: rootAgent(cwd, sessionId),
    rootCallId: callId,
    callId,
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

function childExecution(cwd: string, rootSessionId: string, callId: string): ToolExecution {
  return {
    agent: childAgent(cwd, rootSessionId),
    rootCallId: callId,
    callId,
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

async function continuationStates(home: string, projectId: string): Promise<string[]> {
  const value = JSON.parse(await readFile(join(projectPaths(home, projectId).continuations, 'store.json'), 'utf8')) as {
    readonly continuations: Readonly<Record<string, { readonly state: string }>>
  }
  return Object.values(value.continuations).map(record => record.state)
}

async function outcomeIds(home: string, projectId: string): Promise<string[]> {
  const value = JSON.parse(await readFile(join(projectPaths(home, projectId).continuations, 'store.json'), 'utf8')) as {
    readonly outcomes: Readonly<Record<string, { readonly advanceId: string }>>
  }
  return Object.values(value.outcomes).map(record => record.advanceId).sort()
}

async function onlyContinuation(
  home: string,
  projectId: string,
  state: LiteratureContinuationRecord['state'],
): Promise<LiteratureContinuationRecord> {
  const value = JSON.parse(await readFile(join(projectPaths(home, projectId).continuations, 'store.json'), 'utf8')) as {
    readonly continuations: Readonly<Record<string, LiteratureContinuationRecord>>
  }
  const matching = Object.values(value.continuations).filter(record => record.state === state)
  expect(matching).toHaveLength(1)
  return matching[0]!
}

async function* oneChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes
}

function testPdf(): Uint8Array {
  const document = new PDFDocument({ title: 'GeoResearch fixture' })
  const marker = createCanvas(24, 24)
  const markerContext = marker.getContext('2d')
  markerContext.fillStyle = '#334155'
  markerContext.fillRect(0, 0, 24, 24)
  const first = document.beginPage(320, 220)
  first.fillStyle = '#ffffff'
  first.fillRect(0, 0, 320, 220)
  first.fillStyle = '#111827'
  first.font = '20px Arial'
  first.fillText('GeoResearch page one', 24, 42)
  first.drawImage(marker, 24, 72)
  document.endPage()
  const second = document.beginPage(320, 220)
  second.fillStyle = '#ffffff'
  second.fillRect(0, 0, 320, 220)
  second.fillStyle = '#111827'
  second.font = '20px Arial'
  second.fillText('GeoResearch page two', 24, 42)
  document.endPage()
  return document.close()
}
