import { describe, expect, it } from 'vitest'
import {
  createOperatorScopeRecord,
  openOperatorScopeRecord,
  rebindOperatorScopeRecord,
} from '../src/operator-scope.js'

const testKey = Buffer.alloc(32, 0x33).toString('base64url')
const options = { testKey }

describe('installation operator scope', () => {
  it('binds a 256-bit scope to one home while preserving it across an upgrade rebind', async () => {
    const firstHome = 'C:\\dsh-home-one'
    const stageHome = 'C:\\dsh-home-stage'
    const record = await createOperatorScopeRecord(firstHome, 'installation-1', options)
    const opened = await openOperatorScopeRecord(firstHome, 'installation-1', record, options)
    expect(Buffer.from(opened.operatorScopeId, 'base64url')).toHaveLength(32)

    const staged = await rebindOperatorScopeRecord(
      record,
      firstHome,
      stageHome,
      'installation-1',
      options,
    )
    const reopened = await openOperatorScopeRecord(stageHome, 'installation-1', staged, options)
    expect(reopened.operatorScopeId).toBe(opened.operatorScopeId)
    await expect(openOperatorScopeRecord('C:\\different-home', 'installation-1', record, options))
      .rejects.toMatchObject({ code: 'OPERATOR_SCOPE_UNAVAILABLE' })
  })

  it('fingerprints credentials without exposing them and authenticates private state bindings', async () => {
    const record = await createOperatorScopeRecord('C:\\dsh-home', 'installation-1', options)
    const scope = await openOperatorScopeRecord('C:\\dsh-home', 'installation-1', record, options)
    const first = scope.credentialFingerprint('secret-one')
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(scope.credentialFingerprint('secret-one')).toBe(first)
    expect(scope.credentialFingerprint('secret-two')).not.toBe(first)

    const binding = { continuation: 'one', generation: 1 } as const
    const envelope = scope.sealPrivateState({ cursor: 'next-page' }, binding)
    expect(scope.openPrivateState(envelope, binding)).toEqual({ cursor: 'next-page' })
    expect(() => scope.openPrivateState(envelope, { continuation: 'two', generation: 1 }))
      .toThrow(/authentication failed/)
  })
})
