import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { digestTree } from '@georesearch/dsh-contracts'
import { afterEach, describe, expect, it } from 'vitest'
import {
  expectedDistributionPackageDigest,
  includeDistributionPath,
  rewriteWorkspaceRanges,
} from '../scripts/distribution-integrity.js'
import { loadReleaseMetadata } from '../scripts/release-metadata.js'

const temporaryRoots: string[] = []
const workspaceRoot = resolve(import.meta.dirname, '..')

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('distribution integrity', () => {
  it('uses versioned release time instead of the build clock', async () => {
    const release = await loadReleaseMetadata(workspaceRoot, '0.1.0')
    const manifest = JSON.parse(
      await readFile(join(workspaceRoot, 'dist', 'distribution', 'distribution-manifest.json'), 'utf8'),
    ) as { productVersion: string; createdAt: string }
    const builder = await readFile(join(workspaceRoot, 'scripts', 'build-distribution.ts'), 'utf8')

    expect(release).toEqual({
      schemaVersion: 1,
      productVersion: '0.1.0',
      createdAt: '2026-08-27T10:30:00.611Z',
    })
    expect(manifest.productVersion).toBe(release.productVersion)
    expect(manifest.createdAt).toBe(release.createdAt)
    expect(builder).not.toContain('nowUtc')
  })

  it('matches digestTree directory traversal when sibling package names share a prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'georesearch-distribution-integrity-'))
    temporaryRoots.push(root)
    const source = join(root, 'packages', 'fixture')
    await mkdir(join(source, 'lib', 'node_modules', 'tesseract.js'), { recursive: true })
    await mkdir(join(source, 'lib', 'node_modules', 'tesseract.js-core'), { recursive: true })
    await writeFile(join(source, 'lib', 'node_modules', 'tesseract.js', 'LICENSE.md'), 'runtime\n')
    await writeFile(join(source, 'lib', 'node_modules', 'tesseract.js', '.npmignore'), 'ignored\n')
    await writeFile(join(source, 'lib', 'node_modules', 'tesseract.js-core', 'LICENSE'), 'core\n')
    await writeFile(join(source, 'README.md'), 'fixture\n')
    await writeFile(join(source, 'LICENSE'), 'license\n')
    const sourceManifest = {
      name: '@georesearch/fixture',
      version: '0.1.0',
      dependencies: { '@georesearch/dependency': 'workspace:*' },
      files: ['lib', 'README.md', 'LICENSE'],
    }
    await writeFile(join(source, 'package.json'), `${JSON.stringify(sourceManifest, undefined, 2)}\n`)

    const distribution = join(root, 'distribution-package')
    await mkdir(distribution, { recursive: true })
    await cp(join(source, 'lib'), join(distribution, 'lib'), {
      recursive: true,
      filter: includeDistributionPath,
    })
    await cp(join(source, 'README.md'), join(distribution, 'README.md'))
    await cp(join(source, 'LICENSE'), join(distribution, 'LICENSE'))
    await writeFile(
      join(distribution, 'package.json'),
      `${JSON.stringify(rewriteWorkspaceRanges(sourceManifest, '0.1.0'), undefined, 2)}\n`,
    )

    const expected = await expectedDistributionPackageDigest(root, 'fixture', sourceManifest, '0.1.0')
    const actual = (await digestTree(distribution)).digest

    expect(expected).toBe(actual)
    expect(JSON.parse(await readFile(join(distribution, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: { '@georesearch/dependency': '0.1.0' },
    })
  })
})
