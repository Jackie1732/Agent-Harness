import { ModelError } from '../errors.js'
import { inheritsModelTask, inModelTask } from '../task-context.js'

export interface ExchangeTicket {
  readonly token: symbol
  settle(failure?: ModelError): void
}

/** Owns provider admission and outstanding client borrows, not a second cleanup stack. */
export class ExchangeCapacity {
  readonly #maximum: number
  readonly #pending = new Map<symbol, Promise<void>>()
  readonly #token = Symbol('model provider release')
  #active = true
  #failure: ModelError | undefined
  #disposeTask: Promise<void> | undefined
  #disposed = false

  constructor(maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new ModelError('MODEL_REQUEST_INVALID', 'maxConcurrentExchanges must be a positive safe integer')
    this.#maximum = maximum
  }

  assertActive(): void {
    if (!this.#active || this.#failure !== undefined) throw new ModelError('MODEL_PROVIDER_INACTIVE', 'model provider is no longer accepting exchanges')
  }

  reserve(): ExchangeTicket {
    this.assertActive()
    if (this.#pending.size >= this.#maximum) throw new ModelError('MODEL_PROVIDER_BUSY', 'model provider reached its explicit exchange capacity')
    let resolve: (() => void) | undefined
    const task = new Promise<void>(done => { resolve = done })
    const done = resolve
    if (done === undefined) throw new Error('native Promise executor did not run')
    const token = Symbol('model provider borrow')
    this.#pending.set(token, task)
    let settled = false
    return {
      token,
      settle: failure => {
        if (settled) return
        settled = true
        if (failure !== undefined) this.#failure ??= failure
        this.#pending.delete(token)
        done()
      },
    }
  }

  dispose(releaseClient: () => void | Promise<void>): Promise<void> {
    this.#active = false
    if (this.#disposeTask === undefined) {
      const task = inModelTask(this.#token, () => Promise.resolve().then(async () => {
        await Promise.all([...this.#pending.values()])
        try { await releaseClient() }
        catch { this.#failure ??= new ModelError('MODEL_CLEANUP_FAILED', 'model provider client release failed') }
        this.#disposed = true
        if (this.#failure !== undefined) throw this.#failure
      }))
      this.#disposeTask = task
      void task.catch(() => undefined)
    }
    if (!this.#disposed && (inheritsModelTask(this.#token) || [...this.#pending.keys()].some(inheritsModelTask))) return Promise.reject(new ModelError('MODEL_REENTRANT_WAIT', 'provider release cannot wait for itself'))
    return this.#disposeTask
  }
}
