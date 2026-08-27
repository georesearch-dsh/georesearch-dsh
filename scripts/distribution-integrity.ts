import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  digestJson,
  digestTree,
  sha256Bytes,
  type TreeFileDigest,
} from '@georesearch/dsh-contracts'

export function rewriteWorkspaceRanges(value: unknown, productVersion: string): unknown {
  if (Array.isArray(value)) return value.map(child => rewriteWorkspaceRanges(child, productVersion))
  if (typeof value !== 'object' || value === null) {
    return typeof value === 'string' && value.startsWith('workspace:') ? productVersion : value
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, child]) => [key, rewriteWorkspaceRanges(child, productVersion)]),
  )
}

export function includeDistributionPath(path: string): boolean {
  return path.replaceAll('\\', '/').split('/').at(-1) !== '.npmignore'
}

export async function expectedDistributionPackageDigest(
  workspaceRoot: string,
  folder: string,
  sourceManifest: Record<string, unknown>,
  productVersion: string,
): Promise<string> {
  const sourceRoot = join(workspaceRoot, 'packages', folder)
  const packageBytes = Buffer.from(
    `${JSON.stringify(rewriteWorkspaceRanges(sourceManifest, productVersion), undefined, 2)}\n`,
    'utf8',
  )
  const rootEntries: RootEntry[] = [
    { name: 'LICENSE', kind: 'file', source: join(sourceRoot, 'LICENSE') },
    { name: 'README.md', kind: 'file', source: join(sourceRoot, 'README.md') },
    { name: 'lib', kind: 'tree', source: join(sourceRoot, 'lib') },
    { name: 'package.json', kind: 'bytes', bytes: packageBytes },
  ]
  if (folder === 'bundle') {
    rootEntries.push(
      { name: 'dsh-plugin.json', kind: 'file', source: join(sourceRoot, 'dsh-plugin.json') },
      { name: 'cordis.patch.yml', kind: 'file', source: join(sourceRoot, 'cordis.patch.yml') },
      { name: 'schemas', kind: 'tree', source: join(sourceRoot, 'schemas') },
    )
  }
  rootEntries.sort((left, right) => compareNames(left.name, right.name))

  const files: TreeFileDigest[] = []
  for (const entry of rootEntries) {
    if (entry.kind === 'tree') {
      const tree = await digestTree(entry.source, {
        exclude: path => !includeDistributionPath(path),
      })
      files.push(...tree.files.map(file => ({ ...file, path: `${entry.name}/${file.path}` })))
      continue
    }
    const bytes = entry.kind === 'bytes' ? entry.bytes : await readFile(entry.source)
    files.push({ path: entry.name, digest: sha256Bytes(bytes), size: bytes.byteLength })
  }
  return digestJson(files)
}

type RootEntry =
  | { readonly name: string; readonly kind: 'file'; readonly source: string }
  | { readonly name: string; readonly kind: 'tree'; readonly source: string }
  | { readonly name: string; readonly kind: 'bytes'; readonly bytes: Buffer }

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
