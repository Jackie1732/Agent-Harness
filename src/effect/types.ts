/** Value that a caller may also supply as a promise. */
export type Awaitable<T> = T | PromiseLike<T>

/** Lifecycle state of an `EffectOwner`. */
export type EffectOwnerStatus = 'accepting' | 'disposing' | 'disposed'

/** Forward operation that acquires a resource or transforms internal state. */
export type EffectOperation<T> = () => Awaitable<T>

/** Inverse of one forward operation, applied to the value that operation returned. */
export type EffectReverter<T> = (value: T) => Awaitable<void>

/**
 * Acquisition context of a single Effect.
 *
 * The context belongs to one `run()` call and is the only way that Effect acquires
 * tracked resources.
 */
export interface EffectContext {
  /** Aborted once the owning Effect or its Owner begins releasing. */
  readonly signal: AbortSignal

  /**
   * Run one forward operation and register its inverse before returning the value.
   *
   * @param label - Diagnostic label for the operation; may repeat across operations.
   * @param operation - Forward operation that produces the value.
   * @param revert - Inverse applied to the produced value during cleanup.
   * @returns The value produced by `operation`.
   */
  apply<T>(label: string, operation: EffectOperation<T>, revert: EffectReverter<T>): Promise<T>
}

/** Releasable handle for one started Effect. */
export interface EffectLease<T> {
  /** Diagnostic label of the Effect; not a stable identifier. */
  readonly label: string

  /**
   * Raw value returned by `setup`, without liveness tracking.
   *
   * The owning Effect or Owner beginning release stops this value from being a
   * guaranteed active resource; the runtime neither clears nor proxies it.
   */
  readonly value: T

  /**
   * Release this Effect and wait until every inverse it accepted has settled.
   *
   * @returns A promise that settles after this Effect reaches its terminal state.
   */
  dispose(): Promise<void>
}
