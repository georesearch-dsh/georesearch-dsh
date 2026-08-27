import { describe, expect, it } from 'vitest'
import { isSandboxWriteDenied } from '../src/phase1-probe.js'

describe('Phase 1 sandbox probe', () => {
  const marker = 'C:\\workspace\\.georesearch-phase1-denied-write'

  it('recognizes provider denial signatures', () => {
    expect(isSandboxWriteDenied(1, 'sandbox policy denied filesystem write', marker, [
      'policy denied',
    ])).toBe(true)
  })

  it('recognizes a native EPERM denial for the exact marker', () => {
    expect(isSandboxWriteDenied(
      1,
      `Error: EPERM: operation not permitted, open '${marker}'`,
      marker,
      [],
    )).toBe(true)
  })

  it('does not accept an unrelated native denial', () => {
    expect(isSandboxWriteDenied(
      1,
      "Error: EPERM: operation not permitted, open 'C:\\other\\file'",
      marker,
      [],
    )).toBe(false)
  })

  it('recognizes EACCES with slash-normalized marker output', () => {
    expect(isSandboxWriteDenied(
      1,
      "Error: EACCES: permission denied, open 'C:/workspace/.georesearch-phase1-denied-write'",
      marker,
      [],
    )).toBe(true)
  })
})
