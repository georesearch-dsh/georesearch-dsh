import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('specialist safety contracts', () => {
  it('blocks fabricated reproduction authority and accepts a bounded decision result', async () => {
    const skill = await skillText('paper-reproduction')
    expect(skill).toMatch(/needs-user-decision/iu)
    expect(skill).toMatch(/never invent.*(?:planId|baselineAuditId|finalAuditId)/iu)
  })

  it('bounds literature discovery and prevents manual retries', async () => {
    const skill = await skillText('literature-review')
    expect(skill).toMatch(/at most two provider pages/iu)
    expect(skill).toMatch(/at most four.*source_resolve/iu)
    expect(skill).toMatch(/per-page ledger/iu)
    expect(skill).toMatch(/copy\s+the `chainId`, `generation`, and `providerItemId` from that same page/iu)
    expect(skill).toMatch(/never\s+reuse an earlier page generation/iu)
    expect(skill).toMatch(/never retry.*failed/iu)
    expect(skill).toMatch(/each finding may contain at most eight\s+`basisRefs`/iu)
    expect(skill).toMatch(/under 1000 characters/iu)
    expect(skill).toMatch(/`basisRef` under 400 characters/iu)
    expect(skill).toMatch(/call\s+`structured_output` exactly once/iu)
    expect(skill).toMatch(/only top-level property\s+is `result`/iu)
    expect(skill).toMatch(/`result` value as the object itself, never as JSON text/iu)
    expect(skill).toMatch(/do not emit trailing commas/iu)
  })

  it('preflights compact Experiment reports before one-shot structured output', async () => {
    const skill = await skillText('remote-sensing-experiment')
    expect(skill).toMatch(/at most four methods, four\s+findings/iu)
    expect(skill).toMatch(/under 1000\s+characters/iu)
    expect(skill).toMatch(/`basisRef` under 400 characters/iu)
    expect(skill).toMatch(/every finding's exact keys/iu)
    expect(skill).toMatch(/call\s+`structured_output` exactly once/iu)
    expect(skill).toMatch(/only top-level property\s+is `result`/iu)
    expect(skill).toMatch(/`result` value as the object itself, never as JSON text/iu)
    expect(skill).toMatch(/do not emit trailing commas/iu)
  })

  it('keeps Reviewer literature support offline and generation-aware', async () => {
    const skill = await skillText('scientific-validation')
    expect(skill).toMatch(/do not call\s+`literature_search`, `source_resolve`, or `web_search`/iu)
    expect(skill).toMatch(/authority\.generation/iu)
    expect(skill).toMatch(/never hard-code `1`/iu)
  })

  it('only probes attachments for actual uploaded material', async () => {
    const skill = await skillText('geospatial-data')
    expect(skill).toMatch(/only when.*uploaded/iu)
    expect(skill).toMatch(/workspace paths[\s\S]*`read`/iu)
  })

  it('keeps read-only coordination free of convenience artifact commits', async () => {
    const skill = await skillText('georesearch')
    expect(skill).toMatch(/do not call `artifact_commit` merely/iu)
    expect(skill).toMatch(/needs-user-decision.*valid specialist result/iu)
    expect(skill).toMatch(/do not call `ask_user_question` merely to repeat/iu)
    expect(skill).toMatch(/never\s+try a Skill reference as a workspace-relative path/iu)
    expect(skill).toMatch(/failed delegation or Host-rejected specialist candidate ends that bounded\s+attempt/iu)
    expect(skill).toMatch(/do not repeat the same `delegate_\*` objective/iu)

    const orchestration = await readFile(resolve(
      import.meta.dirname,
      '..',
      'preset',
      'georesearch',
      'skills',
      'georesearch',
      'references',
      'specialist-orchestration.md',
    ), 'utf8')
    expect(orchestration).toMatch(/do not call `ask_user_question` merely to echo/iu)
    expect(orchestration).toMatch(/do not repeat the same `delegate_\*` objective/iu)
  })
})

async function skillText(name: string): Promise<string> {
  return await readFile(resolve(
    import.meta.dirname,
    '..',
    'preset',
    'georesearch',
    'skills',
    name,
    'SKILL.md',
  ), 'utf8')
}
