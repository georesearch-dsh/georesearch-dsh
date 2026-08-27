import {
  PHASE4_REPRODUCTION_TOOLS,
  PHASE4_REQUIRED_TOOLS,
} from '@georesearch/dsh-contracts'
import { describe, expect, it } from 'vitest'
import { phase4HostToolNames } from '../src/phase4-probe.js'

describe('Phase 4 runtime probe contract', () => {
  it('keeps reproduction candidate tools Experiment-only and report commit Host-only', () => {
    expect(phase4HostToolNames()).toEqual([...PHASE4_REPRODUCTION_TOOLS].sort())
    expect(PHASE4_REQUIRED_TOOLS.experiment).toEqual(expect.arrayContaining(PHASE4_REPRODUCTION_TOOLS))
    for (const actor of ['coordinator', 'literature', 'reviewer', 'writing'] as const) {
      expect(PHASE4_REQUIRED_TOOLS[actor]).not.toEqual(expect.arrayContaining(PHASE4_REPRODUCTION_TOOLS))
    }
    expect(phase4HostToolNames()).not.toContain('reproduction_report_commit')
  })
})
