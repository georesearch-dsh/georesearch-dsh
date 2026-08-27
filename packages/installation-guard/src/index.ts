import { rename } from 'node:fs/promises'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@georesearch/dsh-compat-rc5'
import {
  GeoResearchError,
  digestFile,
  nowUtc,
  parseGenerationMarker,
  parseInstallationManifest,
  parseMaintenanceNonceRecord,
  sha256Bytes,
  type ActiveInstallationRecord,
} from '@georesearch/dsh-contracts'
import {
  MAINTENANCE_PROTECTED_NONCE_ENV,
  unprotectMaintenanceNonce,
} from './nonce-protection.js'
import { openOperatorScopeRecord, type OperatorScope } from './operator-scope.js'
import {
  installationPaths,
  readJson,
  validateInstallation,
  type InstallationValidation,
} from './validation.js'

export * from './validation.js'
export * from './nonce-protection.js'
export * from './operator-scope.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    geoResearchInstallation: GeoResearchInstallation
  }
}

export const name = 'georesearch-installation-guard'

export interface Config {
  readonly home?: string
  readonly pollIntervalMs?: number
}

export class GeoResearchInstallation extends Service {
  private revokedReason: GeoResearchError | undefined

  constructor(
    ctx: Context,
    readonly validation: InstallationValidation,
    readonly maintenanceTransactionId?: string,
    private readonly operatorScope?: OperatorScope,
  ) {
    super(ctx, 'geoResearchInstallation')
  }

  get active(): ActiveInstallationRecord {
    return this.validation.active
  }

  get operatorScopeId(): string {
    return this.requireOperatorScope().operatorScopeId
  }

  credentialFingerprint(secret: string) {
    return this.requireOperatorScope().credentialFingerprint(secret)
  }

  sealPrivateState(value: import('@georesearch/dsh-contracts').JsonValue, binding: import('@georesearch/dsh-contracts').JsonValue): string {
    return this.requireOperatorScope().sealPrivateState(value, binding)
  }

  openPrivateState(envelope: string, binding: import('@georesearch/dsh-contracts').JsonValue) {
    return this.requireOperatorScope().openPrivateState(envelope, binding)
  }

  assertCurrent(): void {
    if (this.revokedReason !== undefined) throw this.revokedReason
  }

  revoke(reason: GeoResearchError): void {
    this.revokedReason ??= reason
  }

  private requireOperatorScope(): OperatorScope {
    if (this.operatorScope === undefined) {
      throw new GeoResearchError('OPERATOR_SCOPE_UNAVAILABLE', 'operator scope is unavailable')
    }
    return this.operatorScope
  }
}

export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const home = resolveDshHome(config.home)
  await settleStartupServices()
  assertTelemetryAbsent(ctx)

  const activation = await resolveActivation(home)
  const operatorScope = await openOperatorScopeRecord(
    home,
    activation.validation.active.installationId,
    await readJson(activation.validation.paths.operatorScopePath),
  )
  const service = new GeoResearchInstallation(ctx, activation.validation, activation.transactionId, operatorScope)
  const pollIntervalMs = config.pollIntervalMs ?? 1500
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 250) {
    throw new TypeError('georesearch-installation-guard: pollIntervalMs must be an integer >= 250')
  }

  let checking = false
  const timer = setInterval(() => {
    if (checking) return
    checking = true
    void revalidate(ctx, service).finally(() => { checking = false })
  }, pollIntervalMs)
  timer.unref()
  ctx.effect(() => () => clearInterval(timer), 'geoResearchInstallation.monitor()')
}

async function revalidate(ctx: Context, service: GeoResearchInstallation): Promise<void> {
  try {
    assertTelemetryAbsent(ctx)
    await validateInstallation(service.validation.paths.home, {
      ...(service.maintenanceTransactionId === undefined ? {} : {
        activeOverride: service.active,
        allowedTransactionId: service.maintenanceTransactionId,
      }),
    })
  } catch (error) {
    const reason = error instanceof GeoResearchError
      ? error
      : new GeoResearchError('GEORESEARCH_INSTALLATION_REVOKED', String(error), { cause: error })
    service.revoke(reason)
    ctx.logger.error(`GeoResearch activation revoked: ${reason.code}`)
    await ctx.fiber.dispose()
  }
}

export function assertTelemetryAbsent(ctx: Context): void {
  if (ctx.get('sessionTelemetry', false) !== undefined) {
    throw new GeoResearchError(
      'GEORESEARCH_TELEMETRY_UNSAFE',
      'ctx.sessionTelemetry is present; GeoResearch v1 requires the row to be disabled',
    )
  }
}

async function resolveActivation(home: string): Promise<{
  readonly validation: InstallationValidation
  readonly transactionId?: string
}> {
  try {
    return { validation: await validateInstallation(home) }
  } catch (normalError) {
    const protectedNonce = process.env[MAINTENANCE_PROTECTED_NONCE_ENV]
    const transactionId = process.env.GEORESEARCH_MAINTENANCE_TRANSACTION
    if (protectedNonce === undefined || transactionId === undefined) throw normalError
    const active = await claimMaintenanceActivation(home, transactionId, protectedNonce)
    return {
      validation: await validateInstallation(home, {
        activeOverride: active,
        allowedTransactionId: transactionId,
      }),
      transactionId,
    }
  }
}

async function claimMaintenanceActivation(
  home: string,
  transactionId: string,
  protectedNonce: string,
): Promise<ActiveInstallationRecord> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(transactionId)) {
    throw new GeoResearchError('GEORESEARCH_INSTALLATION_INCOMPLETE', 'maintenance transaction id is invalid')
  }
  const paths = installationPaths(home)
  const transactionRoot = join(paths.transactionsRoot, transactionId)
  const pendingPath = join(transactionRoot, 'maintenance.json')
  const usedPath = join(transactionRoot, 'maintenance.used.json')
  const record = parseMaintenanceNonceRecord(await readJson(pendingPath))
  if (record.transactionId !== transactionId
    || record.executable !== process.execPath
    || new Date(record.deadline).getTime() <= Date.now()) {
    throw new GeoResearchError('GEORESEARCH_INSTALLATION_INCOMPLETE', 'maintenance nonce is invalid or expired')
  }
  let nonce: string
  try {
    nonce = await unprotectMaintenanceNonce(protectedNonce, record.protection, record)
  } catch (error) {
    throw new GeoResearchError(
      'GEORESEARCH_INSTALLATION_INCOMPLETE',
      'maintenance nonce protection could not be opened for this user and transaction',
      { cause: error },
    )
  }
  if (record.nonceDigest !== sha256Bytes(Buffer.from(nonce, 'utf8'))) {
    throw new GeoResearchError('GEORESEARCH_INSTALLATION_INCOMPLETE', 'maintenance nonce digest does not match')
  }

  await rename(pendingPath, usedPath)
  const manifestBytesDigest = await digestFile(paths.manifestPath)
  const manifest = parseInstallationManifest(await readJson(paths.manifestPath))
  const profileMarker = parseGenerationMarker(await readJson(paths.profileMarkerPath))
  const presetMarker = parseGenerationMarker(await readJson(paths.presetMarkerPath))
  if (record.generation !== manifest.generation
    || record.generation !== profileMarker.generation
    || record.generation !== presetMarker.generation) {
    throw new GeoResearchError(
      'GEORESEARCH_INSTALLATION_GENERATION_MISMATCH',
      'maintenance nonce generation does not match the published candidate',
    )
  }
  return {
    schemaVersion: 1,
    installationId: manifest.installationId,
    generation: manifest.generation,
    productVersion: manifest.productVersion,
    state: 'active',
    profileTreeDigest: manifest.profileTreeDigest,
    presetTreeDigest: manifest.presetTreeDigest,
    skillsTreeDigest: manifest.skillsTreeDigest,
    installationManifestDigest: manifestBytesDigest,
    profileDependencyLockDigest: manifest.profileDependencyLockDigest,
    homePatchDigest: manifest.homePatchDigest,
    activatedAt: nowUtc(),
  }
}

async function settleStartupServices(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 100))
}
