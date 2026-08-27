import type { Context } from '@deepseek-ai/cordis'
import { DELEGATION_BOOTSTRAP_TOOL } from '@georesearch/dsh-contracts'
import { describe, expect, it } from 'vitest'
import { roleToolAvailability } from '../src/index.js'

describe('delegation role catalog', () => {
  it('intersects a role allowlist with globally registered tools', () => {
    const ctx = {
      tools: {
        schemas: () => [
          { name: 'skill' },
          { name: 'read' },
          { name: 'web_search' },
          { name: DELEGATION_BOOTSTRAP_TOOL },
          { name: 'delegate_literature' },
        ],
      },
    } as unknown as Context

    expect(roleToolAvailability(ctx, 'literature')).toEqual({
      allow: ['read', 'skill', 'web_search', DELEGATION_BOOTSTRAP_TOOL],
      missing: [
        'read_image', 'glob', 'grep', 'literature_search',
        'literature_continue', 'paper_read', 'source_resolve',
        'evidence_candidate', 'citation_check', 'attachment_list',
        'attachment_inspect', 'attachment_read', 'archive_list',
        'archive_read', 'attachment_read_image',
      ],
      missingRequired: [],
    })

    expect(roleToolAvailability(ctx, 'literature', 'full').missingRequired).toEqual([
      'read_image', 'glob', 'grep', 'literature_search',
      'literature_continue', 'paper_read', 'source_resolve',
      'evidence_candidate', 'citation_check', 'attachment_list',
      'attachment_inspect', 'attachment_read', 'archive_list',
      'archive_read', 'attachment_read_image',
    ])
  })
})
