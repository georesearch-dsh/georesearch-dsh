import { describe, expect, it } from 'vitest'
import {
  PHASE25_ATTACHMENT_TOOLS,
  PHASE25_REQUIRED_TOOLS,
  READABLE_ATTACHMENT_STRATEGIES,
  STORED_ATTACHMENT_ARCHIVE_FORMATS,
} from '@georesearch/dsh-contracts'
import { phase25HostToolNames } from '../src/phase25-probe.js'

describe('Phase 2.5 runtime probe contract', () => {
  it('requires the universal attachment tools without opening the writing packet boundary', () => {
    expect(phase25HostToolNames()).toEqual([...PHASE25_ATTACHMENT_TOOLS].sort())
    for (const actor of ['coordinator', 'literature', 'experiment', 'reviewer'] as const) {
      expect(PHASE25_REQUIRED_TOOLS[actor]).toEqual(expect.arrayContaining(PHASE25_ATTACHMENT_TOOLS))
    }
    expect(PHASE25_REQUIRED_TOOLS.writing).not.toEqual(expect.arrayContaining(PHASE25_ATTACHMENT_TOOLS))
    expect(READABLE_ATTACHMENT_STRATEGIES).toEqual(['direct-text', 'document', 'data', 'image', 'archive'])
    expect(STORED_ATTACHMENT_ARCHIVE_FORMATS).toEqual(['zip', 'tar', 'tar.gz'])
  })
})
