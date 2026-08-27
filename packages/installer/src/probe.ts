import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DEFAULT_SCHEMA, Type, load } from 'js-yaml'
import {
  DELEGATION_TOOL_NAMES,
  GEORESEARCH_BUNDLE_PACKAGE,
  PRESET_ID,
  PROFILE_ID,
  REQUIRED_SKILLS,
  WEB_APP_BUNDLE_PACKAGE,
  digestTree,
} from '@georesearch/dsh-contracts'
import { RUNTIME_PACKAGE_NAMES, type LoadedDistribution } from './distribution.js'
import { MAINTENANCE_PROTECTED_NONCE_ENV } from '@georesearch/dsh-installation-guard/nonce-protection'

const JsType = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: value => value ?? '',
})
const COMPOSITION_SCHEMA = DEFAULT_SCHEMA.extend([JsType])

export interface ProbeOptions {
  readonly home: string
  readonly harnessRoot?: string
  readonly outputPath?: string
  readonly profileName?: string
  readonly extraEnv?: Readonly<Record<string, string>>
}

export interface CandidateProfileRoot {
  readonly profileName: string
  readonly profileRoot: string
}

export interface RuntimeProbeOptions extends ProbeOptions {
  readonly reportPath: string
  readonly workspaceRoot: string
  readonly expectedInstallationId: string
  readonly expectedGeneration: number
}

export interface RuntimeProbeReport {
  readonly schemaVersion: 1
  readonly phase: 'phase1-foundation'
  readonly checkedAt: string
  readonly installation: {
    readonly installationId: string
    readonly generation: number
    readonly productVersion: string
  }
  readonly checks: Readonly<Record<string, boolean>>
}

export interface Phase2RuntimeProbeReport {
  readonly schemaVersion: 1
  readonly phase: 'phase2-project-run-foundation'
  readonly checkedAt: string
  readonly installation: {
    readonly installationId: string
    readonly generation: number
    readonly productVersion: string
  }
  readonly checks: Readonly<Record<string, boolean>>
}

export interface Phase25RuntimeProbeReport {
  readonly schemaVersion: 1
  readonly phase: 'phase2.5-universal-attachments'
  readonly checkedAt: string
  readonly installation: {
    readonly installationId: string
    readonly generation: number
    readonly productVersion: string
  }
  readonly checks: Readonly<Record<string, boolean>>
}

export interface Phase3RuntimeProbeReport {
  readonly schemaVersion: 1
  readonly phase: 'phase3-literature-evidence'
  readonly checkedAt: string
  readonly installation: {
    readonly installationId: string
    readonly generation: number
    readonly productVersion: string
  }
  readonly checks: Readonly<Record<string, boolean>>
}

export interface Phase4RuntimeProbeReport {
  readonly schemaVersion: 1
  readonly phase: 'phase4-repository-reproduction'
  readonly checkedAt: string
  readonly installation: {
    readonly installationId: string
    readonly generation: number
    readonly productVersion: string
  }
  readonly checks: Readonly<Record<string, boolean>>
}

export interface Phase5RuntimeProbeReport {
  readonly schemaVersion: 1
  readonly phase: 'phase5-geospatial-experiment'
  readonly checkedAt: string
  readonly installation: {
    readonly installationId: string
    readonly generation: number
    readonly productVersion: string
  }
  readonly checks: Readonly<Record<string, boolean>>
}

export interface Phase6RuntimeProbeReport {
  readonly schemaVersion: 1
  readonly phase: 'phase6-validation-claim-writing'
  readonly checkedAt: string
  readonly installation: {
    readonly installationId: string
    readonly generation: number
    readonly productVersion: string
  }
  readonly checks: Readonly<Record<string, boolean>>
}

export async function verifyCandidateShape(
  profileRoot: string,
  sharedPackagesRoot: string,
  presetRoot: string,
  integratedProfiles: readonly CandidateProfileRoot[],
  distribution: LoadedDistribution,
): Promise<void> {
  const manifest = JSON.parse(await readFile(join(profileRoot, 'package.json'), 'utf8')) as Record<string, unknown>
  const dsh = manifest.dsh as { profile?: { bundles?: unknown } } | undefined
  const bundles = dsh?.profile?.bundles
  const expectedBundles = ['@deepseek-ai/dsh-base', WEB_APP_BUNDLE_PACKAGE, GEORESEARCH_BUNDLE_PACKAGE]
  if (!Array.isArray(bundles) || JSON.stringify(bundles) !== JSON.stringify(expectedBundles)) {
    throw new Error(`profile bundle order must be ${expectedBundles.join(' -> ')}`)
  }
  const dependencies = manifest.dependencies as Record<string, unknown> | undefined
  for (const packageName of RUNTIME_PACKAGE_NAMES) {
    if (dependencies?.[packageName] !== distribution.manifest.productVersion) {
      throw new Error(`profile dependency is missing or unpinned: ${packageName}`)
    }
  }
  for (const packageName of RUNTIME_PACKAGE_NAMES) {
    const installed = join(sharedPackagesRoot, packageName.split('/')[1] as string)
    const expected = distribution.manifest.packages.find(entry => entry.name === packageName)?.treeDigest
    if (expected === undefined || (await digestTree(installed)).digest !== expected) {
      throw new Error(`shared package tree does not match the distribution: ${packageName}`)
    }
  }
  for (const integrated of integratedProfiles) {
    const integratedManifest = JSON.parse(
      await readFile(join(integrated.profileRoot, 'package.json'), 'utf8'),
    ) as Record<string, unknown>
    const integratedDependencies = integratedManifest.dependencies as Record<string, unknown> | undefined
    for (const packageName of RUNTIME_PACKAGE_NAMES) {
      if (integratedDependencies?.[packageName] !== distribution.manifest.productVersion) {
        throw new Error(`integrated Profile dependency is missing: ${integrated.profileName}/${packageName}`)
      }
    }
    const integratedDsh = integratedManifest.dsh as { profile?: { bundles?: unknown } } | undefined
    const integratedBundles = integratedDsh?.profile?.bundles
    if (!Array.isArray(integratedBundles)) {
      throw new Error(`integrated Profile bundle list is missing: ${integrated.profileName}`)
    }
    const webIndex = integratedBundles.indexOf(WEB_APP_BUNDLE_PACKAGE)
    const georesearchIndexes = integratedBundles
      .map((name, index) => name === GEORESEARCH_BUNDLE_PACKAGE ? index : -1)
      .filter(index => index >= 0)
    if (webIndex < 0 || georesearchIndexes.length !== 1 || georesearchIndexes[0]! <= webIndex) {
      throw new Error(`integrated Profile bundle order is invalid: ${integrated.profileName}`)
    }
  }

  const bundleRoot = distribution.packageDirectories.get('@georesearch/dsh-bundle')
  if (bundleRoot === undefined) throw new Error('bundle package directory is unavailable')
  const bundleRows = compositionRows(await readFile(join(bundleRoot, 'cordis.patch.yml'), 'utf8'))
  const georesearchRows = bundleRows.filter(row => typeof row.id === 'string' && row.id.startsWith('georesearch-'))
  if (georesearchRows[0]?.id !== 'georesearch-installation-guard') {
    throw new Error('the installation guard must be the first GeoResearch bundle row')
  }
  const runtimeLeaseRow = bundleRows.find(row => row.id === 'georesearch-runtime-lease')
  if (runtimeLeaseRow?.name !== '@georesearch/dsh-runtime-lease') {
    throw new Error('the host bundle must acquire the GeoResearch runtime lease')
  }
  const delegationRow = bundleRows.find(row => row.id === 'georesearch-delegation-tools')
  if (delegationRow?.name !== '@georesearch/dsh-delegation-tools') {
    throw new Error('the host bundle must register the delegation tools globally')
  }
  const policyRow = bundleRows.find(row => row.id === 'georesearch-policy')
  const policyConfig = policyRow?.config as Record<string, unknown> | undefined
  if (policyConfig?.strictCatalog !== true || policyConfig.capabilityStage !== 'phase6') {
    throw new Error('the policy row must enforce the strict Phase 6 capability stage')
  }
  const delegationConfig = delegationRow.config as Record<string, unknown> | undefined
  if (delegationConfig?.strictRoleCapabilities !== true || delegationConfig.capabilityStage !== 'phase6') {
    throw new Error('the delegation row must enforce the strict Phase 6 capability stage')
  }
  const projectRow = bundleRows.find(row => row.id === 'georesearch-project-service')
  const fileRow = bundleRows.find(row => row.id === 'georesearch-file-service')
  const evidenceRow = bundleRows.find(row => row.id === 'georesearch-evidence-service')
  const runRow = bundleRows.find(row => row.id === 'georesearch-run-service')
  const reproductionRow = bundleRows.find(row => row.id === 'georesearch-reproduction-service')
  const geospatialRow = bundleRows.find(row => row.id === 'georesearch-geospatial-service')
  const experimentRow = bundleRows.find(row => row.id === 'georesearch-experiment-service')
  const validationRow = bundleRows.find(row => row.id === 'georesearch-validation-service')
  const claimRow = bundleRows.find(row => row.id === 'georesearch-claim-service')
  const writingRow = bundleRows.find(row => row.id === 'georesearch-writing-service')
  if (projectRow?.name !== '@georesearch/dsh-project-service'
    || fileRow?.name !== '@georesearch/dsh-file-service'
    || evidenceRow?.name !== '@georesearch/dsh-evidence-service'
    || runRow?.name !== '@georesearch/dsh-run-service'
    || reproductionRow?.name !== '@georesearch/dsh-reproduction-service'
    || geospatialRow?.name !== '@georesearch/dsh-geospatial-service'
    || experimentRow?.name !== '@georesearch/dsh-experiment-service'
    || validationRow?.name !== '@georesearch/dsh-validation-service'
    || claimRow?.name !== '@georesearch/dsh-claim-service'
    || writingRow?.name !== '@georesearch/dsh-writing-service'
    || bundleRows.indexOf(fileRow) <= bundleRows.indexOf(projectRow)
    || bundleRows.indexOf(evidenceRow) <= bundleRows.indexOf(fileRow)
    || bundleRows.indexOf(runRow) <= bundleRows.indexOf(evidenceRow)
    || bundleRows.indexOf(reproductionRow) <= bundleRows.indexOf(runRow)
    || bundleRows.indexOf(geospatialRow) <= bundleRows.indexOf(reproductionRow)
    || bundleRows.indexOf(experimentRow) <= bundleRows.indexOf(geospatialRow)
    || bundleRows.indexOf(validationRow) <= bundleRows.indexOf(experimentRow)
    || bundleRows.indexOf(claimRow) <= bundleRows.indexOf(validationRow)
    || bundleRows.indexOf(writingRow) <= bundleRows.indexOf(claimRow)
    || bundleRows.indexOf(delegationRow) <= bundleRows.indexOf(writingRow)) {
    throw new Error('the Project through Writing authority services are ordered incorrectly')
  }
  const runtimeProbeRow = bundleRows.find(row => row.id === 'georesearch-phase1-probe')
  if (runtimeProbeRow?.name !== '@georesearch/dsh-bundle/phase1-probe'
    || typeof runtimeProbeRow.disabled !== 'string'
    || !runtimeProbeRow.disabled.includes('GEORESEARCH_PHASE1_PROBE_REPORT')) {
    throw new Error('the Phase 1 runtime probe must be present and normally disabled')
  }
  const phase2ProbeRow = bundleRows.find(row => row.id === 'georesearch-phase2-probe')
  if (phase2ProbeRow?.name !== '@georesearch/dsh-bundle/phase2-probe'
    || typeof phase2ProbeRow.disabled !== 'string'
    || !phase2ProbeRow.disabled.includes('GEORESEARCH_PHASE2_PROBE_REPORT')) {
    throw new Error('the Phase 2 runtime probe must be present and normally disabled')
  }
  const phase25ProbeRow = bundleRows.find(row => row.id === 'georesearch-phase25-probe')
  if (phase25ProbeRow?.name !== '@georesearch/dsh-bundle/phase25-probe'
    || typeof phase25ProbeRow.disabled !== 'string'
    || !phase25ProbeRow.disabled.includes('GEORESEARCH_PHASE25_PROBE_REPORT')) {
    throw new Error('the Phase 2.5 runtime probe must be present and normally disabled')
  }
  const phase3ProbeRow = bundleRows.find(row => row.id === 'georesearch-phase3-probe')
  if (phase3ProbeRow?.name !== '@georesearch/dsh-bundle/phase3-probe'
    || typeof phase3ProbeRow.disabled !== 'string'
    || !phase3ProbeRow.disabled.includes('GEORESEARCH_PHASE3_PROBE_REPORT')) {
    throw new Error('the Phase 3 runtime probe must be present and normally disabled')
  }
  const phase4ProbeRow = bundleRows.find(row => row.id === 'georesearch-phase4-probe')
  if (phase4ProbeRow?.name !== '@georesearch/dsh-bundle/phase4-probe'
    || typeof phase4ProbeRow.disabled !== 'string'
    || !phase4ProbeRow.disabled.includes('GEORESEARCH_PHASE4_PROBE_REPORT')) {
    throw new Error('the Phase 4 runtime probe must be present and normally disabled')
  }
  const phase5ProbeRow = bundleRows.find(row => row.id === 'georesearch-phase5-probe')
  if (phase5ProbeRow?.name !== '@georesearch/dsh-bundle/phase5-probe'
    || typeof phase5ProbeRow.disabled !== 'string'
    || !phase5ProbeRow.disabled.includes('GEORESEARCH_PHASE5_PROBE_REPORT')) {
    throw new Error('the Phase 5 runtime probe must be present and normally disabled')
  }
  const phase6ProbeRow = bundleRows.find(row => row.id === 'georesearch-phase6-probe')
  if (phase6ProbeRow?.name !== '@georesearch/dsh-bundle/phase6-probe'
    || typeof phase6ProbeRow.disabled !== 'string'
    || !phase6ProbeRow.disabled.includes('GEORESEARCH_PHASE6_PROBE_REPORT')) {
    throw new Error('the Phase 6 runtime probe must be present and normally disabled')
  }
  const fileServiceRoot = distribution.packageDirectories.get('@georesearch/dsh-file-service')
  if (fileServiceRoot === undefined) throw new Error('file service package directory is unavailable')
  await readFile(join(fileServiceRoot, 'lib', 'client.js'))
  const fileServiceHost = await readFile(join(fileServiceRoot, 'lib', 'index.js'), 'utf8')
  if (/from\s+['"](?:tar-stream|yauzl)['"]/u.test(fileServiceHost)) {
    throw new Error('file-service Host bundle retained an external archive parser import')
  }
  const fileServicePdf = await readFile(join(fileServiceRoot, 'lib', 'pdf.js'), 'utf8')
  if (/from\s+['"](?:@napi-rs\/canvas|pdfjs-dist(?:\/[^'"]*)?)['"]/u.test(fileServicePdf)) {
    throw new Error('file-service PDF bundle retained an external parser import')
  }
  const presetRosterRow = bundleRows.find(row => row.id === 'agent-presets')
  const presetRosterConfig = presetRosterRow?.config as Record<string, unknown> | undefined
  if (presetRosterConfig?.default !== PRESET_ID) {
    throw new Error(`the GeoResearch profile must default to preset ${PRESET_ID}`)
  }
  for (const required of ['tool-fs', 'tool-fs-search', 'tool-skill', 'tool-ask-user', 'tool-web']) {
    const row = bundleRows.find(candidate => candidate.id === required)
    if (row === undefined || row.disabled !== false) {
      throw new Error(`the host bundle must enable globally filterable row ${required}`)
    }
  }
  const skillRow = bundleRows.find(row => row.id === 'tool-skill')
  const skillConfig = skillRow?.config as Record<string, unknown> | undefined
  if (skillConfig?.catalogDescriptionMaxLength !== 128) {
    throw new Error('the global skill catalog must use the bounded cache-aware description length')
  }
  const askUserRow = bundleRows.find(row => row.id === 'tool-ask-user')
  if (askUserRow?.name !== '@deepseek-ai/dsh-tool-ask-user') {
    throw new Error('the host bundle must register the globally filterable ask-user tool')
  }
  const webRow = bundleRows.find(row => row.id === 'tool-web')
  const webConfig = webRow?.config as Record<string, unknown> | undefined
  if (webConfig?.fetch !== false) {
    throw new Error('the host bundle must not expose web_fetch without a safe provider')
  }
  const telemetry = bundleRows.find(row => row.id === 'session-telemetry-otel')
  if (telemetry?.disabled !== true) throw new Error('session-telemetry-otel must be disabled by the bundle patch')

  const presetMetadata = load(await readFile(join(presetRoot, 'preset.yml'), 'utf8'), { schema: COMPOSITION_SCHEMA }) as Record<string, unknown>
  if (presetMetadata.name !== 'GeoResearch') throw new Error('preset display name must be GeoResearch')
  const presetRows = compositionRows(await readFile(join(presetRoot, 'agent.cordis.yml'), 'utf8'))
  if (presetRows[0]?.id !== 'georesearch-profile-guard'
    || presetRows[0]?.name !== './profile-guard.mjs') {
    throw new Error('the profile guard must be the first GeoResearch preset row')
  }
  await readFile(join(presetRoot, 'profile-guard.mjs'), 'utf8')
  const ids = new Set(presetRows.map(row => row.id))
  for (const required of ['skill-filesystem', 'georesearch-prompt']) {
    if (!ids.has(required)) throw new Error(`preset is missing row ${required}`)
  }
  if (ids.has('tool-skill')) {
    throw new Error('tool-skill must be global so it cannot erase a scoped skill catalog')
  }
  const promptRow = presetRows.find(row => row.id === 'georesearch-prompt')
  if (typeof promptRow?.disabled !== 'string'
    || !promptRow.disabled.includes("ctx.get('geoResearchInstallation', false)")) {
    throw new Error('the GeoResearch prompt import must be disabled outside an integrated host')
  }
  if (ids.has('georesearch-delegation-tools')) {
    throw new Error('delegation tools must not be scope-local preset registrations')
  }
  for (const forbidden of ['tool-fs', 'tool-fs-search', 'tool-ask-user', 'tool-web']) {
    if (ids.has(forbidden)) throw new Error(`role-filtered tool ${forbidden} must not be registered in preset scope`)
  }
  for (const skill of REQUIRED_SKILLS) {
    await readFile(join(presetRoot, 'skills', skill, 'SKILL.md'), 'utf8')
  }
  for (const schema of [
    'research-brief.schema.json',
    'project-snapshot.schema.json',
    'run-record.schema.json',
    'literature-search-request.schema.json',
    'literature-search-result.schema.json',
    'literature-continuation.schema.json',
    'continuation-advance-outcome.schema.json',
    'paper-read-result.schema.json',
    'source-record.schema.json',
    'evidence-candidate.schema.json',
    'evidence-record.schema.json',
    'repository-audit.schema.json',
    'reproduction-plan.schema.json',
    'reproduction-test-spec.schema.json',
    'reproduction-report-candidate.schema.json',
    'reproduction-report.schema.json',
    'geodata-inspection-report.schema.json',
    'dataset-manifest.schema.json',
    'experiment-spec-candidate.schema.json',
    'experiment-spec.schema.json',
    'experiment-amendment.schema.json',
    'result-envelope.schema.json',
    'result-record.schema.json',
    'validation-plan.schema.json',
    'validation-report.schema.json',
    'review-proposal.schema.json',
    'review-record.schema.json',
    'claim-proposal.schema.json',
    'claim-record.schema.json',
    'writing-packet.schema.json',
    'manuscript-candidate.schema.json',
    'manuscript-record.schema.json',
    'manuscript-audit.schema.json',
  ]) {
    await readFile(join(bundleRoot, 'schemas', schema), 'utf8')
  }
  if (DELEGATION_TOOL_NAMES.length !== 4 || PRESET_ID !== PROFILE_ID) {
    throw new Error('compiled GeoResearch identity constants are inconsistent')
  }
}

export async function runHarnessDump(options: ProbeOptions): Promise<string | undefined> {
  if (options.harnessRoot === undefined) return undefined
  const cliPath = join(options.harnessRoot, 'apps', 'cli', 'lib', 'bin.js')
  await readFile(cliPath)
  const result = await spawnCaptured(
    process.execPath,
    [cliPath, '--profile', options.profileName ?? PROFILE_ID, '--dump-config'],
    options.harnessRoot,
    {
      ...process.env,
      DSH_HOME: options.home,
      DSH_TELEMETRY_DISABLED: '1',
      ...options.extraEnv,
    },
  )
  if (result.code !== 0) {
    throw new Error(`Harness --dump-config failed (${result.code}): ${result.stderr.trim()}`)
  }
  const bundlePatchWarning = result.stderr
    .split(/\r?\n/u)
    .find(line => line.includes('dsh: [@georesearch/dsh-bundle] patch:'))
  if (bundlePatchWarning !== undefined) {
    throw new Error(`Harness --dump-config reported a GeoResearch bundle patch warning: ${bundlePatchWarning.trim()}`)
  }
  if (options.outputPath !== undefined) await writeFile(options.outputPath, result.stdout, 'utf8')
  const rows = compositionRows(result.stdout)
  if (!rows.some(row => row.id === 'georesearch-installation-guard')) {
    throw new Error('composed config does not contain the GeoResearch installation guard')
  }
  const telemetry = rows.find(row => row.id === 'session-telemetry-otel')
  if (telemetry !== undefined && telemetry.disabled !== true) {
    throw new Error('composed config re-enabled session-telemetry-otel')
  }
  return result.stdout
}

export async function runPresetImportProbe(profileRoot: string): Promise<void> {
  const result = await spawnCaptured(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      "await import('@georesearch/dsh-prompt'); await import('@georesearch/dsh-file-service'); await import('@georesearch/dsh-evidence-providers'); await import('@georesearch/dsh-evidence-service'); await import('@georesearch/dsh-repository-providers'); await import('@georesearch/dsh-reproduction-service'); await import('@georesearch/dsh-geospatial-provider-python'); await import('@georesearch/dsh-geospatial-service'); await import('@georesearch/dsh-experiment-service'); await import('@georesearch/dsh-validation-service'); await import('@georesearch/dsh-claim-service'); await import('@georesearch/dsh-writing-service'); await import('@georesearch/dsh-bundle'); await import('@georesearch/dsh-bundle/phase3-probe'); await import('@georesearch/dsh-bundle/phase4-probe'); await import('@georesearch/dsh-bundle/phase5-probe'); await import('@georesearch/dsh-bundle/phase6-probe')",
    ],
    profileRoot,
    process.env,
  )
  if (result.code !== 0) {
    throw new Error(`GeoResearch preset imports failed from ${profileRoot}: ${result.stderr.trim()}`)
  }
}

export async function runMaintenanceGuardProbe(
  probeModulePath: string,
  home: string,
  transactionId: string,
  protectedNonce: string,
): Promise<void> {
  const result = await spawnCaptured(
    process.execPath,
    [probeModulePath, '--home', home],
    process.cwd(),
    {
      ...process.env,
      [MAINTENANCE_PROTECTED_NONCE_ENV]: protectedNonce,
      GEORESEARCH_MAINTENANCE_TRANSACTION: transactionId,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: '1',
    },
  )
  if (result.code !== 0) throw new Error(`activation guard maintenance probe failed: ${result.stderr.trim()}`)
}

export async function runHarnessRuntimeProbe(options: RuntimeProbeOptions): Promise<RuntimeProbeReport> {
  if (options.harnessRoot === undefined) throw new TypeError('runtime probe requires a Harness root')
  const cliPath = join(options.harnessRoot, 'apps', 'cli', 'lib', 'bin.js')
  await readFile(cliPath)
  await mkdir(options.workspaceRoot, { recursive: true })
  const phase2ReportPath = join(dirname(options.reportPath), 'phase2-runtime-probe.json')
  const phase25ReportPath = join(dirname(options.reportPath), 'phase2.5-runtime-probe.json')
  const phase3ReportPath = join(dirname(options.reportPath), 'phase3-runtime-probe.json')
  const phase4ReportPath = join(dirname(options.reportPath), 'phase4-runtime-probe.json')
  const phase5ReportPath = join(dirname(options.reportPath), 'phase5-runtime-probe.json')
  const phase6ReportPath = join(dirname(options.reportPath), 'phase6-runtime-probe.json')
  await rm(options.reportPath, { force: true })
  await rm(phase2ReportPath, { force: true })
  await rm(phase25ReportPath, { force: true })
  await rm(phase3ReportPath, { force: true })
  await rm(phase4ReportPath, { force: true })
  await rm(phase5ReportPath, { force: true })
  await rm(phase6ReportPath, { force: true })
  const child = spawn(
    process.execPath,
    [cliPath, '--profile', options.profileName ?? PROFILE_ID, '--port', '0'],
    {
      cwd: options.workspaceRoot,
      env: {
        ...process.env,
        DSH_HOME: options.home,
        DSH_TELEMETRY_DISABLED: '1',
        DSH_PERMISSION_MODE: 'workspace-write',
        GEORESEARCH_PHASE1_PROBE_REPORT: options.reportPath,
        GEORESEARCH_PHASE2_PROBE_REPORT: phase2ReportPath,
        GEORESEARCH_PHASE25_PROBE_REPORT: phase25ReportPath,
        GEORESEARCH_PHASE3_PROBE_REPORT: phase3ReportPath,
        GEORESEARCH_PHASE4_PROBE_REPORT: phase4ReportPath,
        GEORESEARCH_PHASE5_PROBE_REPORT: phase5ReportPath,
        GEORESEARCH_PHASE6_PROBE_REPORT: phase6ReportPath,
        ...options.extraEnv,
      },
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  child.stdin.end()
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout = boundedAppend(stdout, String(chunk)) })
  child.stderr.on('data', chunk => { stderr = boundedAppend(stderr, String(chunk)) })
  try {
    await waitForRuntimeProbe(
      child,
      [options.reportPath, phase2ReportPath, phase25ReportPath, phase3ReportPath, phase4ReportPath, phase5ReportPath, phase6ReportPath],
      () => stdout,
      () => stderr,
    )
    const report = parseRuntimeProbeReport(
      JSON.parse(await readFile(options.reportPath, 'utf8')) as unknown,
      options,
    )
    parsePhase2RuntimeProbeReport(
      JSON.parse(await readFile(phase2ReportPath, 'utf8')) as unknown,
      options,
    )
    parsePhase25RuntimeProbeReport(
      JSON.parse(await readFile(phase25ReportPath, 'utf8')) as unknown,
      options,
    )
    parsePhase3RuntimeProbeReport(
      JSON.parse(await readFile(phase3ReportPath, 'utf8')) as unknown,
      options,
    )
    parsePhase4RuntimeProbeReport(
      JSON.parse(await readFile(phase4ReportPath, 'utf8')) as unknown,
      options,
    )
    parsePhase5RuntimeProbeReport(
      JSON.parse(await readFile(phase5ReportPath, 'utf8')) as unknown,
      options,
    )
    parsePhase6RuntimeProbeReport(
      JSON.parse(await readFile(phase6ReportPath, 'utf8')) as unknown,
      options,
    )
    return report
  } finally {
    try {
      await terminateChild(child)
    } finally {
      await rm(options.workspaceRoot, { recursive: true, force: true })
    }
  }
}

function compositionRows(source: string): Array<Record<string, unknown>> {
  const parsed = load(source, { schema: COMPOSITION_SCHEMA }) as unknown
  if (!Array.isArray(parsed)) throw new TypeError('Cordis composition must be a top-level array')
  const rows: Array<Record<string, unknown>> = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const record = value as Record<string, unknown>
    if (typeof record.id === 'string') rows.push(record)
    if (Array.isArray(record.insert)) visit(record.insert)
    if (Array.isArray(record.config)) visit(record.config)
  }
  visit(parsed)
  return rows
}

async function spawnCaptured(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.once('error', reject)
    child.once('close', code => resolve({ code: code ?? 1, stdout, stderr }))
  })
}

async function waitForRuntimeProbe(
  child: ChildProcessWithoutNullStreams,
  reportPaths: readonly string[],
  stdout: () => string,
  stderr: () => string,
): Promise<void> {
  await new Promise<void>((resolveReady, rejectReady) => {
    let checking = false
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearInterval(interval)
      clearTimeout(timeout)
      child.off('error', onError)
      child.off('close', onClose)
      error === undefined ? resolveReady() : rejectReady(error)
    }
    const check = async (): Promise<void> => {
      if (checking || settled || !stdout().includes('dsh web: http://')) return
      checking = true
      try {
        await Promise.all(reportPaths.map(path => readFile(path)))
        finish()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') finish(error as Error)
      } finally {
        checking = false
      }
    }
    const onError = (error: Error): void => finish(error)
    const onClose = (code: number | null): void => finish(new Error(
      `Harness runtime probe exited before readiness (${String(code)}): ${stderr().trim()}`,
    ))
    const interval = setInterval(() => { void check() }, 100)
    const timeout = setTimeout(() => finish(new Error(
      `Harness runtime probe timed out: ${stderr().trim() || stdout().trim()}`,
    )), 60_000)
    interval.unref()
    timeout.unref()
    child.once('error', onError)
    child.once('close', onClose)
    void check()
  })
}

function parsePhase2RuntimeProbeReport(value: unknown, options: RuntimeProbeOptions): Phase2RuntimeProbeReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Phase 2 runtime probe report must be an object')
  }
  const report = value as Record<string, unknown>
  const installation = report.installation as Record<string, unknown> | undefined
  const checks = report.checks as Record<string, unknown> | undefined
  if (report.schemaVersion !== 1 || report.phase !== 'phase2-project-run-foundation'
    || typeof report.checkedAt !== 'string'
    || installation?.installationId !== options.expectedInstallationId
    || installation.generation !== options.expectedGeneration
    || checks === undefined
    || Object.keys(checks).length < 9
    || Object.values(checks).some(result => result !== true)) {
    throw new Error('Phase 2 runtime probe report failed validation')
  }
  return report as unknown as Phase2RuntimeProbeReport
}

function parsePhase25RuntimeProbeReport(value: unknown, options: RuntimeProbeOptions): Phase25RuntimeProbeReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Phase 2.5 runtime probe report must be an object')
  }
  const report = value as Record<string, unknown>
  const installation = report.installation as Record<string, unknown> | undefined
  const checks = report.checks as Record<string, unknown> | undefined
  if (report.schemaVersion !== 1 || report.phase !== 'phase2.5-universal-attachments'
    || typeof report.checkedAt !== 'string'
    || installation?.installationId !== options.expectedInstallationId
    || installation.generation !== options.expectedGeneration
    || checks === undefined
    || Object.keys(checks).length < 9
    || Object.values(checks).some(result => result !== true)) {
    throw new Error('Phase 2.5 runtime probe report failed validation')
  }
  return report as unknown as Phase25RuntimeProbeReport
}

function parsePhase3RuntimeProbeReport(value: unknown, options: RuntimeProbeOptions): Phase3RuntimeProbeReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Phase 3 runtime probe report must be an object')
  }
  const report = value as Record<string, unknown>
  const installation = report.installation as Record<string, unknown> | undefined
  const checks = report.checks as Record<string, unknown> | undefined
  if (report.schemaVersion !== 1 || report.phase !== 'phase3-literature-evidence'
    || typeof report.checkedAt !== 'string'
    || installation?.installationId !== options.expectedInstallationId
    || installation.generation !== options.expectedGeneration
    || checks === undefined
    || Object.keys(checks).length < 13
    || Object.values(checks).some(result => result !== true)) {
    throw new Error('Phase 3 runtime probe report failed validation')
  }
  return report as unknown as Phase3RuntimeProbeReport
}

function parsePhase4RuntimeProbeReport(value: unknown, options: RuntimeProbeOptions): Phase4RuntimeProbeReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Phase 4 runtime probe report must be an object')
  }
  const report = value as Record<string, unknown>
  const installation = report.installation as Record<string, unknown> | undefined
  const checks = report.checks as Record<string, unknown> | undefined
  if (report.schemaVersion !== 1 || report.phase !== 'phase4-repository-reproduction'
    || typeof report.checkedAt !== 'string'
    || installation?.installationId !== options.expectedInstallationId
    || installation.generation !== options.expectedGeneration
    || checks === undefined
    || Object.keys(checks).length < 13
    || Object.values(checks).some(result => result !== true)) {
    throw new Error('Phase 4 runtime probe report failed validation')
  }
  return report as unknown as Phase4RuntimeProbeReport
}

function parsePhase5RuntimeProbeReport(value: unknown, options: RuntimeProbeOptions): Phase5RuntimeProbeReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Phase 5 runtime probe report must be an object')
  }
  const report = value as Record<string, unknown>
  const installation = report.installation as Record<string, unknown> | undefined
  const checks = report.checks as Record<string, unknown> | undefined
  if (report.schemaVersion !== 1 || report.phase !== 'phase5-geospatial-experiment'
    || typeof report.checkedAt !== 'string'
    || installation?.installationId !== options.expectedInstallationId
    || installation.generation !== options.expectedGeneration
    || checks === undefined
    || Object.keys(checks).length < 13
    || Object.values(checks).some(result => result !== true)) {
    throw new Error('Phase 5 runtime probe report failed validation')
  }
  return report as unknown as Phase5RuntimeProbeReport
}

function parsePhase6RuntimeProbeReport(value: unknown, options: RuntimeProbeOptions): Phase6RuntimeProbeReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Phase 6 runtime probe report must be an object')
  }
  const report = value as Record<string, unknown>
  const installation = report.installation as Record<string, unknown> | undefined
  const checks = report.checks as Record<string, unknown> | undefined
  if (report.schemaVersion !== 1 || report.phase !== 'phase6-validation-claim-writing'
    || typeof report.checkedAt !== 'string'
    || installation?.installationId !== options.expectedInstallationId
    || installation.generation !== options.expectedGeneration
    || checks === undefined
    || Object.keys(checks).length < 14
    || Object.values(checks).some(result => result !== true)) {
    throw new Error('Phase 6 runtime probe report failed validation')
  }
  return report as unknown as Phase6RuntimeProbeReport
}

function parseRuntimeProbeReport(value: unknown, options: RuntimeProbeOptions): RuntimeProbeReport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Phase 1 runtime probe report must be an object')
  }
  const report = value as Record<string, unknown>
  const installation = report.installation as Record<string, unknown> | undefined
  const checks = report.checks as Record<string, unknown> | undefined
  const sandbox = report.sandbox as Record<string, unknown> | undefined
  const sandboxOutcomeAccepted = sandbox?.outcome === 'denied'
    || (sandbox?.outcome === 'fail-closed'
      && process.env.NODE_ENV === 'test'
      && process.env.GEORESEARCH_TEST_ALLOW_SANDBOX_FAIL_CLOSED === '1')
  if (report.schemaVersion !== 1 || report.phase !== 'phase1-foundation'
    || typeof report.checkedAt !== 'string'
    || installation?.installationId !== options.expectedInstallationId
    || installation.generation !== options.expectedGeneration
    || checks === undefined
    || !sandboxOutcomeAccepted
    || Object.keys(checks).length < 7
    || Object.values(checks).some(result => result !== true)) {
    throw new Error('Phase 1 runtime probe report failed validation')
  }
  return report as unknown as RuntimeProbeReport
}

async function terminateChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  const exited = await Promise.race([
    new Promise<true>(resolveExit => child.once('close', () => resolveExit(true))),
    new Promise<false>(resolveTimeout => setTimeout(() => resolveTimeout(false), 5000)),
  ])
  if (exited || child.exitCode !== null) return
  child.kill('SIGKILL')
  await new Promise<void>(resolveExit => child.once('close', () => resolveExit()))
}

function boundedAppend(current: string, chunk: string): string {
  return `${current}${chunk}`.slice(-64 * 1024)
}
