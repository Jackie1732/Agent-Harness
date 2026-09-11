import { AsyncLocalStorage } from 'node:async_hooks'
import {
  EffectDisposalFailedError,
  EffectOwnerInactiveError,
  EffectReentrantDisposeError,
  EffectRollbackFailedError,
  EffectStartInterruptedError,
} from './errors.js'
import type { EffectCleanupFailure } from './errors.js'
import type {
  Awaitable,
  EffectContext,
  EffectLease,
  EffectOperation,
  EffectOwnerStatus,
  EffectReverter,
} from './types.js'

/** One inverse accepted by an Effect, run at most once. */
interface CleanupRecord {
  readonly operationLabel: string
  readonly revert: () => Promise<void>
  /** Published shared task; its presence is what marks the record as claimed. */
  execution?: Promise<EffectCleanupFailure | undefined>
}

/** One started Effect and the ownership state the runtime keeps for it. */
interface EffectRecord {
  readonly owner: EffectOwnerRecord
  readonly label: string
  readonly abort: AbortController
  /** False once the Effect stops accepting new operations. */
  accept: boolean
  /** Set once the final checkpoint found the owner releasing, before rollback runs. */
  interrupted: boolean
  /** Forward operations that started and have not settled yet. */
  readonly operations: Set<Promise<unknown>>
  /** Inverses of this Effect, in acceptance order. */
  readonly local: CleanupRecord[]
  /** Settles when the user `setup` call settles. */
  readonly runEntry: Promise<void>
  /** Resolves `runEntry` once setup has settled. */
  readonly resolveRunEntry: () => void
  /** Shared release task of this Effect, created by its first release request. */
  leaseDisposal?: Promise<void>
  /** Private token identifying this Effect's release task. */
  readonly token: number
}

/** Owner state shared by every Effect it started. */
interface EffectOwnerRecord {
  readonly label: string
  state: EffectOwnerStatus
  readonly effects: Set<EffectRecord>
  /** Inverses of every Effect, in acceptance order. */
  readonly global: CleanupRecord[]
  /** Shared release task of the owner, created by its first release request. */
  disposalTask?: Promise<void>
  /** Private token identifying the owner's release task. */
  readonly token: number
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

const disposalContext = new AsyncLocalStorage<ReadonlySet<number>>()

/** Tokens of release tasks that have started and not settled yet. */
const runningDisposals = new Set<number>()
let nextDisposalToken = 1

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

type TaskOutcome<T> =
  | { readonly status: 'fulfilled'; readonly value: T }
  | { readonly status: 'rejected'; readonly reason: unknown }

/**
 * Wait for one task and report its outcome as data.
 *
 * @param task - Task to settle.
 * @returns The settled outcome of the task.
 */
async function settleTask<T>(task: Promise<T>): Promise<TaskOutcome<T>> {
  try {
    return { status: 'fulfilled', value: await task }
  } catch (reason) {
    return { status: 'rejected', reason }
  }
}

function resolveAsSettled(promise: Promise<unknown>): Promise<void> {
  const settled = deferred<void>()
  void promise.then(
    () => settled.resolve(undefined),
    () => settled.resolve(undefined),
  )
  return settled.promise
}

/**
 * Run one release task under a token set inherited from the calling chain.
 *
 * The set is copied and extended rather than replaced, so an inner release keeps every
 * token it inherited and a release reached through its own task is detectable. The task
 * is registered as running for as long as it has not settled, which is what separates a
 * re-entrant call from one that reached a settled release it may safely join.
 *
 * @param token - Token identifying the release task about to run.
 * @param task - Work the release task performs.
 * @returns The result of `task`.
 */
function runWithDisposalToken<T>(token: number, task: () => Promise<T>): Promise<T> {
  const tokens = new Set(disposalContext.getStore())
  tokens.add(token)
  return disposalContext.run(tokens, async (): Promise<T> => {
    runningDisposals.add(token)
    try {
      return await task()
    } finally {
      runningDisposals.delete(token)
    }
  })
}

/**
 * Reject a release that would wait for the release task currently running it.
 *
 * The token must be inherited by the calling chain and its task must still be running:
 * a settled release is idempotent and a caller that reached it through the same chain
 * may simply join it.
 *
 * @param token - Token of the release task that would run again.
 * @param labels - Labels of the ownership scopes involved, most specific first.
 */
function assertNotReentrant(token: number, labels: readonly string[]): void {
  const inherited = disposalContext.getStore()
  if (inherited !== undefined && inherited.has(token) && runningDisposals.has(token)) {
    throw new EffectReentrantDisposeError(labels)
  }
}

function requireLabel(label: string, kind: string): string {
  if (label.length === 0) throw new TypeError(`${kind} label must not be empty`)
  return label
}

/**
 * Apply one inverse and report its outcome without rejecting.
 *
 * @param operationLabel - Label of the operation whose inverse runs.
 * @param revert - Inverse to apply.
 * @returns A failure description, or undefined when the inverse succeeded.
 */
async function callRevert(
  operationLabel: string,
  revert: () => Promise<void>,
): Promise<EffectCleanupFailure | undefined> {
  try {
    await revert()
    return undefined
  } catch (reason) {
    return { operationLabel, stage: 'revert', reason }
  }
}

/**
 * Publish the shared task of one record before the inverse it wraps runs.
 *
 * The published task is the record's only observable execution, so the scope that creates
 * it owns the single run of that inverse and every later caller joins it. Publishing
 * without awaiting anything is what keeps a re-entrant caller from observing a record
 * whose task is still unassigned. The inverse itself is deferred by one microtask so that
 * publication precedes the user call and a synchronous throw inside the inverse is
 * reported as a failure rather than escaping the publishing call.
 *
 * @param record - Record whose task to publish, or whose published task to join.
 * @returns The shared task of the record.
 */
function cleanupRecord(record: CleanupRecord): Promise<EffectCleanupFailure | undefined> {
  if (record.execution !== undefined) return record.execution
  const execution = Promise.resolve().then(() => callRevert(record.operationLabel, record.revert))
  record.execution = execution
  return execution
}

/**
 * Publish the task of every record, newest first, without awaiting any of them.
 *
 * Publishing the whole batch in one synchronous section means a scope sweeping the same
 * records afterwards waits for these tasks instead of running any inverse a second time,
 * and the newest-first order gives the batch its reverse acceptance order.
 *
 * @param records - Records in acceptance order.
 * @returns Published tasks in the order the inverses will run.
 */
function publishRecords(records: readonly CleanupRecord[]): Promise<EffectCleanupFailure | undefined>[] {
  return [...records].reverse().map(record => cleanupRecord(record))
}

/**
 * Await published tasks and keep only the failures, in the order the attempts were made.
 *
 * @param published - Published tasks in execution order.
 * @returns Failures in the order the attempts were made.
 */
async function collectFailures(
  published: readonly Promise<EffectCleanupFailure | undefined>[],
): Promise<EffectCleanupFailure[]> {
  const results = await Promise.all(published)
  return results.filter((failure): failure is EffectCleanupFailure => failure !== undefined)
}

/**
 * Run cleanup records in reverse acceptance order and collect every failure.
 *
 * @param records - Records in acceptance order.
 * @returns Failures in the order the attempts were made.
 */
async function runCleanupBatch(
  records: readonly CleanupRecord[],
): Promise<EffectCleanupFailure[]> {
  return collectFailures(publishRecords(records))
}

/**
 * Wait for the records another scope already published a task for.
 *
 * @param records - Records in acceptance order.
 */
async function awaitClaimedRecords(records: readonly CleanupRecord[]): Promise<void> {
  const started = records
    .filter(record => record.execution !== undefined)
    .map(record => record.execution as Promise<EffectCleanupFailure | undefined>)
  await Promise.all(started)
}

/**
 * Acceptance context of one `run()` call.
 */
class EffectContextImpl implements EffectContext {
  readonly #effect: EffectRecord

  /**
   * Create the context of one Effect.
   *
   * @param effect - Record of the Effect this context acquires resources for.
   */
  constructor(effect: EffectRecord) {
    this.#effect = effect
  }

  get signal(): AbortSignal {
    return this.#effect.abort.signal
  }

  async apply<T>(
    label: string,
    operation: EffectOperation<T>,
    revert: EffectReverter<T>,
  ): Promise<T> {
    const operationLabel = requireLabel(label, 'operation')
    const effect = this.#effect
    const owner = effect.owner
    // An effect whose final checkpoint already failed reports its own interruption, which
    // is the reason its startup ended; any other closed effect or owner reports inactivity.
    if (effect.interrupted) {
      throw new EffectStartInterruptedError(effect.label, effect.local.length, [])
    }
    if (owner.state !== 'accepting') {
      throw new EffectOwnerInactiveError(operationLabel, owner.state)
    }
    if (!effect.accept) {
      throw new EffectOwnerInactiveError(operationLabel, 'effect-released')
    }

    const task = (async () => {
      await Promise.resolve()
      return await operation()
    })()
    effect.operations.add(task)
    let value: T
    try {
      value = await task
    } finally {
      effect.operations.delete(task)
    }

    // Synchronous critical section: the record reaches both stacks before the value is
    // handed to the caller, with no await, user callback, or re-entrant call between.
    const record: CleanupRecord = {
      operationLabel,
      revert: async () => {
        await revert(value)
      },
    }
    effect.local.push(record)
    owner.global.push(record)
    return value
  }
}

/**
 * Ownership scope for Effects that acquire revertible resources.
 *
 * Every inverse accepted through one of its Effects is registered before the acquired
 * value reaches the caller, is applied at most once, and is applied in the reverse of
 * the order it was accepted.
 */
export class EffectOwner {
  readonly #record: EffectOwnerRecord

  /**
   * Create an owner that accepts Effects until it is released.
   *
   * @param label - Diagnostic label for the owner.
   */
  constructor(label = 'owner') {
    this.#record = {
      label: requireLabel(label, 'owner'),
      state: 'accepting',
      effects: new Set(),
      global: [],
      token: nextDisposalToken++,
    }
  }

  /** Current lifecycle state of this owner. */
  get status(): EffectOwnerStatus {
    return this.#record.state
  }

  /**
   * Start one Effect and return a lease that releases it independently.
   *
   * @param label - Diagnostic label for the Effect; labels may repeat.
   * @param setup - Work that acquires resources through the supplied context.
   * @returns A lease holding the setup result once the final owner check passes.
   */
  run<T>(label: string, setup: (context: EffectContext) => Awaitable<T>): Promise<EffectLease<T>> {
    const owner = this.#record
    return (async (): Promise<EffectLease<T>> => {
      const effectLabel = requireLabel(label, 'effect')
      if (owner.state !== 'accepting') {
        throw new EffectOwnerInactiveError(effectLabel, owner.state)
      }

      const entry = deferred<void>()
      const effect: EffectRecord = {
        owner,
        label: effectLabel,
        abort: new AbortController(),
        accept: true,
        interrupted: false,
        operations: new Set(),
        local: [],
        runEntry: entry.promise,
        resolveRunEntry: () => entry.resolve(undefined),
        token: nextDisposalToken++,
      }
      owner.effects.add(effect)

      const task = (async () => {
        await Promise.resolve()
        return await setup(new EffectContextImpl(effect))
      })()
      void task.then(
        () => entry.resolve(undefined),
        () => entry.resolve(undefined),
      )

      return await startEffect(effect, task)
    })()
  }

  /**
   * Release every Effect this owner still holds and wait for tracked work to settle.
   *
   * @returns A promise that settles after the owner reaches its terminal state.
   */
  dispose(): Promise<void> {
    const owner = this.#record
    if (owner.state === 'accepting') {
      owner.state = 'disposing'
      for (const effect of owner.effects) {
        effect.accept = false
        abortEffect(effect)
      }
    }
    assertNotReentrant(owner.token, [owner.label])
    if (owner.disposalTask === undefined) {
      // Release tasks are created inside their own token context so that every
      // continuation they reach inherits the token and can be detected as re-entrant.
      owner.disposalTask = runWithDisposalToken(owner.token, () => releaseOwner(owner))
    }
    return owner.disposalTask
  }
}

function abortEffect(effect: EffectRecord): void {
  effect.abort.abort(new Error(`effect "${effect.label}" is releasing`))
}

async function startEffect<T>(effect: EffectRecord, task: Promise<T>): Promise<EffectLease<T>> {
  const owner = effect.owner
  const outcome = await settleTask(task)

  // Final checkpoint: the only place that decides whether this "run" succeeds. Setup has
  // settled here, so the owner may stop waiting for this effect while its rollback runs.
  effect.accept = false
  if (outcome.status === 'fulfilled' && owner.state === 'accepting') {
    effect.resolveRunEntry()
    return makeLease(effect, outcome.value)
  }

  effect.interrupted = outcome.status === 'fulfilled'
  effect.resolveRunEntry()
  const reason = outcome.status === 'rejected' ? outcome.reason : undefined
  const failures = await cleanupEffect(effect)
  if (failures.length === 0) {
    if (outcome.status === 'rejected') throw outcome.reason
    throw new EffectStartInterruptedError(effect.label, effect.local.length, failures)
  }
  // The cause is the reason the startup ended: the setup failure when setup reported one,
  // otherwise the interrupt that replaced a successful setup.
  const cause = outcome.status === 'rejected'
    ? outcome.reason
    : new EffectStartInterruptedError(effect.label, effect.local.length, [])
  throw new EffectRollbackFailedError(effect.label, reason ?? cause, cause, failures)
}

function makeLease<T>(effect: EffectRecord, value: T): EffectLease<T> {
  return {
    label: effect.label,
    value,
    dispose: () => disposeLease(effect),
  }
}

function disposeLease(effect: EffectRecord): Promise<void> {
  // The guard runs before joining an existing task: a release reached from inside its own
  // cleanup would otherwise wait for itself and never settle.
  assertNotReentrant(effect.token, [effect.label, effect.owner.label])
  effect.accept = false
  abortEffect(effect)
  effect.leaseDisposal ??= runWithDisposalToken(effect.token, () => releaseLease(effect))
  return effect.leaseDisposal
}

/**
 * Wait for tracked forward work, then apply this Effect's own inverses in reverse order.
 *
 * @param effect - Effect being released.
 * @returns Failures in the order the attempts were made.
 */
async function cleanupEffect(effect: EffectRecord): Promise<EffectCleanupFailure[]> {
  // Publishing before waiting gives this effect priority over an owner sweep that starts
  // while its forward work is still settling.
  const published = publishRecords(effect.local)
  await waitForForwardWork(effect)
  return collectFailures(published)
}

async function releaseOwner(owner: EffectOwnerRecord): Promise<void> {
  try {
    await Promise.all([...owner.effects].map(effect => waitForForwardWork(effect)))
    const failures = await runCleanupBatch(owner.global)
    if (failures.length > 0) {
      throw new EffectDisposalFailedError('owner', undefined, failures)
    }
  } finally {
    owner.state = 'disposed'
  }
}

async function releaseLease(effect: EffectRecord): Promise<void> {
  const failures = await cleanupEffect(effect)
  if (failures.length > 0) {
    throw new EffectDisposalFailedError('lease', effect.label, failures)
  }
}

/**
 * Wait for the forward work the runtime tracks for one Effect.
 *
 * Settling the setup entry covers every operation awaited before setup settled, and the
 * residual operations loop covers operations still awaited when the entry settles.
 *
 * @param effect - Effect whose forward work is awaited.
 */
async function waitForForwardWork(effect: EffectRecord): Promise<void> {
  await Promise.all([
    resolveAsSettled(effect.runEntry),
    waitForOperations(effect),
    awaitClaimedRecords(effect.local),
  ])
}

async function waitForOperations(effect: EffectRecord): Promise<void> {
  while (effect.operations.size > 0) {
    await Promise.all([...effect.operations].map(promise => resolveAsSettled(promise)))
  }
}
