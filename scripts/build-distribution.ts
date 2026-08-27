import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PRODUCT_VERSION, digestTree } from '@georesearch/dsh-contracts'
import { includeDistributionPath, rewriteWorkspaceRanges } from './distribution-integrity.ts'
import { loadReleaseMetadata } from './release-metadata.ts'
import { WORKSPACE_PACKAGES } from './workspace-packages.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const releaseMetadata = await loadReleaseMetadata(root, PRODUCT_VERSION)
const output = join(root, 'dist', 'distribution')
await rm(output, { recursive: true, force: true })
await mkdir(join(output, 'packages'), { recursive: true })

const packages = []
for (const { folder, name: expectedName } of WORKSPACE_PACKAGES) {
  const source = join(root, 'packages', folder)
  const sourceManifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as Record<string, unknown>
  const packageName = String(sourceManifest.name)
  if (packageName !== expectedName) {
    throw new Error(`workspace package identity mismatch: ${folder} is ${packageName}, expected ${expectedName}`)
  }
  const destination = join(output, 'packages', packageName.split('/')[1] as string)
  await mkdir(destination, { recursive: true })
  for (const entry of ['lib', 'README.md', 'LICENSE']) {
    await cp(join(source, entry), join(destination, entry), {
      recursive: true,
      filter: includeDistributionPath,
    })
  }
  if (folder === 'bundle') {
    await cp(join(source, 'dsh-plugin.json'), join(destination, 'dsh-plugin.json'), {
      filter: includeDistributionPath,
    })
    await cp(join(source, 'cordis.patch.yml'), join(destination, 'cordis.patch.yml'), {
      filter: includeDistributionPath,
    })
    await cp(join(source, 'schemas'), join(destination, 'schemas'), {
      recursive: true,
      filter: includeDistributionPath,
    })
  }
  const manifest = rewriteWorkspaceRanges(sourceManifest, PRODUCT_VERSION)
  await writeFile(join(destination, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
  packages.push({
    name: packageName,
    version: PRODUCT_VERSION,
    directory: relative(output, destination).replaceAll('\\', '/'),
    treeDigest: (await digestTree(destination)).digest,
  })
}

const presetRoot = join(output, 'preset', 'georesearch')
await cp(join(root, 'preset', 'georesearch'), presetRoot, { recursive: true })
const pythonRoot = join(output, 'python')
await cp(join(root, 'python'), pythonRoot, {
  recursive: true,
  filter: source => !source.includes('__pycache__') && !source.endsWith('.pyc'),
})

const manifest = {
  schemaVersion: 1,
  productVersion: PRODUCT_VERSION,
  packages,
  presetDirectory: relative(output, presetRoot).replaceAll('\\', '/'),
  presetTreeDigest: (await digestTree(presetRoot)).digest,
  pythonDirectory: relative(output, pythonRoot).replaceAll('\\', '/'),
  pythonTreeDigest: (await digestTree(pythonRoot)).digest,
  createdAt: releaseMetadata.createdAt,
}
await writeFile(join(output, 'distribution-manifest.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ output, packages: packages.length }, undefined, 2)}\n`)
