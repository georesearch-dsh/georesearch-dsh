import { PHASE6_REQUIRED_TOOLS } from '@georesearch/dsh-contracts'
import { describe, expect, it } from 'vitest'
import { phase6HostToolNames } from '../src/phase6-probe.js'

describe('Phase 6 runtime probe contract', () => {
  it('keeps validation, approval, packet, and writing tools in exact role catalogs', () => {
    expect(phase6HostToolNames()).toEqual([
      'citation_validate',
      'claim_commit',
      'experiment_validate',
      'geodata_validate',
      'manuscript_candidate',
      'manuscript_validate',
      'review_candidate',
      'review_subject_read',
      'writing_packet_build',
      'writing_packet_read',
    ])
    expect(PHASE6_REQUIRED_TOOLS.reviewer).toEqual(expect.arrayContaining([
      'geodata_validate', 'experiment_validate', 'citation_validate',
      'review_subject_read', 'review_candidate',
    ]))
    expect(PHASE6_REQUIRED_TOOLS.coordinator).toEqual(expect.arrayContaining([
      'claim_commit', 'writing_packet_build',
    ]))
    expect(PHASE6_REQUIRED_TOOLS.writing).toEqual(expect.arrayContaining([
      'writing_packet_read', 'manuscript_candidate', 'manuscript_validate',
    ]))
    expect(PHASE6_REQUIRED_TOOLS.writing).not.toEqual(expect.arrayContaining([
      'read', 'glob', 'grep', 'web_search', 'write', 'edit',
    ]))
  })
})
