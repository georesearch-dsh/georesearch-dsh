import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REPOSITORY_AUDIT_SCHEMA,
  REPRODUCTION_PLAN_SCHEMA,
  REPRODUCTION_REPORT_CANDIDATE_SCHEMA,
  REPRODUCTION_REPORT_SCHEMA,
  REPRODUCTION_TEST_SPEC_SCHEMA,
} from '../packages/contracts/lib/index.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const output = resolve(root, 'packages', 'bundle', 'schemas')
await mkdir(output, { recursive: true })

const schemas = [
  ['repository-audit.schema.json', 'GeoResearch Repository Audit', REPOSITORY_AUDIT_SCHEMA],
  ['reproduction-plan.schema.json', 'GeoResearch Reproduction Plan', REPRODUCTION_PLAN_SCHEMA],
  ['reproduction-test-spec.schema.json', 'GeoResearch Reproduction TestSpec', REPRODUCTION_TEST_SPEC_SCHEMA],
  [
    'reproduction-report-candidate.schema.json',
    'GeoResearch Reproduction Report Candidate',
    REPRODUCTION_REPORT_CANDIDATE_SCHEMA,
  ],
  ['reproduction-report.schema.json', 'GeoResearch Reproduction Report', REPRODUCTION_REPORT_SCHEMA],
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
