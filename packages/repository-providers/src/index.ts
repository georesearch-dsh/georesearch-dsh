import { spawn } from 'node:child_process'
import { lstat, readFile, readlink, realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import {
  GeoResearchError,
  digestJson,
  sha256Bytes,
  type RepositoryBuildSystem,
  type RepositoryChange,
  type RepositoryCodeLocator,
  type RepositoryLanguageSummary,
  type RepositoryProviderCapability,
  type Sha256Digest,
} from '@georesearch/dsh-contracts'
import { ProviderLifecycle } from '@georesearch/dsh-provider-lifecycle'

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_FILES = 20_000
const DEFAULT_MAX_CHANGES = 2_000
const DEFAULT_MAX_HASHED_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_CODE_FILE_BYTES = 8 * 1024 * 1024

export interface RepositoryInspection {
  readonly capability: RepositoryProviderCapability
  readonly canonicalRoot: string
  readonly gitDir: string
  readonly gitCommonDir: string
  readonly remoteUrl: string | null
  readonly headCommit: string | null
  readonly branch: string | null
  readonly detached: boolean
  readonly tags: readonly string[]
  readonly targetRef: string | null
  readonly targetCommit: string | null
  readonly targetMatchesHead: boolean
  readonly dirty: boolean
  readonly changes: readonly RepositoryChange[]
  readonly sourceTreeDigest: Sha256Digest
  readonly languages: readonly RepositoryLanguageSummary[]
  readonly buildSystems: readonly RepositoryBuildSystem[]
  readonly entryPoints: readonly string[]
  readonly configurationFiles: readonly string[]
  readonly dataDependencyPaths: readonly string[]
  readonly environmentFiles: readonly string[]
  readonly testPaths: readonly string[]
}

export interface RepositoryInspectRequest {
  readonly workspaceRoot: string
  readonly targetRef?: string
  readonly signal?: AbortSignal
}

export interface RepositoryCodeLocatorRequest {
  readonly path: string
  readonly lineStart: number
  readonly lineEnd: number
}

export interface GitCommandResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

export type GitCommandRunner = (
  workspaceRoot: string,
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<GitCommandResult>

export interface GitRepositoryProviderOptions {
  readonly gitExecutable?: string
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly maxFiles?: number
  readonly maxChanges?: number
  readonly maxHashedBytes?: number
  readonly maxCodeFileBytes?: number
  readonly runGit?: GitCommandRunner
}

export class GitRepositoryProvider {
  readonly capability: RepositoryProviderCapability
  private readonly lifecycle = new ProviderLifecycle()
  private readonly runGit: GitCommandRunner
  private readonly maxFiles: number
  private readonly maxChanges: number
  private readonly maxHashedBytes: number
  private readonly maxCodeFileBytes: number

  constructor(options: GitRepositoryProviderOptions = {}) {
    this.maxFiles = boundedInteger(options.maxFiles ?? DEFAULT_MAX_FILES, 1, 100_000, 'maxFiles')
    this.maxChanges = boundedInteger(options.maxChanges ?? DEFAULT_MAX_CHANGES, 1, 20_000, 'maxChanges')
    this.maxHashedBytes = boundedInteger(
      options.maxHashedBytes ?? DEFAULT_MAX_HASHED_BYTES,
      1,
      2 * 1024 * 1024 * 1024,
      'maxHashedBytes',
    )
    this.maxCodeFileBytes = boundedInteger(
      options.maxCodeFileBytes ?? DEFAULT_MAX_CODE_FILE_BYTES,
      1,
      128 * 1024 * 1024,
      'maxCodeFileBytes',
    )
    const maxOutputBytes = boundedInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      1,
      64 * 1024 * 1024,
      'maxOutputBytes',
    )
    const timeoutMs = boundedInteger(options.timeoutMs ?? 30_000, 1, 120_000, 'timeoutMs')
    this.runGit = options.runGit ?? createGitCommandRunner({
      executable: options.gitExecutable ?? 'git',
      timeoutMs,
      maxOutputBytes,
    })
    this.capability = Object.freeze({
      providerId: 'git-cli',
      providerVersion: '1.0.0',
      shell: false,
      readOnlyCommands: true,
      maxFiles: this.maxFiles,
      maxChanges: this.maxChanges,
      maxHashedBytes: this.maxHashedBytes,
    })
  }

  inspect(request: RepositoryInspectRequest): Promise<RepositoryInspection> {
    return this.lifecycle.admit(() => this.inspectAdmitted(request))
  }

  bindCodeLocator(
    repositoryRoot: string,
    request: RepositoryCodeLocatorRequest,
    signal?: AbortSignal,
  ): Promise<RepositoryCodeLocator> {
    return this.lifecycle.admit(() => this.bindCodeLocatorAdmitted(repositoryRoot, request, signal))
  }

  drain(): Promise<void> {
    return this.lifecycle.drain()
  }

  dispose(): Promise<void> {
    return this.lifecycle.dispose()
  }

  private async inspectAdmitted(request: RepositoryInspectRequest): Promise<RepositoryInspection> {
    request.signal?.throwIfAborted()
    const requestedRoot = await realpath(resolve(request.workspaceRoot)).catch(error => {
      throw new GeoResearchError('REPOSITORY_NOT_FOUND', 'repository workspace is unavailable', { cause: error })
    })
    const rootResult = await this.required(requestedRoot, ['rev-parse', '--show-toplevel'], request.signal)
    const canonicalRoot = await realpath(resolve(rootResult.stdout.trim()))
    assertContained(canonicalRoot, requestedRoot, 'bound workspace')

    const [gitDirResult, commonDirResult, headResult, branchResult, statusResult, remoteResult, tagsResult, indexResult, filesResult] = await Promise.all([
      this.required(canonicalRoot, ['rev-parse', '--absolute-git-dir'], request.signal),
      this.required(canonicalRoot, ['rev-parse', '--git-common-dir'], request.signal),
      this.optional(canonicalRoot, ['rev-parse', '--verify', 'HEAD'], [0, 128], request.signal),
      this.optional(canonicalRoot, ['symbolic-ref', '--short', '-q', 'HEAD'], [0, 1], request.signal),
      this.required(canonicalRoot, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], request.signal),
      this.optional(canonicalRoot, ['remote', 'get-url', 'origin'], [0, 2], request.signal),
      this.optional(canonicalRoot, ['tag', '--points-at', 'HEAD'], [0, 128], request.signal),
      this.required(canonicalRoot, ['ls-files', '--stage', '-z'], request.signal),
      this.required(canonicalRoot, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], request.signal),
    ])

    const gitDir = await canonicalGitPath(canonicalRoot, gitDirResult.stdout)
    const gitCommonDir = await canonicalGitPath(canonicalRoot, commonDirResult.stdout)
    const headCommit = nullableOutput(headResult)
    const branch = nullableOutput(branchResult)
    const status = parseStatus(statusResult.stdout)
    if (status.changes.length > this.maxChanges) {
      throw new GeoResearchError('REPOSITORY_OUTPUT_TOO_LARGE', `repository has more than ${this.maxChanges} visible changes`)
    }
    const paths = nulList(filesResult.stdout).map(normalizedRepositoryPath)
    if (paths.length > this.maxFiles) {
      throw new GeoResearchError('REPOSITORY_OUTPUT_TOO_LARGE', `repository has more than ${this.maxFiles} visible files`)
    }
    assertUnique(paths, 'repository file paths')
    const changes = await this.hashChanges(canonicalRoot, status.changes, request.signal)
    const indexEntries = nulList(indexResult.stdout).map(entry => normalizedIndexEntry(entry))
    const targetRef = request.targetRef === undefined ? null : repositoryRef(request.targetRef)
    const targetCommit = targetRef === null
      ? headCommit
      : nullableOutput(await this.optional(
          canonicalRoot,
          ['rev-parse', '--verify', `${targetRef}^{commit}`],
          [0, 128],
          request.signal,
        ))
    const sourceTreeDigest = digestJson({
      domain: 'georesearch.repository-source-tree/v1',
      headCommit,
      indexEntries,
      statusEntries: status.rawEntries,
      changes,
    })
    const remoteUrl = sanitizedRemoteUrl(nullableOutput(remoteResult))

    return {
      capability: this.capability,
      canonicalRoot,
      gitDir,
      gitCommonDir,
      remoteUrl,
      headCommit,
      branch,
      detached: headCommit !== null && branch === null,
      tags: tagsResult.stdout.split(/\r?\n/u).map(value => value.trim()).filter(Boolean).sort(),
      targetRef,
      targetCommit,
      targetMatchesHead: targetCommit !== null && targetCommit === headCommit,
      dirty: changes.length > 0,
      changes,
      sourceTreeDigest,
      languages: languageSummary(paths),
      buildSystems: buildSystemSummary(paths),
      entryPoints: selectPaths(paths, path => ENTRY_POINT.test(path), 128),
      configurationFiles: selectPaths(paths, path => CONFIGURATION_FILE.test(path), 256),
      dataDependencyPaths: selectPaths(paths, path => DATA_DEPENDENCY.test(path), 256),
      environmentFiles: selectPaths(paths, path => ENVIRONMENT_FILE.test(path), 128),
      testPaths: selectPaths(paths, path => TEST_PATH.test(path), 512),
    }
  }

  private async bindCodeLocatorAdmitted(
    repositoryRoot: string,
    request: RepositoryCodeLocatorRequest,
    signal?: AbortSignal,
  ): Promise<RepositoryCodeLocator> {
    signal?.throwIfAborted()
    const root = await realpath(resolve(repositoryRoot))
    const relativePath = normalizedRepositoryPath(request.path)
    const lexical = resolve(root, relativePath)
    assertContained(root, lexical, 'code locator')
    const info = await lstat(lexical).catch(error => {
      throw new GeoResearchError('REPOSITORY_AUDIT_INVALID', `code locator path ${relativePath} is unavailable`, { cause: error })
    })
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new GeoResearchError('REPOSITORY_AUDIT_INVALID', `code locator path ${relativePath} is not a regular file`)
    }
    if (info.size > this.maxCodeFileBytes) {
      throw new GeoResearchError('REPOSITORY_OUTPUT_TOO_LARGE', `code locator file ${relativePath} exceeds the read limit`)
    }
    const canonical = await realpath(lexical)
    assertContained(root, canonical, 'code locator')
    const bytes = await readFile(canonical)
    signal?.throwIfAborted()
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error) {
      throw new GeoResearchError('REPOSITORY_AUDIT_INVALID', `code locator file ${relativePath} is not UTF-8 text`, { cause: error })
    }
    const lineStart = positiveInteger(request.lineStart, 'lineStart')
    const lineEnd = positiveInteger(request.lineEnd, 'lineEnd')
    if (lineEnd < lineStart) throw new GeoResearchError('REPOSITORY_AUDIT_INVALID', 'lineEnd precedes lineStart')
    const lines = text.split(/\r?\n/u)
    if (lineEnd > lines.length) {
      throw new GeoResearchError('REPOSITORY_AUDIT_INVALID', `code locator ends after line ${lines.length}`)
    }
    const selected = lines.slice(lineStart - 1, lineEnd).join('\n')
    return {
      path: relativePath,
      lineStart,
      lineEnd,
      fileDigest: sha256Bytes(bytes),
      lineDigest: sha256Bytes(Buffer.from(selected, 'utf8')),
    }
  }

  private async hashChanges(
    root: string,
    rawChanges: readonly RawRepositoryChange[],
    signal?: AbortSignal,
  ): Promise<RepositoryChange[]> {
    let totalBytes = 0
    const changes: RepositoryChange[] = []
    for (const raw of [...rawChanges].sort((left, right) => left.path.localeCompare(right.path))) {
      signal?.throwIfAborted()
      const path = normalizedRepositoryPath(raw.path)
      const absolute = resolve(root, path)
      assertContained(root, absolute, 'repository change')
      let info
      try {
        info = await lstat(absolute)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          changes.push({ status: raw.status, path })
          continue
        }
        throw error
      }
      if (info.isSymbolicLink()) {
        const target = Buffer.from(await readlink(absolute), 'utf8')
        totalBytes += target.byteLength
        if (totalBytes > this.maxHashedBytes) {
          throw new GeoResearchError('REPOSITORY_OUTPUT_TOO_LARGE', 'repository dirty-file hashing exceeded its byte limit')
        }
        changes.push({ status: raw.status, path, digest: sha256Bytes(target), size: target.byteLength })
        continue
      }
      if (!info.isFile()) {
        changes.push({ status: raw.status, path })
        continue
      }
      totalBytes += info.size
      if (totalBytes > this.maxHashedBytes) {
        throw new GeoResearchError('REPOSITORY_OUTPUT_TOO_LARGE', 'repository dirty-file hashing exceeded its byte limit')
      }
      const bytes = await readFile(absolute)
      changes.push({ status: raw.status, path, digest: sha256Bytes(bytes), size: bytes.byteLength })
    }
    return changes
  }

  private async required(root: string, args: readonly string[], signal?: AbortSignal): Promise<GitCommandResult> {
    return this.optional(root, args, [0], signal)
  }

  private async optional(
    root: string,
    args: readonly string[],
    allowedCodes: readonly number[],
    signal?: AbortSignal,
  ): Promise<GitCommandResult> {
    let result: GitCommandResult
    try {
      result = await this.runGit(root, args, signal)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new GeoResearchError('REPOSITORY_PROVIDER_UNAVAILABLE', 'the configured Git executable is unavailable', { cause: error })
      }
      throw error
    }
    if (!allowedCodes.includes(result.code)) {
      const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
      const code = args[0] === 'rev-parse' && args[1] === '--show-toplevel'
        ? 'REPOSITORY_NOT_FOUND'
        : 'REPOSITORY_COMMAND_FAILED'
      throw new GeoResearchError(code, `git ${args.join(' ')} failed: ${detail}`)
    }
    return result
  }
}

export interface GitCommandRunnerOptions {
  readonly executable: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

export function createGitCommandRunner(options: GitCommandRunnerOptions): GitCommandRunner {
  return async (workspaceRoot, args, signal) => await new Promise<GitCommandResult>((resolveResult, rejectResult) => {
    signal?.throwIfAborted()
    const child = spawn(options.executable, ['-C', workspaceRoot, ...args], {
      cwd: workspaceRoot,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'Never',
        LC_ALL: 'C',
      },
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    const finish = (error?: unknown, result?: GitCommandResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      error === undefined ? resolveResult(result as GitCommandResult) : rejectResult(error)
    }
    const overflow = (): void => {
      child.kill('SIGKILL')
      finish(new GeoResearchError('REPOSITORY_OUTPUT_TOO_LARGE', 'Git command output exceeded its byte limit'))
    }
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength
      if (stdoutBytes > options.maxOutputBytes) overflow()
      else stdout.push(Buffer.from(chunk))
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength
      if (stderrBytes > options.maxOutputBytes) overflow()
      else stderr.push(Buffer.from(chunk))
    })
    const onAbort = (): void => {
      child.kill('SIGKILL')
      finish(signal?.reason ?? new DOMException('aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new GeoResearchError('REPOSITORY_COMMAND_FAILED', `Git command exceeded ${options.timeoutMs} ms`))
    }, options.timeoutMs)
    timeout.unref()
    child.once('error', finish)
    child.once('close', code => finish(undefined, {
      code: code ?? 1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }))
  })
}

interface RawRepositoryChange {
  readonly status: string
  readonly path: string
}

function parseStatus(source: string): {
  readonly rawEntries: readonly string[]
  readonly changes: readonly RawRepositoryChange[]
} {
  const entries = nulList(source)
  const rawEntries: string[] = []
  const changes: RawRepositoryChange[] = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as string
    rawEntries.push(entry)
    if (entry.startsWith('# ')) continue
    if (entry.startsWith('? ') || entry.startsWith('! ')) {
      changes.push({ status: entry[0] as string, path: entry.slice(2) })
      continue
    }
    if (entry.startsWith('1 ')) {
      changes.push({ status: entry.slice(2, 4), path: entry.split(' ').slice(8).join(' ') })
      continue
    }
    if (entry.startsWith('2 ')) {
      changes.push({ status: entry.slice(2, 4), path: entry.split(' ').slice(9).join(' ') })
      const original = entries[index + 1]
      if (original !== undefined) {
        rawEntries.push(original)
        index += 1
      }
      continue
    }
    if (entry.startsWith('u ')) {
      changes.push({ status: 'UU', path: entry.split(' ').slice(10).join(' ') })
      continue
    }
    throw new GeoResearchError('REPOSITORY_COMMAND_FAILED', 'Git returned an unsupported porcelain-v2 status entry')
  }
  return { rawEntries, changes }
}

function nulList(source: string): string[] {
  const values = source.split('\0')
  if (values.at(-1) === '') values.pop()
  return values
}

function normalizedIndexEntry(value: string): string {
  const tab = value.indexOf('\t')
  if (tab < 0) throw new GeoResearchError('REPOSITORY_COMMAND_FAILED', 'Git returned an invalid index entry')
  const identity = value.slice(0, tab)
  const path = normalizedRepositoryPath(value.slice(tab + 1))
  return `${identity}\t${path}`
}

function normalizedRepositoryPath(value: string): string {
  if (value.length === 0 || value.includes('\0')) throw new GeoResearchError('REPOSITORY_AUDIT_INVALID', 'repository path is invalid')
  const path = value.replaceAll('\\', '/')
  if (path.startsWith('/') || /^[A-Za-z]:\//u.test(path)
    || path === '..' || path.startsWith('../') || path.includes('/../')) {
    throw new GeoResearchError('REPOSITORY_AUDIT_INVALID', `repository path escapes the root: ${path}`)
  }
  return path
}

function repositoryRef(value: string): string {
  if (value.trim().length === 0 || value.includes('\0') || value.length > 256 || value.startsWith('-')) {
    throw new GeoResearchError('REPOSITORY_AUDIT_INVALID', 'targetRef is invalid')
  }
  return value
}

async function canonicalGitPath(root: string, output: string): Promise<string> {
  const value = output.trim()
  if (value.length === 0) throw new GeoResearchError('REPOSITORY_COMMAND_FAILED', 'Git returned an empty directory path')
  return await realpath(isAbsolute(value) ? value : resolve(root, value))
}

function nullableOutput(result: GitCommandResult): string | null {
  if (result.code !== 0) return null
  const value = result.stdout.trim()
  return value.length === 0 ? null : value
}

function sanitizedRemoteUrl(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  if (/^[A-Za-z]:[\\/]/u.test(trimmed)) return trimmed
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      parsed.username = ''
      parsed.password = ''
      parsed.search = ''
      parsed.hash = ''
      return parsed.toString()
    } catch (error) {
      throw new GeoResearchError('REPOSITORY_COMMAND_FAILED', 'Git returned an invalid remote URL', { cause: error })
    }
  }
  const scp = /^(?:[^@/:]+@)?([^:/]+):(.+)$/u.exec(trimmed)
  if (scp !== null) return `ssh://${scp[1]}/${scp[2]}`
  return trimmed
}

function assertContained(root: string, candidate: string, field: string): void {
  const relation = relative(resolve(root), resolve(candidate))
  if (relation === '') return
  if (isAbsolute(relation) || relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
    throw new GeoResearchError('REPOSITORY_AUDIT_INVALID', `${field} escapes the bound workspace`)
  }
}

function languageSummary(paths: readonly string[]): RepositoryLanguageSummary[] {
  const counts = new Map<string, number>()
  for (const path of paths) {
    const language = LANGUAGES.get(extname(path).toLowerCase())
    if (language !== undefined) counts.set(language, (counts.get(language) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([language, fileCount]) => ({ language, fileCount }))
    .sort((left, right) => right.fileCount - left.fileCount || left.language.localeCompare(right.language))
}

function buildSystemSummary(paths: readonly string[]): RepositoryBuildSystem[] {
  const result: RepositoryBuildSystem[] = []
  for (const [name, matcher] of BUILD_SYSTEMS) {
    const manifestPaths = paths.filter(path => matcher.test(path)).sort()
    if (manifestPaths.length > 0) result.push({ name, manifestPaths })
  }
  return result.sort((left, right) => left.name.localeCompare(right.name))
}

function selectPaths(paths: readonly string[], predicate: (path: string) => boolean, limit: number): string[] {
  return paths.filter(predicate).sort().slice(0, limit)
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new GeoResearchError('REPOSITORY_AUDIT_INVALID', `${field} must be a positive safe integer`)
  }
  return value as number
}

function boundedInteger(value: number, minimum: number, maximum: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} must be an integer from ${minimum} through ${maximum}`)
  }
  return value
}

function assertUnique(values: readonly string[], field: string): void {
  if (new Set(values).size !== values.length) throw new GeoResearchError('REPOSITORY_AUDIT_INVALID', `${field} are not unique`)
}

const LANGUAGES = new Map<string, string>([
  ['.c', 'C'], ['.h', 'C/C++ Header'], ['.cc', 'C++'], ['.cpp', 'C++'], ['.cxx', 'C++'],
  ['.cs', 'C#'], ['.java', 'Java'], ['.kt', 'Kotlin'], ['.go', 'Go'], ['.rs', 'Rust'],
  ['.swift', 'Swift'], ['.m', 'MATLAB/Objective-C'], ['.f', 'Fortran'], ['.f90', 'Fortran'],
  ['.r', 'R'], ['.jl', 'Julia'], ['.py', 'Python'], ['.ipynb', 'Jupyter Notebook'],
  ['.js', 'JavaScript'], ['.jsx', 'JavaScript'], ['.ts', 'TypeScript'], ['.tsx', 'TypeScript'],
  ['.php', 'PHP'], ['.rb', 'Ruby'], ['.pl', 'Perl'], ['.lua', 'Lua'], ['.sh', 'Shell'],
  ['.ps1', 'PowerShell'], ['.v', 'Verilog'], ['.sv', 'SystemVerilog'], ['.vhd', 'VHDL'],
  ['.cu', 'CUDA'], ['.cl', 'OpenCL'], ['.sql', 'SQL'], ['.tex', 'TeX'],
])

const BUILD_SYSTEMS: ReadonlyArray<readonly [string, RegExp]> = [
  ['Node.js package scripts', /(?:^|\/)package\.json$/iu],
  ['pnpm', /(?:^|\/)pnpm-lock\.yaml$/iu],
  ['npm', /(?:^|\/)package-lock\.json$/iu],
  ['Yarn', /(?:^|\/)yarn\.lock$/iu],
  ['Python packaging', /(?:^|\/)(?:pyproject\.toml|setup\.py|setup\.cfg)$/iu],
  ['Python requirements', /(?:^|\/)(?:requirements[^/]*\.txt|environment\.ya?ml)$/iu],
  ['Cargo', /(?:^|\/)Cargo\.toml$/u],
  ['Go modules', /(?:^|\/)go\.mod$/u],
  ['CMake', /(?:^|\/)CMakeLists\.txt$/u],
  ['Make', /(?:^|\/)(?:Makefile|GNUmakefile)$/u],
  ['Maven', /(?:^|\/)pom\.xml$/u],
  ['Gradle', /(?:^|\/)(?:build|settings)\.gradle(?:\.kts)?$/u],
  ['.NET', /\.(?:sln|csproj|fsproj)$/iu],
  ['R package', /(?:^|\/)DESCRIPTION$/u],
]

const ENTRY_POINT = /(?:^|\/)(?:main|index|cli|train|evaluate|inference|run|reproduce)(?:[._-][^/]*)?\.[A-Za-z0-9]+$|(?:^|\/)scripts?\//iu
const CONFIGURATION_FILE = /(?:^|\/)(?:config|configs|configuration|settings)(?:\/|[._-])|\.(?:ya?ml|toml|ini|cfg|json5?)$/iu
const DATA_DEPENDENCY = /(?:^|\/)(?:data|dataset|datasets|download|downloads|assets)(?:\/|$)/iu
const ENVIRONMENT_FILE = /(?:^|\/)(?:requirements[^/]*\.txt|environment\.ya?ml|pyproject\.toml|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|go\.sum|Dockerfile|docker-compose\.ya?ml)$/iu
const TEST_PATH = /(?:^|\/)(?:test|tests|spec|specs)(?:\/|$)|(?:^|\/)(?:test_|[^/]+[._-](?:test|spec))\.[^/]+$/iu
