import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { assertTelemetryAbsent } from '../src/index.js'

describe('telemetry activation guard', () => {
  it('fails closed whenever the telemetry service exists', () => {
    const unsafe = { get: () => ({}) } as unknown as Context
    expect(() => assertTelemetryAbsent(unsafe)).toThrow(expect.objectContaining({
      code: 'GEORESEARCH_TELEMETRY_UNSAFE',
    }))
  })

  it('accepts an absent telemetry service', () => {
    const safe = { get: () => undefined } as unknown as Context
    expect(() => assertTelemetryAbsent(safe)).not.toThrow()
  })
})
