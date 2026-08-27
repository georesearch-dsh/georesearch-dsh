#!/usr/bin/env node

import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { extract as extractTar } from 'tar-stream'
import {
  install,
  reconcileHomePatch,
  recover,
  uninstall,
  upgrade,
  verify,
  type InstallerResult,
} from './transaction.js'

type Command = 'install' | 'upgrade' | 'verify' | 'uninstall' | 'recover'

interface ParsedArguments {
  readonly command: Command
  readonly home: string
  readonly distributionDir?: string
  readonly harnessRoot?: string
  readonly reconcileHomePatch: boolean
}

const HELP = `Usage: georesearch-dsh <command> [options]

Commands:
  install
  upgrade
  verify
  uninstall
  recover

Options:
  --dsh-home <path>
  --distribution-dir <path>
  --harness-root <path>
  --reconcile-home-patch   verify only; commits a new generation
  --help
`

try {
  const args = parseArguments(process.argv.slice(2))
  const result = await execute(args)
  process.stdout.write(`${JSON.stringify(result, undefined, 2)}\n`)
} catch (error) {
  process.stderr.write(`${formatError(error)}\n`)
  process.exitCode = 1
}

async function execute(args: ParsedArguments): Promise<InstallerResult> {
  switch (args.command) {
    case 'install':
      return runMutation(args, install)
    case 'upgrade':
      return runMutation(args, upgrade)
    case 'verify':
      return args.reconcileHomePatch
        ? runMutation(args, reconcileHomePatch)
        : verify({
            home: args.home,
            ...(args.harnessRoot === undefined ? {} : { harnessRoot: args.harnessRoot }),
          })
    case 'uninstall':
      return uninstall({
        home: args.home,
        ...(args.harnessRoot === undefined ? {} : { harnessRoot: args.harnessRoot }),
      })
    case 'recover':
      return recover({
        home: args.home,
        ...(args.harnessRoot === undefined ? {} : { harnessRoot: args.harnessRoot }),
      })
  }
}

async function runMutation(
  args: ParsedArguments,
  action: (options: {
    readonly home: string
    readonly distributionDir: string
    readonly harnessRoot?: string
  }) => Promise<InstallerResult>,
): Promise<InstallerResult> {
  const distribution = await resolveDistribution(args.distributionDir)
  try {
    return await action({
      home: args.home,
      distributionDir: distribution.directory,
      ...(args.harnessRoot === undefined ? {} : { harnessRoot: args.harnessRoot }),
    })
  } finally {
    await distribution.cleanup?.()
  }
}

async function resolveDistribution(explicitDirectory?: string): Promise<{
  readonly directory: string
  readonly cleanup?: () => Promise<void>
}> {
  if (explicitDirectory !== undefined) {
    assertDistributionDirectory(explicitDirectory)
    return { directory: explicitDirectory }
  }
  const bundledDirectory = fileURLToPath(new URL('../distribution/', import.meta.url))
  if (existsSync(join(bundledDirectory, 'distribution-manifest.json'))) {
    return { directory: bundledDirectory }
  }
  const archivePath = fileURLToPath(new URL('../distribution.tar', import.meta.url))
  if (existsSync(archivePath)) {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'georesearch-installer-distribution-'))
    try {
      await extractDistributionArchive(archivePath, temporaryRoot)
      const directory = join(temporaryRoot, 'distribution')
      assertDistributionDirectory(directory)
      return {
        directory,
        cleanup: async () => await rm(temporaryRoot, { recursive: true, force: true }),
      }
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true })
      throw error
    }
  }
  const workspaceDirectory = fileURLToPath(new URL('../../../dist/distribution/', import.meta.url))
  assertDistributionDirectory(workspaceDirectory)
  return { directory: workspaceDirectory }
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  const command = argv[0]
  if (command !== 'install' && command !== 'upgrade' && command !== 'verify'
    && command !== 'uninstall' && command !== 'recover') {
    throw new Error(HELP)
  }
  let home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  let distributionDir: string | undefined
  let harnessRoot = process.env.GEORESEARCH_HARNESS_ROOT?.trim() || detectHarnessRoot()
  let reconcile = false
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    switch (argument) {
      case '--dsh-home':
        home = requiredValue(argv, ++index, argument)
        break
      case '--distribution-dir':
        distributionDir = requiredValue(argv, ++index, argument)
        break
      case '--harness-root':
        harnessRoot = requiredValue(argv, ++index, argument)
        break
      case '--reconcile-home-patch':
        reconcile = true
        break
      default:
        throw new Error(`unknown argument ${String(argument)}\n${HELP}`)
    }
  }
  if (reconcile && command !== 'verify') {
    throw new Error('--reconcile-home-patch is valid only with verify')
  }
  return {
    command,
    home: resolve(home),
    ...(distributionDir === undefined ? {} : { distributionDir: resolve(distributionDir) }),
    ...(harnessRoot === undefined ? {} : { harnessRoot: resolve(harnessRoot) }),
    reconcileHomePatch: reconcile,
  }
}

function requiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index]
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value`)
  return value
}

function assertDistributionDirectory(directory: string): void {
  if (!existsSync(join(directory, 'distribution-manifest.json'))) {
    throw new Error(`distribution manifest not found under ${directory}; pass --distribution-dir`)
  }
}

async function extractDistributionArchive(archivePath: string, destination: string): Promise<void> {
  const unpack = extractTar()
  let entries = 0
  let totalBytes = 0
  unpack.on('entry', (header, stream, next) => {
    void (async () => {
      entries += 1
      if (entries > 20_000) throw new Error('bundled distribution archive has too many entries')
      const target = containedArchivePath(destination, header.name)
      if (header.type === 'directory') {
        await mkdir(target, { recursive: true })
        for await (const _chunk of stream) void _chunk
      } else if (header.type === 'file') {
        totalBytes += header.size ?? 0
        if (totalBytes > 1024 * 1024 * 1024) throw new Error('bundled distribution archive is too large')
        await mkdir(dirname(target), { recursive: true })
        await pipeline(stream, createWriteStream(target, { flags: 'wx', mode: header.mode ?? 0o644 }))
      } else {
        throw new Error(`bundled distribution archive contains unsupported entry type ${header.type}`)
      }
    })().then(() => next(), error => unpack.destroy(error as Error))
  })
  await pipeline(createReadStream(archivePath), unpack)
}

function containedArchivePath(root: string, name: string): string {
  const normalized = name.replaceAll('\\', '/')
  if (normalized.length === 0 || normalized.includes('\0') || normalized.startsWith('/')
    || /^[A-Za-z]:/u.test(normalized) || normalized.split('/').includes('..')) {
    throw new Error(`bundled distribution archive path is unsafe: ${name}`)
  }
  const target = resolve(root, ...normalized.split('/').filter(Boolean))
  const relation = relative(root, target)
  if (relation === '' || isAbsolute(relation) || relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new Error(`bundled distribution archive path escapes its root: ${name}`)
  }
  return target
}

function detectHarnessRoot(): string | undefined {
  for (const candidate of [
    resolve(process.cwd(), '..', 'deepseek-harness-master'),
    resolve(process.cwd(), 'deepseek-harness-master'),
  ]) {
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

function formatError(error: unknown): string {
  const lines: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current !== undefined && !seen.has(current)) {
    seen.add(current)
    lines.push(current instanceof Error ? current.message : String(current))
    current = current instanceof Error ? current.cause : undefined
  }
  return lines.join('\nCaused by: ')
}
