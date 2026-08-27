export type ProviderLifecycleState = 'ACCEPTING' | 'DRAINING' | 'DISPOSED'

export interface ProviderDisposeHooks {
  readonly cancel?: () => void | Promise<void>
  readonly cleanup?: () => void | Promise<void>
}

export class ProviderAdmissionError extends Error {
  constructor(readonly state: Exclude<ProviderLifecycleState, 'ACCEPTING'>) {
    super(`provider is ${state.toLowerCase()} and no longer accepts work`)
    this.name = 'ProviderAdmissionError'
  }
}

export class ProviderLifecycle {
  private currentState: ProviderLifecycleState = 'ACCEPTING'
  private activeCount = 0
  private idleWaiters = new Set<() => void>()
  private disposeResult: Promise<void> | undefined

  get state(): ProviderLifecycleState {
    return this.currentState
  }

  get inFlight(): number {
    return this.activeCount
  }

  async admit<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.currentState !== 'ACCEPTING') throw new ProviderAdmissionError(this.currentState)
    this.activeCount += 1
    try {
      return await operation()
    } finally {
      this.activeCount -= 1
      if (this.activeCount === 0) {
        for (const resolve of this.idleWaiters) resolve()
        this.idleWaiters.clear()
      }
    }
  }

  async drain(): Promise<void> {
    if (this.currentState === 'ACCEPTING') this.currentState = 'DRAINING'
    if (this.activeCount === 0) return
    await new Promise<void>(resolve => this.idleWaiters.add(resolve))
  }

  dispose(hooks: ProviderDisposeHooks = {}): Promise<void> {
    if (this.disposeResult !== undefined) return this.disposeResult
    this.disposeResult = this.disposeOnce(hooks)
    return this.disposeResult
  }

  private async disposeOnce(hooks: ProviderDisposeHooks): Promise<void> {
    if (this.currentState === 'DISPOSED') return
    this.currentState = 'DRAINING'
    const errors: unknown[] = []
    try {
      await hooks.cancel?.()
    } catch (error) {
      errors.push(error)
    }
    await this.drain()
    try {
      await hooks.cleanup?.()
    } catch (error) {
      errors.push(error)
    } finally {
      this.currentState = 'DISPOSED'
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, 'provider disposal failed')
  }
}
