/** A promise with externally controlled settlement, for deterministic interleaving. */
export interface Deferred<T> {
  readonly promise: Promise<T>
  /** Settle the promise successfully. */
  readonly resolve: (value: T) => void
  /** Settle the promise as failed. */
  readonly reject: (reason: unknown) => void
  /** Whether the promise has been settled by either branch. */
  readonly settled: () => boolean
}

/**
 * Create a promise that the test settles explicitly.
 *
 * Tests use this instead of timers so an interleaving is produced by the input rather
 * than by the host scheduler.
 *
 * @returns The controlled promise together with its settlement functions.
 */
export function createDeferred<T>(): Deferred<T> {
  let settled = false
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = value => {
      settled = true
      resolvePromise(value)
    }
    reject = reason => {
      settled = true
      rejectPromise(reason)
    }
  })
  return { promise, resolve, reject, settled: () => settled }
}

/**
 * Let queued promise continuations and microtasks run.
 *
 * @param rounds - Number of microtask turns to drain.
 */
export async function drainMicrotasks(rounds = 4): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await Promise.resolve()
  }
}

/**
 * Observe the outcome of a promise without failing the test on rejection.
 *
 * @param promise - Promise to observe.
 * @returns A settled description of the outcome.
 */
export async function settle<T>(
  promise: Promise<T>,
): Promise<{ readonly status: 'fulfilled'; readonly value: T } | { readonly status: 'rejected'; readonly reason: unknown }> {
  try {
    return { status: 'fulfilled', value: await promise }
  } catch (reason) {
    return { status: 'rejected', reason }
  }
}
