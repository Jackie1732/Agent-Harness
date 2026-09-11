/** Value that a caller may also supply as a promise. */
export type Awaitable<T> = T | PromiseLike<T>

/** Lifecycle state of an `EffectOwner`. */
export type EffectOwnerStatus = 'accepting' | 'disposing' | 'disposed'

/**
 * Forward operation that acquires a resource or transforms internal state.
 *
 * @template T - The type of value produced by this operation
 *
 * @example
 * const openFile: EffectOperation<FileHandle> = () => fs.open('data.txt', 'r')
 */
export type EffectOperation<T> = () => Awaitable<T>

/**
 * Inverse of one forward operation, applied to the value that operation returned.
 *
 * The reverter receives the exact value produced by the forward operation and should
 * undo its effects. Called at most once per successful operation during cleanup.
 *
 * @template T - The type of value to revert
 *
 * @example
 * const closeFile: EffectReverter<FileHandle> = (handle) => handle.close()
 */
export type EffectReverter<T> = (value: T) => Awaitable<void>

/**
 * Acquisition context of a single Effect.
 *
 * The context belongs to one `run()` call and is the only way that Effect acquires
 * tracked resources. All cleanup is automatic when the Effect or Owner releases.
 *
 * @example
 * await owner.run('database', async (ctx) => {
 *   const conn = await ctx.apply(
 *     'connect',
 *     () => db.connect(),
 *     (conn) => conn.close()
 *   )
 *   return conn
 * })
 */
export interface EffectContext {
  /**
   * Aborted once the owning Effect or its Owner begins releasing.
   *
   * User code should check this signal periodically during long operations
   * and exit early when aborted to enable faster cleanup.
   *
   * @example
   * while (!ctx.signal.aborted && hasWork()) {
   *   await processNextItem()
   * }
   */
  readonly signal: AbortSignal

  /**
   * Run one forward operation and register its inverse before returning the value.
   *
   * The inverse is registered atomically after the operation succeeds, ensuring
   * cleanup runs for every acquired resource. If the operation fails, no inverse
   * is registered.
   *
   * @template T - The type of value produced by the operation
   * @param label - Diagnostic label for the operation; may repeat across operations
   * @param operation - Forward operation that produces the value
   * @param revert - Inverse applied to the produced value during cleanup
   * @returns The value produced by `operation`
   * @throws {EffectOwnerInactiveError} if the Effect or Owner is already releasing
   *
   * @example
   * const server = await ctx.apply(
   *   'http-server',
   *   () => createServer().listen(8080),
   *   (server) => server.close()
   * )
   */
  apply<T>(label: string, operation: EffectOperation<T>, revert: EffectReverter<T>): Promise<T>
}

/**
 * Releasable handle for one started Effect.
 *
 * Returned by `owner.run()` after the Effect's setup completes successfully.
 * The lease provides access to the Effect's value and allows manual disposal.
 */
export interface EffectLease<T> {
  /** Diagnostic label of the Effect; not a stable identifier. */
  readonly label: string

  /**
   * Raw value returned by `setup`, without liveness tracking.
   *
   * The owning Effect or Owner beginning release stops this value from being a
   * guaranteed active resource; the runtime neither clears nor proxies it.
   *
   * @example
   * const lease = await owner.run('db', async (ctx) => {
   *   return await ctx.apply('connect', () => db.connect(), (c) => c.close())
   * })
   * console.log(lease.value) // the database connection
   */
  readonly value: T

  /**
   * Release this Effect and wait until every inverse it accepted has settled.
   *
   * Idempotent: multiple calls return the same Promise. If the Owner is also
   * disposing, both disposal tasks coordinate to run each cleanup exactly once.
   *
   * @returns A promise that settles after this Effect reaches its terminal state
   * @throws {EffectDisposalFailedError} if any cleanup operation fails
   *
   * @example
   * const lease = await owner.run('resource', setup)
   * await lease.dispose() // manually release this Effect
   */
  dispose(): Promise<void>
}
