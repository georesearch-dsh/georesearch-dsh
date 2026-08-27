import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLAIM_PROPOSAL_SCHEMA,
  CLAIM_RECORD_SCHEMA,
  MANUSCRIPT_AUDIT_SCHEMA,
  MANUSCRIPT_CANDIDATE_SCHEMA,
  MANUSCRIPT_RECORD_SCHEMA,
  REVIEW_PROPOSAL_SCHEMA,
  REVIEW_RECORD_SCHEMA,
  VALIDATION_PLAN_SCHEMA,
  VALIDATION_REPORT_SCHEMA,
  WRITING_PACKET_SCHEMA,
} from '../packages/contracts/lib/index.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const output = resolve(root, 'packages', 'bundle', 'schemas')
await mkdir(output, { recursive: true })

const schemas = [
  ['validation-plan.schema.json', 'GeoResearch Validation Plan', VALIDATION_PLAN_SCHEMA],
  ['validation-report.schema.json', 'GeoResearch Validation Report', VALIDATION_REPORT_SCHEMA],
  ['review-proposal.schema.json', 'GeoResearch Review Proposal', REVIEW_PROPOSAL_SCHEMA],
  ['review-record.schema.json', 'GeoResearch Review Record', REVIEW_RECORD_SCHEMA],
  ['claim-proposal.schema.json', 'GeoResearch Claim Proposal', CLAIM_PROPOSAL_SCHEMA],
  ['claim-record.schema.json', 'GeoResearch Claim Record', CLAIM_RECORD_SCHEMA],
  ['writing-packet.schema.json', 'GeoResearch Writing Packet', WRITING_PACKET_SCHEMA],
  ['manuscript-candidate.schema.json', 'GeoResearch Manuscript Candidate', MANUSCRIPT_CANDIDATE_SCHEMA],
  ['manuscript-record.schema.json', 'GeoResearch Manuscript Record', MANUSCRIPT_RECORD_SCHEMA],
  ['manuscript-audit.schema.json', 'GeoResearch Manuscript Audit', MANUSCRIPT_AUDIT_SCHEMA],
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
