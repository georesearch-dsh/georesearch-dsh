import { spawnSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HARNESS_BASELINE, nowUtc } from '@georesearch/dsh-contracts'
import { verifyHarnessBaseline } from './source-baseline.ts'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const baselinePath = join(root, 'docs', 'phase0-baseline.json')
const baseline = JSON.parse(await readFile(baselinePath, 'utf8')) as Record<string, any>
const proof = await verifyHarnessBaseline(root)
baseline.capturedAt = nowUtc()
baseline.status = 'verified'
baseline.harness.version = HARNESS_BASELINE.version
baseline.harness.repository = HARNESS_BASELINE.repository
baseline.harness.commit = HARNESS_BASELINE.commit
baseline.harness.releaseCommit = HARNESS_BASELINE.releaseCommit
baseline.harness.gitTree = HARNESS_BASELINE.gitTree
baseline.harness.sourcePath = proof.localMirrorPath
baseline.harness.sourceIdentity = {
  kind: 'github-source-archive',
  archivePath: proof.archivePath,
  verifiedSourcePath: proof.verifiedSourcePath,
  archiveSha256: proof.archiveSha256,
  sourceTreeDigest: proof.sourceTreeDigest,
  fileCount: proof.sourceFileCount,
  localPatch: {
    id: proof.localPatchId,
    manifestPath: proof.localPatchManifestPath,
    manifestSha256: proof.localPatchManifestSha256,
    fileCount: proof.localPatchFileCount,
  },
  localMirrorMatchesExpectedPatch: proof.localMirrorMatchesExpectedPatch,
  verifiedCommitOrArchive: true,
}
baseline.harness.lockfileSha256 = proof.lockfileSha256
baseline.runtime.node = process.version
baseline.runtime.pnpm = commandVersion('pnpm', ['--version'])
baseline.gate = {
  phase1EntryPassed: true,
  reason: 'The official GitHub archive identity and the registered local Harness patch are verified.',
}
await writeFile(baselinePath, `${JSON.stringify(baseline, undefined, 2)}\n`, 'utf8')
process.stdout.write(`${JSON.stringify(proof, undefined, 2)}\n`)

function commandVersion(command: string, args: readonly string[]): string {
  const windowsPnpm = process.platform === 'win32' && command === 'pnpm'
  const executable = windowsPnpm ? (process.env.ComSpec ?? 'cmd.exe') : command
  const commandArgs = windowsPnpm ? ['/d', '/c', 'pnpm', ...args] : [...args]
  const result = spawnSync(executable, commandArgs, {
    cwd: root,
    encoding: 'utf8',
    shell: false,
  })
  if ((result.status ?? 1) !== 0) {
    throw new Error(`${command} version probe failed: ${result.error?.message ?? result.stderr.trim()}`)
  }
  return result.stdout.trim()
}
