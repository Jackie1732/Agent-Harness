/** Value that a caller may also supply as a promise. */
export type Awaitable<T> = T | PromiseLike<T>

/** Lifecycle state of an `EffectOwner`. */
export type EffectOwnerStatus = 'accepting' | 'disposing' | 'disposed'

/** Forward operation that returns the value needed by its inverse. */
export type EffectOperation<T> = () => Awaitable<T>

/**
 * Inverse of one forward operation, applied to the value that operation returned.
 *
 * The runtime calls it at most once with the exact value returned by the operation.
 */
export type EffectReverter<T> = (value: T) => Awaitable<void>

/**
 * Acquisition context of a single Effect.
 *
 * The context belongs to one `run()` call and is the only way that Effect acquires
 * tracked resources. Releasing the Effect or Owner runs every accepted inverse.
 */
export interface EffectContext {
  /**
   * Aborted once the owning Effect or its Owner begins releasing.
   *
   * Operations may observe it for cooperative cancellation. Release still waits for an
   * operation that ignores the signal until that operation settles.
   */
  readonly signal: AbortSignal

  /**
   * Run one forward operation and register its inverse before returning the value.
   *
   * A fulfilled operation is added to the Effect and Owner cleanup stacks before this
   * promise fulfills. A rejected operation has no returned value, so the runtime does
   * not call its inverse. The operation remains responsible for partial work created
   * before it rejects.
   *
   * @param label - Non-empty diagnostic label; labels may repeat.
   * @param operation - Forward operation that produces the value.
   * @param revert - Inverse applied to the produced value during cleanup.
   * @returns The value produced by `operation`.
   * @throws {TypeError} If `label` is empty.
   * @throws {EffectOwnerInactiveError} If the Effect or Owner is already releasing.
   */
  apply<T>(label: string, operation: EffectOperation<T>, revert: EffectReverter<T>): Promise<T>
}

/**
 * Releasable handle for one started Effect.
 *
 * Returned by `EffectOwner.run()` after setup and all operations it started have settled.
 */
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
   * Calls outside this release's own cleanup chain return one shared promise. A concurrent
   * Owner release joins the same inverse tasks, so every inverse still runs at most once.
   *
   * @returns A promise that settles after this Effect reaches its terminal state.
   * @throws {EffectDisposalFailedError} If an inverse fails or cleanup detects a wait cycle.
   * @throws {EffectReentrantDisposeError} If cleanup directly awaits this same release.
   */
  dispose(): Promise<void>
}
