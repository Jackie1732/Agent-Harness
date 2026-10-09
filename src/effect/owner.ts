import {
  assertNoInheritedCleanup,
  assertNotReentrant,
  createDisposalToken,
  runCleanupBatch,
  runWithDisposalToken,
} from './cleanup.js'
import type { CleanupOutcome, CleanupRecord } from './cleanup.js'
import {
  EffectDisposalFailedError,
  EffectOwnerInactiveError,
  EffectRollbackFailedError,
  EffectStartInterruptedError,
} from './errors.js'
import type {
  Awaitable,
  EffectContext,
  EffectLease,
  EffectOperation,
  EffectOwnerStatus,
  EffectReverter,
} from './types.js'

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
  readonly operations: Set<Promise<void>>
  /** Inverses of this Effect, in acceptance order. */
  readonly local: CleanupRecord[]
  /** Settles after forward work closes and startup transfers cleanup ownership. */
  readonly ownerReady: Promise<void>
  /** Resolves `ownerReady` at the owner release handoff point. */
  readonly resolveOwnerReady: () => void
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
  /** Pending inverses and retained failures, in acceptance order. */
  readonly global: Set<CleanupRecord>
  /** Shared release task of the owner, created by its first release request. */
  disposalTask?: Promise<void>
  /** Settles after the Owner publishes its shared cleanup tasks. */
  readonly cleanupReady: Promise<void>
  /** Resolves the Owner's cleanup publication handoff. */
  readonly resolveCleanupReady: () => void
  /** Private token identifying the owner's release task. */
  readonly token: number
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

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

/**
 * Validate a diagnostic label.
 *
 * @param label - Label to validate.
 * @param kind - Subject named by the label.
 * @returns The unchanged label.
 * @throws {TypeError} If the label is empty.
 */
function requireLabel(label: string, kind: string): string {
  if (label.length === 0) throw new TypeError(`${kind} label must not be empty`)
  return label
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

    const completed = deferred<void>()
    effect.operations.add(completed.promise)
    try {
      const value = await operation()

      // Both stacks receive the inverse before this task is marked complete or the value
      // reaches setup, so a concurrent release cannot miss the acquired resource.
      const record: CleanupRecord = {
        operationLabel,
        retainedBy: owner.global,
        state: { kind: 'pending', revert: async () => { await revert(value) } },
      }
      effect.local.push(record)
      owner.global.add(record)
      return value
    } finally {
      effect.operations.delete(completed.promise)
      completed.resolve(undefined)
    }
  }
}

/**
 * Ownership scope for Effects that acquire revertible resources.
 *
 * Every inverse accepted through one of its Effects is registered before the acquired
 * value reaches the caller and is applied at most once. Each release batch applies its
 * newly claimed inverses serially in reverse acceptance order; previously started
 * independent releases retain their execution order.
 */
export class EffectOwner {
  readonly #record: EffectOwnerRecord

  /**
   * Create an owner that accepts Effects until it is released.
   *
   * @param label - Diagnostic label for the owner.
   * @throws {TypeError} If `label` is empty.
   */
  constructor(label = 'owner') {
    const cleanupReady = deferred<void>()
    this.#record = {
      label: requireLabel(label, 'owner'),
      state: 'accepting',
      effects: new Set(),
      global: new Set(),
      cleanupReady: cleanupReady.promise,
      resolveCleanupReady: () => cleanupReady.resolve(undefined),
      token: createDisposalToken(),
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
   * @returns A lease after setup and all operations it started have settled.
   * @throws {TypeError} If `label` is empty.
   * @throws {EffectOwnerInactiveError} If the Owner is already releasing.
   * @throws {EffectStartInterruptedError} If release begins before startup completes.
   * @throws {EffectRollbackFailedError} If startup fails and an inverse also fails.
   */
  run<T>(label: string, setup: (context: EffectContext) => Awaitable<T>): Promise<EffectLease<T>> {
    const owner = this.#record
    return (async (): Promise<EffectLease<T>> => {
      const effectLabel = requireLabel(label, 'effect')
      if (owner.state !== 'accepting') {
        throw new EffectOwnerInactiveError(effectLabel, owner.state)
      }

      const ownerReady = deferred<void>()
      const effect: EffectRecord = {
        owner,
        label: effectLabel,
        abort: new AbortController(),
        accept: true,
        interrupted: false,
        operations: new Set(),
        local: [],
        ownerReady: ownerReady.promise,
        resolveOwnerReady: () => ownerReady.resolve(undefined),
        token: createDisposalToken(),
      }
      owner.effects.add(effect)

      const task = (async () => {
        await Promise.resolve()
        return await setup(new EffectContextImpl(effect))
      })()
      return await startEffect(effect, task)
    })()
  }

  /**
   * Release every Effect this owner still holds and wait for tracked work to settle.
   *
   * @returns A promise that settles after the owner reaches its terminal state.
   * @throws {EffectDisposalFailedError} If an inverse fails.
   * @throws {EffectReentrantDisposeError} If cleanup directly awaits this same release.
   */
  dispose(): Promise<void> {
    const owner = this.#record
    assertNotReentrant(owner.token, [owner.label])
    assertNoInheritedCleanup(owner.global, [owner.label])
    if (owner.state === 'accepting') {
      owner.state = 'disposing'
      for (const effect of owner.effects) {
        effect.accept = false
        abortEffect(effect)
      }
    }
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

  // Closing acceptance before waiting also covers apply() calls that setup started without
  // awaiting: no later operation can enter, and every admitted operation reaches its record.
  effect.accept = false
  if (outcome.status === 'rejected') abortEffect(effect)
  await Promise.all(effect.operations)

  // Final checkpoint: the only place that decides whether this run returns a lease.
  if (outcome.status === 'fulfilled' && owner.state === 'accepting') {
    effect.resolveOwnerReady()
    return makeLease(effect, outcome.value)
  }

  effect.interrupted = outcome.status === 'fulfilled'
  const reason = outcome.status === 'rejected' ? outcome.reason : undefined
  let cleanup: CleanupOutcome
  if (owner.state === 'accepting') {
    const rollback = runWithDisposalToken(effect.token, () => cleanupEffect(effect))
    effect.resolveOwnerReady()
    cleanup = await rollback
  } else {
    const attempted = effect.local.length
    effect.resolveOwnerReady()
    await owner.cleanupReady
    const { failures } = await cleanupEffect(effect)
    cleanup = { attempted, failures }
  }
  const { attempted, failures } = cleanup
  owner.effects.delete(effect)
  if (failures.length === 0) {
    if (outcome.status === 'rejected') throw outcome.reason
    throw new EffectStartInterruptedError(effect.label, attempted, failures)
  }
  // The cause is the reason the startup ended: the setup failure when setup reported one,
  // otherwise the interrupt that replaced a successful setup.
  const cause = outcome.status === 'rejected'
    ? outcome.reason
    : new EffectStartInterruptedError(effect.label, attempted, [])
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
  assertNoInheritedCleanup(effect.local, [effect.label, effect.owner.label])
  effect.accept = false
  abortEffect(effect)
  effect.leaseDisposal ??= runWithDisposalToken(effect.token, () => releaseLease(effect))
  return effect.leaseDisposal
}

/**
 * Publish and await this Effect's own inverses in reverse acceptance order.
 *
 * @param effect - Effect being released.
 * @returns Failures in reverse acceptance order and newly claimed inverse count.
 */
function cleanupEffect(effect: EffectRecord): Promise<CleanupOutcome> {
  return runCleanupBatch(effect.local, effect.token)
}

async function releaseOwner(owner: EffectOwnerRecord): Promise<void> {
  try {
    await Promise.all([...owner.effects].map(effect => effect.ownerReady))
    const cleanup = runCleanupBatch([...owner.global], owner.token)
    owner.resolveCleanupReady()
    const { failures } = await cleanup
    if (failures.length > 0) {
      throw new EffectDisposalFailedError('owner', undefined, failures)
    }
  } finally {
    owner.state = 'disposed'
    owner.global.clear()
    owner.effects.clear()
  }
}

async function releaseLease(effect: EffectRecord): Promise<void> {
  try {
    const { failures } = await cleanupEffect(effect)
    if (failures.length > 0) {
      throw new EffectDisposalFailedError('lease', effect.label, failures)
    }
  } finally {
    effect.owner.effects.delete(effect)
  }
}
