import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const workspaceRoot = resolve(import.meta.dirname, '..')
const packagesRoot = join(workspaceRoot, 'packages')
const compatibilityRoot = join(packagesRoot, 'compatibility', 'src')
const harnessImport = /(?:from\s+|import\s*\()\s*['"](@deepseek-ai\/dsh-[^'"]+)['"]/gu
const directImport = /(?:from\s+|import\s*\()\s*['"](@deepseek-ai\/[^'"]+)['"]/gu

describe('compatibility adapter boundary', () => {
  it('keeps volatile Harness imports inside compatibility', async () => {
    const violations: string[] = []
    for (const packageEntry of await readdir(packagesRoot, { withFileTypes: true })) {
      if (!packageEntry.isDirectory() || packageEntry.name === 'compatibility') continue
      const sourceRoot = join(packagesRoot, packageEntry.name, 'src')
      for (const file of await typescriptFiles(sourceRoot)) {
        const source = await readFile(file, 'utf8')
        for (const match of source.matchAll(harnessImport)) {
          violations.push(`${relative(workspaceRoot, file).replaceAll('\\', '/')}: ${match[1]}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('declares every direct upstream import as a peer dependency', async () => {
    const imported = new Set<string>()
    for (const file of await typescriptFiles(compatibilityRoot)) {
      const source = await readFile(file, 'utf8')
      for (const match of source.matchAll(directImport)) imported.add(packageName(match[1]!))
    }
    const manifest = JSON.parse(
      await readFile(join(packagesRoot, 'compatibility', 'package.json'), 'utf8'),
    ) as { peerDependencies?: Record<string, string> }
    const declared = Object.keys(manifest.peerDependencies ?? {}).sort()
    expect([...imported].sort()).toEqual(declared)
  })

  it('keeps rc.5 platform UI identities external in the generated client bundle', async () => {
    const bundle = await readFile(join(packagesRoot, 'file-service', 'lib', 'client.js'), 'utf8')
    const harnessRequires = [...new Set(
      [...bundle.matchAll(/require\("(@deepseek-ai\/[^"\r\n]+)"\)/gu)].map(match => match[1]),
    )].sort()

    expect(harnessRequires).toEqual([
      '@deepseek-ai/dsh-client-ui-attachment',
      '@deepseek-ai/dsh-client-ui-primitives',
    ])
    expect(bundle).not.toContain('MessageImage_module_css_default = {}')
    expect(bundle).not.toContain('require("@georesearch/dsh-compat-rc5/client")')
  })
})

function packageName(specifier: string): string {
  const segments = specifier.split('/')
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0]!
}

async function typescriptFiles(root: string): Promise<string[]> {
  const files: string[] = []
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return files
    throw error
  }
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) files.push(...await typescriptFiles(path))
    else if (entry.isFile() && /\.tsx?$/u.test(entry.name)) files.push(path)
  }
  return files.sort()
}
