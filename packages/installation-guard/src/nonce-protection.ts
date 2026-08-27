import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { canonicalJson, type MaintenanceNonceRecord } from '@georesearch/dsh-contracts'

export const MAINTENANCE_PROTECTED_NONCE_ENV = 'GEORESEARCH_MAINTENANCE_PROTECTED_NONCE'
export const MAINTENANCE_TEST_KEY_ENV = 'GEORESEARCH_TEST_NONCE_KEY'

export type MaintenanceNonceBinding = Pick<
  MaintenanceNonceRecord,
  'transactionId' | 'generation' | 'executable' | 'deadline'
>

export interface ProtectedMaintenanceNonce {
  readonly protection: MaintenanceNonceRecord['protection']
  readonly value: string
}

export interface ProtectedBoundData {
  readonly protection: MaintenanceNonceRecord['protection']
  readonly value: string
}

export interface NonceProtectionOptions {
  readonly testKey?: string
}

const AES_ENVELOPE_VERSION = 1
const AES_IV_BYTES = 12
const AES_TAG_BYTES = 16
const CRYPTPROTECT_UI_FORBIDDEN = 0x1

export async function protectMaintenanceNonce(
  nonce: string,
  binding: MaintenanceNonceBinding,
  options: NonceProtectionOptions = {},
): Promise<ProtectedMaintenanceNonce> {
  assertNonce(nonce)
  return protectBoundData(
    Buffer.from(nonce, 'utf8'),
    bindingBytes(binding),
    'GeoResearch maintenance transaction',
    options,
  )
}

export async function unprotectMaintenanceNonce(
  protectedNonce: string,
  protection: MaintenanceNonceRecord['protection'],
  binding: MaintenanceNonceBinding,
  options: NonceProtectionOptions = {},
): Promise<string> {
  if (protectedNonce.length === 0) throw new TypeError('protected maintenance nonce must not be empty')
  const plaintext = await unprotectBoundData(
    protectedNonce,
    protection,
    bindingBytes(binding),
    options,
  )
  const nonce = plaintext.toString('utf8')
  assertNonce(nonce)
  return nonce
}

export async function protectBoundData(
  plaintext: Uint8Array,
  associatedData: Uint8Array,
  description: string,
  options: NonceProtectionOptions = {},
): Promise<ProtectedBoundData> {
  if (plaintext.byteLength < 1) throw new TypeError('bound plaintext must not be empty')
  if (associatedData.byteLength < 1) throw new TypeError('bound associated data must not be empty')
  if (description.length === 0 || Buffer.byteLength(description, 'utf8') > 128) {
    throw new TypeError('bound data description must be non-empty and bounded')
  }
  const testKey = resolveTestKey(options)
  if (testKey !== undefined) {
    return {
      protection: 'test-aes-256-gcm',
      value: protectForTest(Buffer.from(plaintext), Buffer.from(associatedData), testKey),
    }
  }
  if (process.platform !== 'win32') {
    throw new Error('bound data protection requires Windows DPAPI outside explicit tests')
  }
  return {
    protection: 'dpapi-current-user',
    value: (await dpapiTransform(
      'protect',
      Buffer.from(plaintext),
      Buffer.from(associatedData),
      description,
    )).toString('base64url'),
  }
}

export async function unprotectBoundData(
  protectedValue: string,
  protection: MaintenanceNonceRecord['protection'],
  associatedData: Uint8Array,
  options: NonceProtectionOptions = {},
): Promise<Buffer> {
  if (protectedValue.length === 0) throw new TypeError('protected bound data must not be empty')
  if (associatedData.byteLength < 1) throw new TypeError('bound associated data must not be empty')
  switch (protection) {
    case 'test-aes-256-gcm': {
      const testKey = resolveTestKey(options)
      if (testKey === undefined) throw new Error('test bound data protection requires an explicit test key')
      return unprotectForTest(protectedValue, Buffer.from(associatedData), testKey)
    }
    case 'dpapi-current-user':
      if (process.platform !== 'win32') throw new Error('DPAPI bound data cannot be opened off Windows')
      return dpapiTransform(
        'unprotect',
        decodeBase64Url(protectedValue, 'DPAPI payload'),
        Buffer.from(associatedData),
        '',
      )
  }
}

function protectForTest(plaintext: Buffer, associatedData: Buffer, key: Buffer): string {
  const iv = randomBytes(AES_IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(associatedData)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([
    Buffer.from([AES_ENVELOPE_VERSION]),
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString('base64url')
}

function unprotectForTest(value: string, associatedData: Buffer, key: Buffer): Buffer {
  const envelope = decodeBase64Url(value, 'test AES payload')
  if (envelope.length <= 1 + AES_IV_BYTES + AES_TAG_BYTES || envelope[0] !== AES_ENVELOPE_VERSION) {
    throw new Error('test AES maintenance nonce envelope is invalid')
  }
  const ivStart = 1
  const tagStart = ivStart + AES_IV_BYTES
  const ciphertextStart = tagStart + AES_TAG_BYTES
  const decipher = createDecipheriv('aes-256-gcm', key, envelope.subarray(ivStart, tagStart))
  decipher.setAAD(associatedData)
  decipher.setAuthTag(envelope.subarray(tagStart, ciphertextStart))
  return Buffer.concat([decipher.update(envelope.subarray(ciphertextStart)), decipher.final()])
}

async function dpapiTransform(
  operation: 'protect' | 'unprotect',
  input: Buffer,
  entropy: Buffer,
  description: string,
): Promise<Buffer> {
  const koffi = (await import('koffi')).default
  const DataBlob = koffi.struct({ cbData: 'uint32_t', pbData: 'uint8_t *' })
  const DataBlobPointer = koffi.pointer(DataBlob)
  const crypt32 = koffi.load('crypt32.dll')
  const kernel32 = koffi.load('kernel32.dll')
  const transform = operation === 'protect'
    ? crypt32.func('__stdcall', 'CryptProtectData', 'int', [
        DataBlobPointer, 'str16', DataBlobPointer, 'void *', 'void *', 'uint32_t', koffi.out(DataBlobPointer),
      ])
    : crypt32.func('__stdcall', 'CryptUnprotectData', 'int', [
        DataBlobPointer, 'void *', DataBlobPointer, 'void *', 'void *', 'uint32_t', koffi.out(DataBlobPointer),
      ])
  const getLastError = kernel32.func('__stdcall', 'GetLastError', 'uint32_t', [])
  const localFree = kernel32.func('__stdcall', 'LocalFree', 'void *', ['void *'])
  const inputBlob = { cbData: input.byteLength, pbData: input }
  const entropyBlob = { cbData: entropy.byteLength, pbData: entropy }
  const outputBlob: { cbData?: number; pbData?: bigint | null } = {}
  const succeeded = operation === 'protect'
    ? transform(
        inputBlob,
        description,
        entropyBlob,
        null,
        null,
        CRYPTPROTECT_UI_FORBIDDEN,
        outputBlob,
      )
    : transform(
        inputBlob,
        null,
        entropyBlob,
        null,
        null,
        CRYPTPROTECT_UI_FORBIDDEN,
        outputBlob,
      )
  if (succeeded === 0) throw new Error(`Crypt${operation === 'protect' ? 'Protect' : 'Unprotect'}Data failed with Win32 code ${getLastError()}`)
  const pointer = outputBlob.pbData
  const length = outputBlob.cbData
  if (pointer === undefined || pointer === null || length === undefined || length < 1) {
    throw new Error(`Crypt${operation === 'protect' ? 'Protect' : 'Unprotect'}Data returned an empty blob`)
  }
  try {
    return Buffer.from(new Uint8Array(koffi.view(pointer, length)))
  } finally {
    const remainder = localFree(pointer) as bigint | number | null
    if (remainder !== null && remainder !== 0 && remainder !== 0n) {
      throw new Error('LocalFree failed for the DPAPI output blob')
    }
  }
}

function bindingBytes(binding: MaintenanceNonceBinding): Buffer {
  return Buffer.from(canonicalJson({
    schemaVersion: 1,
    transactionId: binding.transactionId,
    generation: binding.generation,
    executable: binding.executable,
    deadline: binding.deadline,
  }), 'utf8')
}

function resolveTestKey(options: NonceProtectionOptions): Buffer | undefined {
  const encoded = options.testKey ?? process.env[MAINTENANCE_TEST_KEY_ENV]
  if (encoded === undefined) return undefined
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(`${MAINTENANCE_TEST_KEY_ENV} is accepted only when NODE_ENV=test`)
  }
  const key = decodeBase64Url(encoded, 'test nonce key')
  if (key.byteLength !== 32) throw new TypeError('test nonce key must decode to exactly 32 bytes')
  return key
}

function decodeBase64Url(value: string, label: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new TypeError(`${label} must be canonical base64url`)
  const decoded = Buffer.from(value, 'base64url')
  if (decoded.toString('base64url') !== value) throw new TypeError(`${label} must be canonical base64url`)
  return decoded
}

function assertNonce(value: string): void {
  if (value.length === 0 || Buffer.byteLength(value, 'utf8') > 256) {
    throw new TypeError('maintenance nonce must be a non-empty bounded UTF-8 string')
  }
}
