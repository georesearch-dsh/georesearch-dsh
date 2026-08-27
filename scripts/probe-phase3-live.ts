import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Agent, ToolExecution } from '@georesearch/dsh-compat-rc5'
import type {
  EvidenceCandidate,
  LiteratureItem,
  LiteratureSearchResult,
} from '@georesearch/dsh-contracts'

process.env.DSH_TELEMETRY_DISABLED = '1'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const reportPath = join(root, 'dist', 'reports', 'phase3-live-activation.json')
const temporaryRoot = await mkdtemp(join(tmpdir(), 'georesearch-phase3-live-'))
const workspace = join(temporaryRoot, 'workspace')
const home = join(temporaryRoot, 'home')
const pdfPath = join(workspace, 'attention-is-all-you-need.pdf')
const pdfUrl = 'https://arxiv.org/pdf/1706.03762'
const searchRequest = {
  query: [
    'Attention Is All You Need',
    'Ashish Vaswani Noam Shazeer Niki Parmar Jakob Uszkoreit',
    'Llion Jones Aidan Gomez Lukasz Kaiser Illia Polosukhin',
  ].join(' '),
  filters: {
    yearStart: null,
    yearEnd: null,
    publicationTypes: [],
  },
  maxResults: 1,
} as const

let lifecycle: { drain(): Promise<void>; dispose(): Promise<void> } | undefined
let providerDrained = false
let providerDisposed = false
let temporaryStateRemoved = false
let liveReport: Record<string, unknown> | undefined

try {
  await mkdir(workspace, { recursive: true })
  const [
    { canonicalJson, digestPhase3Body, nowUtc },
    { CrossrefLiteratureProvider },
    { EvidenceCoordinator },
    { createOperatorScopeRecord, openOperatorScopeRecord },
    { ProjectCoordinator },
  ] = await Promise.all([
    import('@georesearch/dsh-contracts'),
    import('@georesearch/dsh-evidence-providers'),
    import('@georesearch/dsh-evidence-service'),
    import('@georesearch/dsh-installation-guard/operator-scope'),
    import('@georesearch/dsh-project-service'),
  ])

  const installationId = `phase3-live-${randomUUID()}`
  const operatorRecord = await createOperatorScopeRecord(home, installationId)
  if (operatorRecord.protection !== 'dpapi-current-user') {
    throw new Error(`Phase 3 live activation requires DPAPI, received ${operatorRecord.protection}`)
  }
  const installation = await openOperatorScopeRecord(home, installationId, operatorRecord)

  const rootSessionId = `phase3-live-${randomUUID()}`
  const coordinatorAgent = rootAgent(workspace, rootSessionId)
  const literatureAgent = childAgent(workspace, rootSessionId)
  const projects = new ProjectCoordinator({ home })
  const attached = await projects.resolveAgent(coordinatorAgent, { attachIfMissing: true })

  let crossrefRequests = 0
  const provider = new CrossrefLiteratureProvider({
    fetch: async (input, init) => {
      crossrefRequests += 1
      return await globalThis.fetch(input, init)
    },
    userAgent: 'GeoResearch/0.1.0 phase3-live-activation (mailto:local-user@example.invalid)',
  })
  lifecycle = provider
  const evidence = new EvidenceCoordinator({
    home,
    pageSize: 1,
    maxPagesPerCall: 4,
    maxTransparentNoItemPagesPerCall: 2,
  }, {
    projects,
    installation,
    credentials: { resolve: async () => undefined },
    provider,
  })
  lifecycle = evidence

  const initial = await evidence.literatureSearch(
    execution(literatureAgent, 'literature-search'),
    searchRequest,
  )
  assertContinuation(initial, 'initial search')
  if (initial.providerTrace.providerId !== 'crossref') {
    throw new Error(`unexpected literature provider: ${initial.providerTrace.providerId}`)
  }

  const consumedContinuationId = initial.continuationRef.continuationId
  const advanced = await evidence.literatureContinue(
    execution(literatureAgent, 'literature-continue'),
    consumedContinuationId,
  )
  if (advanced.searchChainTrace.generation !== initial.searchChainTrace.generation + 1) {
    throw new Error('continuation did not advance exactly one generation')
  }
  const requestsBeforeReplay = crossrefRequests
  const replayed = await evidence.literatureContinue(
    execution(literatureAgent, 'literature-continue-replay'),
    consumedContinuationId,
  )
  const requestsAfterReplay = crossrefRequests
  if (requestsAfterReplay !== requestsBeforeReplay) {
    throw new Error('consumed continuation replay accessed Crossref')
  }
  if (canonicalJson(replayed) !== canonicalJson(advanced)) {
    throw new Error('consumed continuation replay did not return the exact recorded result')
  }

  const selected = selectAttentionPaper(initial, advanced)
  const source = await evidence.sourceResolve(
    execution(literatureAgent, 'source-resolve'),
    selected.result.searchChainTrace.chainId,
    selected.result.searchChainTrace.generation,
    selected.item.providerItemId,
  )

  const downloaded = await downloadPdf(pdfUrl, 32 * 1024 * 1024)
  await writeFile(pdfPath, downloaded.bytes)
  const uploaded = await projects.commitUploadedArtifact(coordinatorAgent, {
    attachmentId: randomUUID(),
    source: createReadStream(pdfPath),
    maxBytes: 32 * 1024 * 1024,
    mediaType: 'application/pdf',
  })
  const paper = await evidence.paperRead(
    execution(literatureAgent, 'paper-read'),
    { artifactId: uploaded.artifact.artifactId, pageStart: 1, pageEnd: 1 },
  )
  const firstPage = paper.pages[0]
  if (paper.textStatus !== 'extractable' || firstPage === undefined || firstPage.page !== 1) {
    throw new Error('the live PDF did not yield extractable first-page text')
  }
  const quote = selectExactQuote(firstPage.text)
  const candidate: EvidenceCandidate = {
    schemaVersion: 1,
    sourceId: source.sourceId,
    artifactId: uploaded.artifact.artifactId,
    paperReadReceiptId: paper.readReceiptId,
    locator: { pageStart: 1, pageEnd: 1 },
    proposition: 'The registered paper contains the cited first-page passage.',
    relation: 'supports',
    paraphrase: 'The uploaded PDF was read directly and the quoted passage was verified on page 1.',
    quotedText: quote,
    limitations: [
      'Live activation validates one page and one evidence record, not the paper\'s complete scientific argument.',
    ],
  }
  const validatedCandidate = await evidence.evidenceCandidate(
    execution(literatureAgent, 'evidence-candidate'),
    candidate,
  )
  const evidenceRecord = await evidence.commitEvidenceCandidate(
    execution(coordinatorAgent, 'evidence-commit'),
    validatedCandidate,
  )
  const citation = await evidence.citationCheck(
    execution(literatureAgent, 'citation-check'),
    evidenceRecord.evidenceId,
  )
  if (citation.status !== 'valid' || !Object.values(citation.checks).every(Boolean)) {
    throw new Error(`live citation validation failed: ${JSON.stringify(citation)}`)
  }

  const finalProject = await projects.loadProject(attached.stateFile.projectId)
  liveReport = {
    schemaVersion: 1,
    phase: 'phase3-live-activation',
    checkedAt: nowUtc(),
    environment: {
      platform: process.platform,
      node: process.version,
      telemetryDisabled: process.env.DSH_TELEMETRY_DISABLED === '1',
      operatorScopeProtection: operatorRecord.protection,
    },
    project: {
      projectId: finalProject.projectId,
      finalGeneration: finalProject.generation,
    },
    literature: {
      providerId: provider.capability.providerId,
      providerVersion: provider.capability.providerVersion,
      query: searchRequest.query,
      initialGeneration: initial.searchChainTrace.generation,
      advancedGeneration: advanced.searchChainTrace.generation,
      initialItems: initial.items.length,
      advancedItems: advanced.items.length,
      consumedContinuationDigest: digestPhase3Body({ continuationId: consumedContinuationId }),
      requestsBeforeReplay,
      requestsAfterReplay,
      exactReplay: true,
      selectedItem: {
        providerItemId: selected.item.providerItemId,
        title: selected.item.title,
        authors: selected.item.authors.map(author => author.name),
        doi: selected.item.doi,
      },
    },
    source: {
      sourceId: source.sourceId,
      digest: source.digest,
      status: source.status,
      chainId: source.searchChain.chainId,
      generation: source.searchChain.generation,
    },
    pdf: {
      requestedUrl: pdfUrl,
      resolvedUrl: downloaded.resolvedUrl,
      downloadedBytes: downloaded.bytes.byteLength,
      artifactId: uploaded.artifact.artifactId,
      artifactDigest: uploaded.artifact.digest,
      pageCount: paper.pageCount,
      textStatus: paper.textStatus,
      readReceiptId: paper.readReceiptId,
      readReceiptDigest: paper.readReceiptDigest,
      lineage: paper.lineage,
      verifiedQuote: quote,
    },
    evidence: {
      evidenceId: evidenceRecord.evidenceId,
      digest: evidenceRecord.digest,
      reviewStatus: evidenceRecord.reviewStatus,
      committedByRootCoordinator: true,
      citationStatus: citation.status,
      citationChecks: citation.checks,
    },
    checks: {
      realCrossref: true,
      continuationAdvanced: true,
      consumedContinuationExactReplay: true,
      replayAvoidedProvider: true,
      sourceCommitted: true,
      realPdfDownloaded: true,
      pdfArtifactCommitted: true,
      paperReadReceiptCreated: true,
      evidenceCandidateRevalidated: true,
      hostEvidenceCommit: true,
      citationValid: true,
      telemetryDisabled: process.env.DSH_TELEMETRY_DISABLED === '1',
      realWindowsDpapi: operatorRecord.protection === 'dpapi-current-user',
    },
  }
} finally {
  try {
    if (lifecycle !== undefined) {
      await lifecycle.drain()
      providerDrained = true
    }
  } finally {
    try {
      if (lifecycle !== undefined) {
        await lifecycle.dispose()
        providerDisposed = true
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
      temporaryStateRemoved = true
    }
  }
}

if (liveReport === undefined) throw new Error('Phase 3 live activation did not produce a report')
const finalReport = {
  ...liveReport,
  lifecycle: {
    providerDrained,
    providerDisposed,
    temporaryStateRemoved,
  },
}
await atomicWriteJson(reportPath, finalReport)
process.stdout.write(`${JSON.stringify({
  reportPath,
  provider: (liveReport.literature as Record<string, unknown>).providerId,
  exactReplay: true,
  citationValid: true,
  realWindowsDpapi: true,
}, undefined, 2)}\n`)

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

function execution(agent: Agent, callId: string): ToolExecution {
  return {
    agent,
    rootCallId: callId,
    callId,
    signal: new AbortController().signal,
  } as unknown as ToolExecution
}

function assertContinuation(
  result: LiteratureSearchResult,
  label: string,
): asserts result is LiteratureSearchResult & { continuationRef: NonNullable<LiteratureSearchResult['continuationRef']> } {
  if (result.completeness !== 'partial' || result.continuationRef === undefined) {
    throw new Error(`${label} did not return a continuation`)
  }
}

function selectAttentionPaper(
  initial: LiteratureSearchResult,
  advanced: LiteratureSearchResult,
): { readonly item: LiteratureItem; readonly result: LiteratureSearchResult } {
  const candidates = [initial, advanced].flatMap(result => result.items.map(item => ({ item, result })))
  const selected = candidates.find(({ item }) => (
    item.title.trim().toLocaleLowerCase('en-US') === 'attention is all you need'
    && item.authors.some(author => author.name.toLocaleLowerCase('en-US').includes('vaswani'))
  ))
  if (selected === undefined) {
    throw new Error(`Crossref did not return the expected paper: ${candidates.map(({ item }) => item.title).join(' | ')}`)
  }
  return selected
}

async function downloadPdf(
  url: string,
  maxBytes: number,
): Promise<{ readonly bytes: Buffer; readonly resolvedUrl: string }> {
  const signal = AbortSignal.timeout(60_000)
  const response = await fetch(url, {
    headers: { 'user-agent': 'GeoResearch/0.1.0 phase3-live-activation' },
    redirect: 'follow',
    signal,
  })
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`PDF download failed with HTTP ${response.status}`)
  }
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body.cancel().catch(() => undefined)
    throw new Error(`PDF download exceeds ${maxBytes} bytes`)
  }
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error(`PDF download exceeds ${maxBytes} bytes`)
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = Buffer.concat(chunks, total)
  if (bytes.byteLength < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('downloaded content is not a PDF')
  }
  return { bytes, resolvedUrl: response.url }
}

function selectExactQuote(text: string): string {
  const preferred = [
    'The dominant sequence transduction models',
    'We propose a new simple network architecture',
    'The Transformer',
  ]
  const folded = text.toLocaleLowerCase('en-US')
  for (const phrase of preferred) {
    const start = folded.indexOf(phrase.toLocaleLowerCase('en-US'))
    if (start >= 0) {
      const lineEnd = text.indexOf('\n', start)
      return text.slice(start, lineEnd < 0 ? Math.min(text.length, start + 320) : Math.min(lineEnd, start + 320)).trim()
    }
  }
  const line = text.split(/\r?\n/u)
    .map(value => value.trim())
    .find(value => value.length >= 48)
  if (line !== undefined) return line.slice(0, 320)
  const start = text.search(/\S/u)
  if (start < 0) throw new Error('PDF first page contains no quotable text')
  return text.slice(start, Math.min(text.length, start + 320)).trim()
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  await rename(temporary, path)
}
