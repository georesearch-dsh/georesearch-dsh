import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseManifest, projectManifest } from '@dsh-std/manifest'
import {
  createDshManifestCatalog,
  createDshProtocolCatalog,
} from '@dsh-std/adapter-dsh'
import type { ExecutableToolDefinition, ToolOverrideHandler } from '@dsh-std/tool'
import { describe, expect, it } from 'vitest'
import {
  DSH_STANDARD_SCHEMA_URI,
  DSH_STANDARD_TOOL_OVERRIDE_REFERENCE,
  GEORESEARCH_STANDARD_TOOL_TARGETS,
} from '../packages/bundle/src/standard-catalog.js'
import standardFacet from '../packages/bundle/src/standard-facet.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

describe('DSH Standard Community v0.15 boundary', () => {
  it('parses, projects, and validates the package-root manifest with the DSH adapter catalogs', async () => {
    const source = await readFile(join(root, 'packages', 'bundle', 'dsh-plugin.json'), 'utf8')
    const portable = parseManifest(source, { source: 'packages/bundle/dsh-plugin.json' })
    const projected = projectManifest(portable)
    const report = createDshManifestCatalog().validate(projected, createDshProtocolCatalog())

    expect(report).toMatchObject({ compatible: true, issues: [] })
    expect(portable).toMatchObject({
      $schema: DSH_STANDARD_SCHEMA_URI,
      manifestVersion: '0.15',
      id: 'org.deepseek.georesearch',
      facets: { host: { entry: 'lib/standard-facet.js', apiVersion: 'v1alpha1' } },
      compat: { hosts: expect.arrayContaining(['deepseek-harness@0.1.0-rc.5']) },
    })
    expect(projected.spec.facets).toHaveLength(1)
    expect(projected.spec.facets[0]).not.toHaveProperty('protocols')
    expect(projected.spec.facets[0]).toMatchObject({
      name: 'host',
      activation: {
        apiVersion: 'lifecycle.dsh/v1alpha1',
        kind: 'FacetModule',
        spec: { module: 'lib/standard-facet.js' },
      },
    })
    const overrides = projected.spec.facets[0]?.extensions?.filter(extension =>
      extension.apiVersion === DSH_STANDARD_TOOL_OVERRIDE_REFERENCE.apiVersion
      && extension.kind === DSH_STANDARD_TOOL_OVERRIDE_REFERENCE.kind)
    expect(overrides?.map(extension => (extension.spec as { target: string }).target).sort())
      .toEqual([...GEORESEARCH_STANDARD_TOOL_TARGETS])
  })

  it('publishes every declared tool override and preserves the existing executable definition', async () => {
    const publications: Array<{
      readonly reference: { readonly apiVersion: string; readonly kind: string }
      readonly name: string
      readonly handler: ToolOverrideHandler
    }> = []
    await standardFacet.activate({
      extensions: {
        publish(reference: { readonly apiVersion: string; readonly kind: string }, name: string, handler: ToolOverrideHandler) {
          publications.push({ reference, name, handler })
          return () => undefined
        },
      },
    } as never)

    expect(publications.map(row => row.name)).toEqual([...GEORESEARCH_STANDARD_TOOL_TARGETS])
    expect(publications.every(row =>
      row.reference.apiVersion === DSH_STANDARD_TOOL_OVERRIDE_REFERENCE.apiVersion
      && row.reference.kind === DSH_STANDARD_TOOL_OVERRIDE_REFERENCE.kind)).toBe(true)
    const original = {
      name: publications[0]!.name,
      description: 'original',
      parameters: {},
      output: {},
      execute: async () => ({ data: null, content: [] }),
    } satisfies ExecutableToolDefinition
    expect(publications[0]!.handler.resolve(original)).toBe(original)
    expect(await standardFacet.snapshot?.()).toMatchObject({ state: 'active' })
  })

  it('loads the self-contained adapter entry against the pinned Harness rc.5 module surface', async () => {
    const adapter = await import('../packages/bundle/src/standard-adapter.js')
    expect(adapter.default).toBeTypeOf('function')
    expect((adapter.default as unknown as { inject?: readonly string[] }).inject)
      .toEqual(expect.arrayContaining(['agents', 'llm']))
  })
})
