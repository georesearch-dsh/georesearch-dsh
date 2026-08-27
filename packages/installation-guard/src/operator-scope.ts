import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto'
import { resolve } from 'node:path'
import {
  GeoResearchError,
  canonicalJson,
  digestJson,
  nowUtc,
  type JsonValue,
  type MaintenanceNonceRecord,
  type Sha256Digest,
} from '@georesearch/dsh-contracts'
import {
  protectBoundData,
  unprotectBoundData,
  type NonceProtectionOptions,
} from './nonce-protection.js'

export const OPERATOR_SCOPE_FILE = 'operator-scope.json'

export interface OperatorScopeRecord {
  readonly schemaVersion: 1
  readonly installationId: string
  readonly homeBindingDigest: Sha256Digest
  readonly protection: MaintenanceNonceRecord['protection']
  readonly protectedPayload: string
  readonly createdAt: string
}

interface OperatorScopePayload {
  readonly schemaVersion: 1
  readonly operatorScopeId: string
  readonly credentialHmacKey: string
  readonly continuationSealKey: string
}

export class OperatorScope {
  readonly operatorScopeId: string
  readonly record: OperatorScopeRecord
  private readonly credentialHmacKey: Buffer
  private readonly continuationSealKey: Buffer

  constructor(record: OperatorScopeRecord, payload: OperatorScopePayload) {
    this.record = record
    this.operatorScopeId = payload.operatorScopeId
    this.credentialHmacKey = decodeKey(payload.credentialHmacKey, 'credential HMAC key')
    this.continuationSealKey = decodeKey(payload.continuationSealKey, 'continuation seal key')
  }

  credentialFingerprint(secret: string): Sha256Digest {
    if (secret.length === 0) throw new TypeError('credential secret must not be empty')
    return `sha256:${createHmac('sha256', this.credentialHmacKey).update(secret, 'utf8').digest('hex')}`
  }

  sealPrivateState(value: JsonValue, binding: JsonValue): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.continuationSealKey, iv)
    cipher.setAAD(Buffer.from(canonicalJson(binding), 'utf8'))
    const ciphertext = Buffer.concat([
      cipher.update(Buffer.from(canonicalJson(value), 'utf8')),
      cipher.final(),
    ])
    return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
  }

  openPrivateState(envelope: string, binding: JsonValue): JsonValue {
    const bytes = decodeBase64Url(envelope, 'private state envelope')
    if (bytes.byteLength <= 29 || bytes[0] !== 1) {
      throw new GeoResearchError('LITERATURE_CONTINUATION_REVOKED', 'private state envelope is invalid')
    }
    const decipher = createDecipheriv('aes-256-gcm', this.continuationSealKey, bytes.subarray(1, 13))
    decipher.setAAD(Buffer.from(canonicalJson(binding), 'utf8'))
    decipher.setAuthTag(bytes.subarray(13, 29))
    let plaintext: Buffer
    try {
      plaintext = Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()])
    } catch (error) {
      throw new GeoResearchError(
        'LITERATURE_CONTINUATION_REVOKED',
        'private continuation state authentication failed',
        { cause: error },
      )
    }
    const parsed = JSON.parse(plaintext.toString('utf8')) as unknown
    canonicalJson(parsed)
    return parsed as JsonValue
  }
}

export async function createOperatorScopeRecord(
  home: string,
  installationId: string,
  options: NonceProtectionOptions = {},
): Promise<OperatorScopeRecord> {
  const payload: OperatorScopePayload = {
    schemaVersion: 1,
    operatorScopeId: randomBytes(32).toString('base64url'),
    credentialHmacKey: randomBytes(32).toString('base64url'),
    continuationSealKey: randomBytes(32).toString('base64url'),
  }
  return protectRecord(home, installationId, payload, nowUtc(), options)
}

export async function openOperatorScopeRecord(
  home: string,
  installationId: string,
  raw: unknown,
  options: NonceProtectionOptions = {},
): Promise<OperatorScope> {
  const record = parseOperatorScopeRecord(raw)
  const expectedHome = homeBindingDigest(home)
  if (record.installationId !== installationId || record.homeBindingDigest !== expectedHome) {
    throw new GeoResearchError(
      'OPERATOR_SCOPE_UNAVAILABLE',
      'operator scope does not belong to this installation and DSH_HOME',
    )
  }
  let plaintext: Buffer
  try {
    plaintext = await unprotectBoundData(
      record.protectedPayload,
      record.protection,
      bindingBytes(record),
      options,
    )
  } catch (error) {
    throw new GeoResearchError(
      'OPERATOR_SCOPE_UNAVAILABLE',
      'operator scope cannot be opened for the current Windows user',
      { cause: error },
    )
  }
  return new OperatorScope(record, parsePayload(JSON.parse(plaintext.toString('utf8')) as unknown))
}

export async function rebindOperatorScopeRecord(
  raw: unknown,
  sourceHome: string,
  targetHome: string,
  installationId: string,
  options: NonceProtectionOptions = {},
): Promise<OperatorScopeRecord> {
  const opened = await openOperatorScopeRecord(sourceHome, installationId, raw, options)
  const payload = await unprotectPayload(opened.record, options)
  return protectRecord(targetHome, installationId, payload, opened.record.createdAt, options)
}

export function parseOperatorScopeRecord(value: unknown): OperatorScopeRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('operator scope record must be an object')
  }
  const record = value as Record<string, unknown>
  const fields = [
    'schemaVersion', 'installationId', 'homeBindingDigest',
    'protection', 'protectedPayload', 'createdAt',
  ]
  const extra = Object.keys(record).filter(key => !fields.includes(key))
  if (extra.length > 0 || record.schemaVersion !== 1
    || typeof record.installationId !== 'string' || record.installationId.length === 0
    || typeof record.homeBindingDigest !== 'string'
    || !/^sha256:[0-9a-f]{64}$/u.test(record.homeBindingDigest)
    || (record.protection !== 'dpapi-current-user' && record.protection !== 'test-aes-256-gcm')
    || typeof record.protectedPayload !== 'string' || record.protectedPayload.length === 0
    || typeof record.createdAt !== 'string' || new Date(record.createdAt).toISOString() !== record.createdAt) {
    throw new TypeError('operator scope record is invalid')
  }
  return record as unknown as OperatorScopeRecord
}

function homeBindingDigest(home: string): Sha256Digest {
  const canonicalHome = resolve(home)
  return digestJson({
    domain: 'georesearch.operator-scope-home/v1',
    home: process.platform === 'win32' ? canonicalHome.toLowerCase() : canonicalHome,
  })
}

async function protectRecord(
  home: string,
  installationId: string,
  payload: OperatorScopePayload,
  createdAt: string,
  options: NonceProtectionOptions,
): Promise<OperatorScopeRecord> {
  const base = {
    schemaVersion: 1 as const,
    installationId,
    homeBindingDigest: homeBindingDigest(home),
    createdAt,
  }
  const protectedData = await protectBoundData(
    Buffer.from(canonicalJson(payload), 'utf8'),
    Buffer.from(canonicalJson(base), 'utf8'),
    'GeoResearch operator scope',
    options,
  )
  return { ...base, protection: protectedData.protection, protectedPayload: protectedData.value }
}

async function unprotectPayload(
  record: OperatorScopeRecord,
  options: NonceProtectionOptions,
): Promise<OperatorScopePayload> {
  const plaintext = await unprotectBoundData(
    record.protectedPayload,
    record.protection,
    bindingBytes(record),
    options,
  )
  return parsePayload(JSON.parse(plaintext.toString('utf8')) as unknown)
}

function bindingBytes(record: Pick<OperatorScopeRecord, 'schemaVersion' | 'installationId' | 'homeBindingDigest' | 'createdAt'>): Buffer {
  return Buffer.from(canonicalJson({
    schemaVersion: record.schemaVersion,
    installationId: record.installationId,
    homeBindingDigest: record.homeBindingDigest,
    createdAt: record.createdAt,
  }), 'utf8')
}

function parsePayload(value: unknown): OperatorScopePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('operator scope payload must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.schemaVersion !== 1
    || typeof record.operatorScopeId !== 'string'
    || typeof record.credentialHmacKey !== 'string'
    || typeof record.continuationSealKey !== 'string') {
    throw new TypeError('operator scope payload is invalid')
  }
  decodeKey(record.operatorScopeId, 'operator scope id')
  decodeKey(record.credentialHmacKey, 'credential HMAC key')
  decodeKey(record.continuationSealKey, 'continuation seal key')
  return record as unknown as OperatorScopePayload
}

function decodeKey(value: string, label: string): Buffer {
  const bytes = decodeBase64Url(value, label)
  if (bytes.byteLength !== 32) throw new TypeError(`${label} must contain exactly 256 bits`)
  return bytes
}

function decodeBase64Url(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError(`${label} must be canonical base64url`)
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) throw new TypeError(`${label} must be canonical base64url`)
  return decoded
}
