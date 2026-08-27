import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { REQUIRED_SKILLS } from '@georesearch/dsh-contracts'

const root = resolve(import.meta.dirname, '../../..')
const JsType = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: value => value ?? '',
})
const schema = DEFAULT_SCHEMA.extend([JsType])

describe('GeoResearch agent composition regressions', () => {
  it('uses one global skill tool with a scoped provider and no unbacked fetch tool', async () => {
    const bundleRows = compositionRows(await readFile(
      resolve(root, 'packages/bundle/cordis.patch.yml'),
      'utf8',
    ))
    const presetRows = compositionRows(await readFile(
      resolve(root, 'preset/georesearch/agent.cordis.yml'),
      'utf8',
    ))

    expect(bundleRows.filter(row => row.id === 'tool-skill')).toEqual([
      expect.objectContaining({
        id: 'tool-skill',
        disabled: false,
        config: expect.objectContaining({ catalogDescriptionMaxLength: 128 }),
      }),
    ])
    expect(presetRows.some(row => row.id === 'skill-filesystem')).toBe(true)
    expect(presetRows.some(row => row.id === 'tool-skill')).toBe(false)

    const web = bundleRows.find(row => row.id === 'tool-web')
    expect(web).toEqual(expect.objectContaining({
      disabled: false,
      config: expect.objectContaining({ fetch: false }),
    }))
  })

  it('ships a compatibility router for the public georesearch skill name', async () => {
    expect(REQUIRED_SKILLS).toContain('georesearch')
    const router = await readFile(resolve(
      root,
      'preset/georesearch/skills/georesearch/SKILL.md',
    ), 'utf8')
    expect(router).toContain('name: georesearch')
    expect(router).toContain('literature-review')
    expect(router).toContain('geospatial-data')
    expect(router).toContain('remote-sensing-experiment')
    expect(router).toContain('spatial-statistics')
    expect(router).toContain('scientific-validation')
  })
})

function compositionRows(source: string): Array<Record<string, unknown>> {
  const parsed = load(source, { schema }) as unknown
  const rows: Array<Record<string, unknown>> = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const record = value as Record<string, unknown>
    if (typeof record.id === 'string') rows.push(record)
    if (Array.isArray(record.insert)) visit(record.insert)
    if (Array.isArray(record.config)) visit(record.config)
  }
  visit(parsed)
  return rows
}
