import { spawn } from 'node:child_process'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@georesearch/dsh-installation-guard'
import type {} from '@georesearch/dsh-policy'
import { registeredToolNames, spawnCapabilities } from '@georesearch/dsh-compat-rc5'
import {
  DELEGATION_BOOTSTRAP_TOOL,
  DELEGATION_TOOL_NAMES,
  PRESET_ID,
  nowUtc,
} from '@georesearch/dsh-contracts'

export const name = 'georesearch-phase1-probe'
export const inject = [
  'geoResearchInstallation',
  'geoResearchPolicy',
  'geoResearchDelegation',
  'subagents',
  'tools',
  'sandbox',
  'sandboxPolicy',
  'agentPresets',
  'dshStd',
]

export interface Config {
  readonly reportPath: string
}

interface SandboxProviderLike {
  confine(argv: readonly string[], policy: {
    readonly mode: 'read-only'
    readonly workspaceRoot: string
  }): {
    readonly argv: string[]
    readonly enforcement: 'full' | 'partial'
    readonly denialSignatures: readonly string[]
    readonly runnerFailureRules: readonly {
      readonly allowedExitCodes?: readonly number[]
      readonly fatalSignatures: readonly string[]
      readonly informationalLines?: readonly string[]
    }[]
  }
}

interface SandboxPolicyLike {
  readonly workspaceRoot: string
  resolve(request: { readonly mode: 'read-only' }): {
    readonly mode: 'read-only'
    readonly workspaceRoot: string
  }
}

interface AgentPresetsLike {
  readonly defaultId: string
  resolve(id: string): Promise<{
    readonly id: string
    readonly name: string
    readonly broken?: string
  }>
}

interface DshStandardAdapterLike {
  snapshot(): Promise<{
    readonly facets: ReadonlyArray<{
      readonly identity: { readonly component: string; readonly facet: string }
      readonly state: string
    }>
  }>
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  if (typeof config.reportPath !== 'string' || config.reportPath.length === 0) {
    throw new TypeError('georesearch-phase1-probe: reportPath is required')
  }
  ctx.geoResearchInstallation.assertCurrent()
  const capabilities = spawnCapabilities(ctx)
  if (capabilities === undefined || Object.values(capabilities).some(enabled => !enabled)) {
    throw new Error('georesearch-phase1-probe: spawn provider lacks a required capability')
  }

  const registered = new Set(registeredToolNames(ctx))
  const expectedDelegationTools = [...DELEGATION_TOOL_NAMES, DELEGATION_BOOTSTRAP_TOOL]
  const delegationTools = expectedDelegationTools.filter(toolName => registered.has(toolName))
  if (delegationTools.length !== expectedDelegationTools.length) {
    throw new Error('georesearch-phase1-probe: delegation tool registration is incomplete')
  }

  const presetService = requiredService<AgentPresetsLike>(ctx, 'agentPresets')
  const preset = await presetService.resolve(PRESET_ID)
  if (presetService.defaultId !== PRESET_ID || preset.id !== PRESET_ID || preset.broken !== undefined) {
    throw new Error('georesearch-phase1-probe: GeoResearch preset did not resolve as the live default')
  }

  const standardSnapshot = await requiredService<DshStandardAdapterLike>(ctx, 'dshStd').snapshot()
  const standardFacet = standardSnapshot.facets.find(row =>
    row.identity.component === 'org.deepseek.georesearch' && row.identity.facet === 'host')
  if (standardFacet?.state !== 'active') {
    throw new Error('georesearch-phase1-probe: DSH Standard host facet is not active')
  }

  const sandbox = await probeSandbox(ctx)
  const telemetryAbsent = ctx.get('sessionTelemetry', false) === undefined
  if (!telemetryAbsent) throw new Error('georesearch-phase1-probe: Session Telemetry is present')
  if ((ctx.geoResearchPolicy.capabilityStage !== 'phase1'
    && ctx.geoResearchPolicy.capabilityStage !== 'phase2'
    && ctx.geoResearchPolicy.capabilityStage !== 'phase3'
    && ctx.geoResearchPolicy.capabilityStage !== 'phase4'
    && ctx.geoResearchPolicy.capabilityStage !== 'phase5'
    && ctx.geoResearchPolicy.capabilityStage !== 'phase6'
    && ctx.geoResearchPolicy.capabilityStage !== 'full')
    || !ctx.geoResearchPolicy.strictCatalog) {
    throw new Error('georesearch-phase1-probe: policy does not provide the strict Phase 1 foundation')
  }

  const report = {
    schemaVersion: 1,
    phase: 'phase1-foundation',
    checkedAt: nowUtc(),
    installation: {
      installationId: ctx.geoResearchInstallation.active.installationId,
      generation: ctx.geoResearchInstallation.active.generation,
      productVersion: ctx.geoResearchInstallation.active.productVersion,
    },
    policy: {
      capabilityStage: ctx.geoResearchPolicy.capabilityStage,
      strictCatalog: ctx.geoResearchPolicy.strictCatalog,
    },
    spawnProvider: { capabilities },
    sandbox,
    delegationTools,
    preset: { id: preset.id, name: preset.name, defaultId: presetService.defaultId },
    dshStandard: {
      component: standardFacet.identity.component,
      facet: standardFacet.identity.facet,
      state: standardFacet.state,
    },
    telemetryAbsent,
    checks: {
      installationCurrent: true,
      strictPhase1Foundation: true,
      spawnCapabilities: true,
      sandboxConfinement: true,
      delegationTools: true,
      presetResolution: true,
      dshStandardFacet: true,
      telemetryAbsent: true,
    },
  }
  await atomicWriteJson(resolve(config.reportPath), report)
}

async function probeSandbox(ctx: Context): Promise<{
  readonly mode: 'read-only'
  readonly workspaceRoot: string
  readonly enforcement: 'full' | 'partial'
  readonly denied: true
  readonly outcome: 'denied' | 'fail-closed'
}> {
  const sandbox = requiredService<SandboxProviderLike>(ctx, 'sandbox')
  const policyService = requiredService<SandboxPolicyLike>(ctx, 'sandboxPolicy')
  const policy = policyService.resolve({ mode: 'read-only' })
  const workspaceRoot = resolve(policy.workspaceRoot)
  if (workspaceRoot !== resolve(policyService.workspaceRoot)) {
    throw new Error('georesearch-phase1-probe: agentless sandbox root is inconsistent')
  }
  const marker = join(workspaceRoot, '.georesearch-phase1-denied-write')
  await rm(marker, { force: true })
  const script = "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[1], 'sandbox escaped')"
  const confined = sandbox.confine(
    [process.execPath, '--input-type=module', '--eval', script, marker],
    policy,
  )
  let result
  try {
    result = await spawnCaptured(confined.argv, workspaceRoot)
  } finally {
    try {
      await rm(marker)
      throw new Error('georesearch-phase1-probe: read-only sandbox allowed a write')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  const denied = isSandboxWriteDenied(
    result.code,
    result.stderr,
    marker,
    confined.denialSignatures,
  )
  const runnerFailed = matchesRunnerFailure(result.code, result.stderr, confined.runnerFailureRules)
  const testFailClosed = process.env.NODE_ENV === 'test'
    && process.env.GEORESEARCH_TEST_ALLOW_SANDBOX_FAIL_CLOSED === '1'
    && runnerFailed
  if (!denied && !testFailClosed) {
    throw new Error(
      `georesearch-phase1-probe: sandbox did not produce a recognized denial (exit ${result.code}): ${result.stderr.trim()}`,
    )
  }
  return {
    mode: 'read-only',
    workspaceRoot,
    enforcement: confined.enforcement,
    denied: true,
    outcome: denied ? 'denied' : 'fail-closed',
  }
}

export function isSandboxWriteDenied(
  code: number,
  stderr: string,
  marker: string,
  denialSignatures: readonly string[],
): boolean {
  if (code === 0) return false
  const normalized = normalizeWindowsPath(stderr)
  const declaredDenial = denialSignatures.some(signature =>
    signature.length > 0 && normalized.includes(normalizeWindowsPath(signature)))
  const nativeWriteDenial = /\b(?:eacces|eperm)\b/u.test(normalized)
    && normalized.includes(normalizeWindowsPath(marker))
  return declaredDenial || nativeWriteDenial
}

function normalizeWindowsPath(value: string): string {
  return value.toLowerCase().replaceAll('/', '\\')
}

function matchesRunnerFailure(
  code: number,
  stderr: string,
  rules: readonly {
    readonly allowedExitCodes?: readonly number[]
    readonly fatalSignatures: readonly string[]
    readonly informationalLines?: readonly string[]
  }[],
): boolean {
  if (code === 0) return false
  const lines = stderr.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  return rules.some(rule => {
    if (rule.allowedExitCodes !== undefined && !rule.allowedExitCodes.includes(code)) return false
    const informational = new Set(
      (rule.informationalLines ?? []).map(line => line.toLowerCase()),
    )
    const relevant = lines.filter(line => !informational.has(line.toLowerCase()))
    return relevant.some(line => rule.fatalSignatures.some(signature =>
      line.toLowerCase().includes(signature.toLowerCase())))
  })
}

async function spawnCaptured(
  argv: readonly string[],
  cwd: string,
): Promise<{ readonly code: number; readonly stderr: string }> {
  const command = argv[0]
  if (command === undefined) throw new Error('georesearch-phase1-probe: sandbox returned empty argv')
  return await new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, argv.slice(1), {
      cwd,
      env: process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', chunk => { stderr = boundedAppend(stderr, String(chunk)) })
    child.once('error', rejectRun)
    child.once('close', code => resolveRun({ code: code ?? 1, stderr }))
  })
}

function requiredService<T>(ctx: Context, service: string): T {
  const value = ctx.get(service, false)
  if (value === undefined) throw new Error(`georesearch-phase1-probe: ctx.${service} is unavailable`)
  return value as T
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

function boundedAppend(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-64 * 1024)
}
