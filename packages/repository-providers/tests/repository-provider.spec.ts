import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { GitRepositoryProvider } from '../src/index.js'

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('bounded Git repository provider', () => {
  it('audits a real repository and binds exact UTF-8 code lines', async () => {
    const root = await repositoryFixture()
    const provider = new GitRepositoryProvider()
    try {
      const head = git(root, ['rev-parse', 'HEAD'])
      const clean = await provider.inspect({ workspaceRoot: root, targetRef: 'HEAD' })
      expect(clean).toMatchObject({
        headCommit: head,
        targetCommit: head,
        targetMatchesHead: true,
        dirty: false,
        branch: expect.any(String),
        remoteUrl: 'https://github.com/example/repository.git',
      })
      expect(clean.capability).toMatchObject({ shell: false, readOnlyCommands: true })
      expect(clean.languages).toContainEqual({ language: 'TypeScript', fileCount: 2 })
      expect(clean.buildSystems).toContainEqual({
        name: 'Node.js package scripts',
        manifestPaths: ['package.json'],
      })
      expect(clean.entryPoints).toContain('src/index.ts')
      expect(clean.configurationFiles).toContain('configs/model.yaml')
      expect(clean.dataDependencyPaths).toContain('data/README.md')
      expect(clean.testPaths).toContain('tests/index.spec.ts')

      const locator = await provider.bindCodeLocator(root, {
        path: 'src/index.ts',
        lineStart: 1,
        lineEnd: 2,
      })
      expect(locator).toMatchObject({ path: 'src/index.ts', lineStart: 1, lineEnd: 2 })
      expect(locator.fileDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)
      expect(locator.lineDigest).toMatch(/^sha256:[0-9a-f]{64}$/u)

      await writeFile(join(root, 'src', 'index.ts'), 'export const threshold = 0.6\nexport const run = () => threshold\n')
      const dirty = await provider.inspect({ workspaceRoot: root })
      expect(dirty.dirty).toBe(true)
      expect(dirty.sourceTreeDigest).not.toBe(clean.sourceTreeDigest)
      expect(dirty.changes).toEqual([
        expect.objectContaining({ status: '.M', path: 'src/index.ts', size: expect.any(Number) }),
      ])
    } finally {
      await provider.dispose()
    }
  })

  it('fails closed when repository enumeration exceeds its configured bound', async () => {
    const root = await repositoryFixture()
    const provider = new GitRepositoryProvider({ maxFiles: 1 })
    try {
      await expect(provider.inspect({ workspaceRoot: root }))
        .rejects.toMatchObject({ code: 'REPOSITORY_OUTPUT_TOO_LARGE' })
    } finally {
      await provider.dispose()
    }
  })

  it('hashes files inside untracked directories instead of binding only the directory name', async () => {
    const root = await repositoryFixture()
    const provider = new GitRepositoryProvider()
    try {
      await mkdir(join(root, 'scratch'), { recursive: true })
      await writeFile(join(root, 'scratch', 'result.txt'), 'first result\n')
      const first = await provider.inspect({ workspaceRoot: root })
      expect(first.changes).toEqual([
        expect.objectContaining({ status: '?', path: 'scratch/result.txt', digest: expect.any(String) }),
      ])

      await writeFile(join(root, 'scratch', 'result.txt'), 'second result\n')
      const second = await provider.inspect({ workspaceRoot: root })
      expect(second.changes).toEqual([
        expect.objectContaining({ status: '?', path: 'scratch/result.txt', digest: expect.any(String) }),
      ])
      expect(second.sourceTreeDigest).not.toBe(first.sourceTreeDigest)
    } finally {
      await provider.dispose()
    }
  })

  it('removes embedded credentials and query tokens from the reported remote URL', async () => {
    const root = await repositoryFixture()
    git(root, [
      'remote',
      'set-url',
      'origin',
      'https://token-user:token-password@github.com/example/repository.git?access_token=secret#fragment',
    ])
    const provider = new GitRepositoryProvider()
    try {
      const inspected = await provider.inspect({ workspaceRoot: root })
      expect(inspected.remoteUrl).toBe('https://github.com/example/repository.git')
      expect(JSON.stringify(inspected)).not.toContain('token-user')
      expect(JSON.stringify(inspected)).not.toContain('token-password')
      expect(JSON.stringify(inspected)).not.toContain('access_token')
    } finally {
      await provider.dispose()
    }
  })
})

async function repositoryFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'georesearch-repository-provider-'))
  temporaryRoots.push(root)
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'tests'), { recursive: true })
  await mkdir(join(root, 'configs'), { recursive: true })
  await mkdir(join(root, 'data'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'repository-fixture',
    scripts: { test: 'vitest run' },
  }, undefined, 2) + '\n')
  await writeFile(join(root, 'src', 'index.ts'), 'export const threshold = 0.5\nexport const run = () => threshold\n')
  await writeFile(join(root, 'tests', 'index.spec.ts'), 'export const expected = 0.5\n')
  await writeFile(join(root, 'configs', 'model.yaml'), 'threshold: 0.5\n')
  await writeFile(join(root, 'data', 'README.md'), 'Public fixture data.\n')
  git(root, ['init'])
  git(root, ['config', 'user.email', 'phase4@example.invalid'])
  git(root, ['config', 'user.name', 'Phase 4 Fixture'])
  git(root, ['remote', 'add', 'origin', 'https://github.com/example/repository.git'])
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'fixture'])
  return root
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}
