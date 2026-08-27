import { PHASE5_REQUIRED_TOOLS } from '@georesearch/dsh-contracts'
import { describe, expect, it } from 'vitest'
import { phase5HostToolNames } from '../src/phase5-probe.js'

describe('Phase 5 runtime probe contract', () => {
  it('keeps candidate, commit, and result tools in their exact role catalogs', () => {
    expect(phase5HostToolNames()).toEqual([
      'experiment_spec_candidate',
      'experiment_spec_commit',
      'geodata_inspect',
      'result_commit',
      'result_read',
    ])
    expect(PHASE5_REQUIRED_TOOLS.experiment).toEqual(expect.arrayContaining([
      'geodata_inspect',
      'experiment_spec_candidate',
    ]))
    expect(PHASE5_REQUIRED_TOOLS.coordinator).toEqual(expect.arrayContaining([
      'experiment_spec_commit',
      'result_commit',
    ]))
    expect(PHASE5_REQUIRED_TOOLS.reviewer).toContain('result_read')
    expect(PHASE5_REQUIRED_TOOLS.experiment).not.toContain('result_commit')
    expect(PHASE5_REQUIRED_TOOLS.coordinator).not.toContain('geodata_inspect')
    expect(PHASE5_REQUIRED_TOOLS.writing).not.toContain('result_read')
  })
})
