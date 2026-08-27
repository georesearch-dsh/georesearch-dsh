import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  protectMaintenanceNonce,
  unprotectMaintenanceNonce,
} from '../src/nonce-protection.js'

const originalNodeEnv = process.env.NODE_ENV
const key = randomBytes(32).toString('base64url')
const binding = {
  transactionId: '2b543d57-fdfa-4e74-aeef-05544880af7b',
  generation: 7,
  executable: process.execPath,
  deadline: '2026-08-16T12:00:00.000Z',
}

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})

describe('maintenance nonce protection', () => {
  it('round-trips only with the exact test binding', async () => {
    process.env.NODE_ENV = 'test'
    const protectedNonce = await protectMaintenanceNonce('nonce-value', binding, { testKey: key })
    expect(protectedNonce.protection).toBe('test-aes-256-gcm')
    await expect(unprotectMaintenanceNonce(
      protectedNonce.value,
      protectedNonce.protection,
      binding,
      { testKey: key },
    )).resolves.toBe('nonce-value')
    await expect(unprotectMaintenanceNonce(
      protectedNonce.value,
      protectedNonce.protection,
      { ...binding, generation: 8 },
      { testKey: key },
    )).rejects.toThrow()
  })

  it('rejects the test fallback outside NODE_ENV=test', async () => {
    process.env.NODE_ENV = 'production'
    await expect(protectMaintenanceNonce('nonce-value', binding, { testKey: key }))
      .rejects.toThrow(/only when NODE_ENV=test/)
  })
})
