import type { ModelInvocationPhase, ModelOutcome } from './settlement.js'

/** Desired cancellation, current phase and the unique termination claim stay separate. */
export class InvocationControl {
  readonly #abort = new AbortController()
  #desired: 'continue' | 'cancel' = 'continue'
  #decision: ModelOutcome | undefined
  current: ModelInvocationPhase = 'preparing'

  get signal(): AbortSignal { return this.#abort.signal }
  get desired(): 'continue' | 'cancel' { return this.#desired }
  isCancelled(): boolean { return this.#desired === 'cancel' }
  get decision(): ModelOutcome | undefined { return this.#decision }

  requestCancel(): void {
    // A claimed result is immutable, but its transport can still be awaiting EOF.
    // Cancellation must reach that I/O even after completion won the outcome race.
    this.#desired = 'cancel'
    this.#decision ??= 'cancelled'
    this.#abort.abort()
  }

  claim(outcome: ModelOutcome): ModelOutcome {
    this.#decision ??= outcome
    return this.#decision
  }

  /** Stop transport after a local failure without changing an already selected outcome. */
  stopReading(): void { this.#abort.abort() }

  /** The returned inverse is immediately registered by the invocation's EffectOwner. */
  subscribe(signals: readonly AbortSignal[]): () => void {
    const cancel = (): void => this.requestCancel()
    const registered: AbortSignal[] = []
    try {
      for (const signal of signals) {
        signal.addEventListener('abort', cancel, { once: true })
        registered.push(signal)
        if (signal.aborted) this.requestCancel()
      }
    } catch (reason) {
      for (const signal of registered) signal.removeEventListener('abort', cancel)
      throw reason
    }
    return () => { for (const signal of registered) signal.removeEventListener('abort', cancel) }
  }
}
