import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CONTINUATION_ADVANCE_OUTCOME_SCHEMA,
  EVIDENCE_CANDIDATE_SCHEMA,
  EVIDENCE_RECORD_SCHEMA,
  LITERATURE_CONTINUATION_RECORD_SCHEMA,
  LITERATURE_SEARCH_REQUEST_SCHEMA,
  LITERATURE_SEARCH_RESULT_SCHEMA,
  PAPER_READ_RESULT_SCHEMA,
  SOURCE_RECORD_SCHEMA,
} from '../packages/contracts/lib/index.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const output = resolve(root, 'packages', 'bundle', 'schemas')
await mkdir(output, { recursive: true })

const schemas = [
  ['literature-search-request.schema.json', 'GeoResearch Literature Search Request', LITERATURE_SEARCH_REQUEST_SCHEMA],
  ['literature-search-result.schema.json', 'GeoResearch Literature Search Result', LITERATURE_SEARCH_RESULT_SCHEMA],
  ['literature-continuation.schema.json', 'GeoResearch Literature Continuation', LITERATURE_CONTINUATION_RECORD_SCHEMA],
  ['continuation-advance-outcome.schema.json', 'GeoResearch Continuation Advance Outcome', CONTINUATION_ADVANCE_OUTCOME_SCHEMA],
  ['paper-read-result.schema.json', 'GeoResearch Paper Read Result', PAPER_READ_RESULT_SCHEMA],
  ['source-record.schema.json', 'GeoResearch Source Record', SOURCE_RECORD_SCHEMA],
  ['evidence-candidate.schema.json', 'GeoResearch Evidence Candidate', EVIDENCE_CANDIDATE_SCHEMA],
  ['evidence-record.schema.json', 'GeoResearch Evidence Record', EVIDENCE_RECORD_SCHEMA],
] as const

for (const [file, title, schema] of schemas) {
  await writeFile(resolve(output, file), `${JSON.stringify({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://georesearch.local/schemas/${file}`,
    title,
    ...schema,
  }, undefined, 2)}\n`, 'utf8')
}

process.stdout.write(`${JSON.stringify({ output, schemas: schemas.length }, undefined, 2)}\n`)
