import { describe, expect, it, vi } from 'vitest'
import { ProviderAdmissionError, ProviderLifecycle } from '../src/index.js'

describe('provider lifecycle', () => {
  it('stops admission and drains accepted work', async () => {
    const lifecycle = new ProviderLifecycle()
    let release!: () => void
    const operation = lifecycle.admit(async () => {
      await new Promise<void>(resolve => { release = resolve })
      return 'done'
    })
    const draining = lifecycle.drain()
    expect(lifecycle.state).toBe('DRAINING')
    expect(lifecycle.inFlight).toBe(1)
    await expect(lifecycle.admit(() => undefined)).rejects.toBeInstanceOf(ProviderAdmissionError)
    release()
    await expect(operation).resolves.toBe('done')
    await draining
    expect(lifecycle.inFlight).toBe(0)
  })

  it('cancels, drains, and cleans up exactly once', async () => {
    const lifecycle = new ProviderLifecycle()
    const cancel = vi.fn()
    const cleanup = vi.fn()
    const first = lifecycle.dispose({ cancel, cleanup })
    const second = lifecycle.dispose({ cancel, cleanup })
    expect(second).toBe(first)
    await first
    expect(lifecycle.state).toBe('DISPOSED')
    expect(cancel).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('finishes disposal even when cancellation and cleanup fail', async () => {
    const lifecycle = new ProviderLifecycle()
    await expect(lifecycle.dispose({
      cancel: () => { throw new Error('cancel failed') },
      cleanup: () => { throw new Error('cleanup failed') },
    })).rejects.toBeInstanceOf(AggregateError)
    expect(lifecycle.state).toBe('DISPOSED')
  })
})
