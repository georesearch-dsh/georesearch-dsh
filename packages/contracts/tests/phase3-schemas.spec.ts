import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONTINUATION_ADVANCE_OUTCOME_SCHEMA,
  EVIDENCE_CANDIDATE_SCHEMA,
  EVIDENCE_RECORD_SCHEMA,
  LITERATURE_CONTINUATION_RECORD_SCHEMA,
  LITERATURE_SEARCH_REQUEST_SCHEMA,
  LITERATURE_SEARCH_RESULT_SCHEMA,
  PAPER_READ_RESULT_SCHEMA,
  SOURCE_RECORD_SCHEMA,
  digestPhase3Body,
  normalizeLiteratureSearchRequest,
  parseEvidenceCandidate,
  parseLiteratureContinuationRequest,
  parseLiteratureSearchResult,
  parseSourceRecord,
  type LiteratureSearchResult,
  type SourceRecord,
} from '../src/index.js'

const schemaCases = [
  ['literature-search-request.schema.json', 'GeoResearch Literature Search Request', LITERATURE_SEARCH_REQUEST_SCHEMA],
  ['literature-search-result.schema.json', 'GeoResearch Literature Search Result', LITERATURE_SEARCH_RESULT_SCHEMA],
  ['literature-continuation.schema.json', 'GeoResearch Literature Continuation', LITERATURE_CONTINUATION_RECORD_SCHEMA],
  ['continuation-advance-outcome.schema.json', 'GeoResearch Continuation Advance Outcome', CONTINUATION_ADVANCE_OUTCOME_SCHEMA],
  ['paper-read-result.schema.json', 'GeoResearch Paper Read Result', PAPER_READ_RESULT_SCHEMA],
  ['source-record.schema.json', 'GeoResearch Source Record', SOURCE_RECORD_SCHEMA],
  ['evidence-candidate.schema.json', 'GeoResearch Evidence Candidate', EVIDENCE_CANDIDATE_SCHEMA],
  ['evidence-record.schema.json', 'GeoResearch Evidence Record', EVIDENCE_RECORD_SCHEMA],
] as const

describe('Phase 3 frozen contracts', () => {
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

  it('normalizes a first search without changing query case or semantics', () => {
    expect(normalizeLiteratureSearchRequest({
      query: '  Remote Sensing  ',
      filters: {
        yearStart: undefined,
        yearEnd: 2025,
        publicationTypes: ['journal-article', 'proceedings-article', 'journal-article'],
      },
      maxResults: 25,
    })).toEqual({
      query: 'Remote Sensing',
      filters: {
        yearStart: null,
        yearEnd: 2025,
        publicationTypes: ['journal-article', 'proceedings-article'],
      },
      maxResults: 25,
    })
  })

  it('allows literature_continue to contain only an opaque continuationId', () => {
    const continuationId = 'a'.repeat(43)
    expect(parseLiteratureContinuationRequest({ continuationId })).toEqual({ continuationId })
    expect(() => parseLiteratureContinuationRequest({ continuationId, page: 2 })).toThrow(/unsupported fields/)
  })

  it('enforces complete and empty-partial result invariants', () => {
    const complete = literatureResult()
    expect(parseLiteratureSearchResult(complete)).toEqual(complete)
    expect(() => parseLiteratureSearchResult({
      ...complete,
      completeness: 'complete',
      stopReason: 'result-limit',
    })).toThrow(/cannot contain stopReason/)
    expect(() => parseLiteratureSearchResult({
      ...complete,
      items: [],
      completeness: 'partial',
      stopReason: 'result-limit',
    })).toThrow(/empty partial/)
    const continuationRef = { continuationId: 'b'.repeat(43), generation: 2, expiresAt: '2026-08-19T00:00:00.000Z' }
    expect(parseLiteratureSearchResult({
      ...complete,
      items: [],
      completeness: 'partial',
      stopReason: 'no-new-items',
      continuationRef,
      trace: { pagesAdvanced: 1 },
    }).continuationRef).toEqual(continuationRef)
  })

  it('checks SourceRecord body digests and Evidence Candidate page ranges', () => {
    const body = {
      schemaVersion: 1 as const,
      sourceId: 'source-1',
      title: 'Traceable source',
      authors: [{ name: 'A. Author', orcid: null }],
      year: 2025,
      venue: 'Fixture Journal',
      stableIdentifier: { kind: 'doi' as const, value: '10.1234/fixture' },
      sourceType: 'journal-article',
      versionRelation: { kind: 'none' as const, relatedIdentifier: null },
      retrievedAt: '2026-08-18T00:00:00.000Z',
      providerTrace: literatureResult().providerTrace,
      codeRefs: [],
      dataRefs: [],
      status: 'resolved' as const,
      searchChain: { chainId: 'chain-1', generation: 1, providerItemId: '10.1234/fixture' },
    }
    const source: SourceRecord = { ...body, digest: digestPhase3Body(body) }
    expect(parseSourceRecord(source)).toEqual(source)
    expect(() => parseSourceRecord({ ...source, title: 'forged' })).toThrow(/digest/)
    expect(parseEvidenceCandidate({
      schemaVersion: 1,
      sourceId: 'source-1',
      artifactId: 'artifact-1',
      paperReadReceiptId: 'paper-read-1',
      locator: { pageStart: 2, pageEnd: 3 },
      proposition: 'The method improves accuracy.',
      relation: 'supports',
      paraphrase: 'Reported accuracy is higher than the baseline.',
      limitations: ['Single benchmark'],
    }).relation).toBe('supports')
    expect(() => parseEvidenceCandidate({
      schemaVersion: 1,
      sourceId: 'source-1',
      artifactId: 'artifact-1',
      paperReadReceiptId: 'paper-read-1',
      locator: { pageStart: 3, pageEnd: 2 },
      proposition: 'Invalid range',
      relation: 'supports',
      paraphrase: 'Invalid range',
      limitations: [],
    })).toThrow(/must not exceed/)
  })
})

function literatureResult(): LiteratureSearchResult {
  return {
    items: [{
      providerItemId: '10.1234/fixture',
      title: 'Fixture paper',
      authors: [{ name: 'A. Author', orcid: null }],
      year: 2025,
      venue: 'Fixture Journal',
      doi: '10.1234/fixture',
      stableIdentifier: 'doi:10.1234/fixture',
      sourceType: 'journal-article',
      url: 'https://doi.org/10.1234/fixture',
    }],
    completeness: 'complete',
    warnings: [],
    providerTrace: {
      providerId: 'fixture',
      providerVersion: '1.0.0',
      retrievedAt: '2026-08-18T00:00:00.000Z',
      credentialRef: null,
      credentialBindingEpoch: 0,
      requestId: null,
    },
    searchChainTrace: {
      chainId: 'chain-1',
      generation: 1,
      requestDigest: digestPhase3Body({ query: 'fixture' }),
      pagesAdvancedTotal: 1,
      uniqueItemsTotal: 1,
    },
    trace: { pagesAdvanced: 1 },
  }
}
