import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DATASET_MANIFEST_SCHEMA,
  EXPERIMENT_AMENDMENT_SCHEMA,
  EXPERIMENT_SPEC_CANDIDATE_SCHEMA,
  EXPERIMENT_SPEC_SCHEMA,
  GEODATA_INSPECTION_REPORT_SCHEMA,
  RESULT_ENVELOPE_SCHEMA,
  RESULT_RECORD_SCHEMA,
} from '../packages/contracts/lib/index.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const output = resolve(root, 'packages', 'bundle', 'schemas')
await mkdir(output, { recursive: true })

const schemas = [
  ['geodata-inspection-report.schema.json', 'GeoResearch Geodata Inspection Report', GEODATA_INSPECTION_REPORT_SCHEMA],
  ['dataset-manifest.schema.json', 'GeoResearch Dataset Manifest', DATASET_MANIFEST_SCHEMA],
  ['experiment-spec-candidate.schema.json', 'GeoResearch Experiment Spec Candidate', EXPERIMENT_SPEC_CANDIDATE_SCHEMA],
  ['experiment-spec.schema.json', 'GeoResearch Experiment Spec', EXPERIMENT_SPEC_SCHEMA],
  ['experiment-amendment.schema.json', 'GeoResearch Experiment Amendment', EXPERIMENT_AMENDMENT_SCHEMA],
  ['result-envelope.schema.json', 'GeoResearch Result Envelope', RESULT_ENVELOPE_SCHEMA],
  ['result-record.schema.json', 'GeoResearch Result Record', RESULT_RECORD_SCHEMA],
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
