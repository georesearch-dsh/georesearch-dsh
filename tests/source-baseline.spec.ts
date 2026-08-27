import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { HARNESS_BASELINE } from '@georesearch/dsh-contracts'
import { describe, expect, it } from 'vitest'
import { verifyHarnessBaseline } from '../scripts/source-baseline.ts'

describe('pinned Harness source baseline', () => {
  it('matches the official archive and the registered local patch', async () => {
    const root = resolve(import.meta.dirname, '..')
    const proof = await verifyHarnessBaseline(root)
    expect(proof).toMatchObject({
      archiveSha256: HARNESS_BASELINE.archiveSha256,
      sourceTreeDigest: HARNESS_BASELINE.sourceTreeDigest,
      sourceFileCount: HARNESS_BASELINE.sourceFileCount,
      localPatchId: 'structured-output-bounded-recovery-and-array-limits-v1',
      localPatchFileCount: 67,
      localMirrorMatchesExpectedPatch: true,
      lockfileSha256: HARNESS_BASELINE.lockfileSha256,
    })
    const baseline = JSON.parse(await readFile(resolve(root, 'docs', 'phase0-baseline.json'), 'utf8'))
    expect(baseline.status).toBe('verified')
    expect(baseline.gate.phase1EntryPassed).toBe(true)
  }, 180_000)
})
