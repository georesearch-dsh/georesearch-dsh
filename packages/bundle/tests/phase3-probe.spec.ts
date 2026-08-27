import {
  PHASE3_LITERATURE_TOOLS,
  PHASE3_REQUIRED_TOOLS,
} from '@georesearch/dsh-contracts'
import { describe, expect, it } from 'vitest'
import { phase3HostToolNames } from '../src/phase3-probe.js'

describe('Phase 3 runtime probe contract', () => {
  it('keeps literature tools specialist-only and exposes no model commit tool', () => {
    expect(phase3HostToolNames()).toEqual([...PHASE3_LITERATURE_TOOLS].sort())
    expect(PHASE3_REQUIRED_TOOLS.literature).toEqual(expect.arrayContaining(PHASE3_LITERATURE_TOOLS))
    for (const actor of ['coordinator', 'experiment', 'reviewer', 'writing'] as const) {
      expect(PHASE3_REQUIRED_TOOLS[actor]).not.toEqual(expect.arrayContaining(PHASE3_LITERATURE_TOOLS))
    }
    expect(phase3HostToolNames()).not.toContain('evidence_commit')
  })
})
