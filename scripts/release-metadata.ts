import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface ReleaseMetadata {
  readonly schemaVersion: 1
  readonly productVersion: string
  readonly createdAt: string
}

export async function loadReleaseMetadata(
  workspaceRoot: string,
  expectedProductVersion: string,
): Promise<ReleaseMetadata> {
  const value = JSON.parse(
    await readFile(join(workspaceRoot, 'release-metadata.json'), 'utf8'),
  ) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('release metadata must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1
    || record.productVersion !== expectedProductVersion
    || typeof record.createdAt !== 'string'
    || new Date(record.createdAt).toISOString() !== record.createdAt
    || Object.keys(record).sort().join(',') !== 'createdAt,productVersion,schemaVersion') {
    throw new TypeError('release metadata is invalid')
  }
  return {
    schemaVersion: 1,
    productVersion: expectedProductVersion,
    createdAt: record.createdAt,
  }
}
