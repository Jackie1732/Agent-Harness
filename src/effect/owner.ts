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
  /** Published task and the release chain that owns its single execution. */
  execution?: CleanupExecution
}

interface CleanupExecution {
  readonly token: number
  readonly task: Promise<EffectCleanupFailure | undefined>
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
  /** Settles after forward work is closed and rollback tasks, if any, are published. */
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
  if (wouldWaitForInheritedDisposal(token)) {
    throw new EffectReentrantDisposeError(labels)
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

function wouldWaitForInheritedDisposal(token: number): boolean {
  const inherited = disposalContext.getStore()
  return inherited !== undefined && inherited.has(token) && runningDisposals.has(token)
}

/** Reject joining cleanup owned by an active release in the current asynchronous chain. */
function assertNoInheritedCleanup(
  records: readonly CleanupRecord[],
  labels: readonly string[],
): void {
  if (records.some(record =>
    record.execution !== undefined && wouldWaitForInheritedDisposal(record.execution.token))) {
    throw new EffectReentrantDisposeError(labels)
  }
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
 * Publish a serial cleanup chain before its first inverse can run.
 *
 * Every newly claimed record receives its shared task in one synchronous pass. Each task
 * waits for the newer record before invoking user code, which preserves strict LIFO even
 * when an inverse is asynchronous. A nested release that would join an inherited active
 * chain records a wait failure instead of deadlocking that chain.
 *
 * A rejected link would abort the remaining inverses, so the link handed to the next
 * record resolves on either settlement and the rejection stays with the task the batch
 * reports.
 *
 * @param records - Records in acceptance order.
 * @param token - Token of the release chain claiming new records.
 * @param labels - Labels reported if joining a record would create a wait cycle.
 * @returns Tasks in cleanup order.
 */
function publishRecords(
  records: readonly CleanupRecord[],
  token: number,
  labels: readonly string[],
): Promise<EffectCleanupFailure | undefined>[] {
  let previous = Promise.resolve()
  const published: Promise<EffectCleanupFailure | undefined>[] = []

  // Iterate in reverse order (LIFO) without allocating a new array
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]!
    let task: Promise<EffectCleanupFailure | undefined>
    if (record.execution === undefined) {
      task = previous.then(() => callRevert(record.operationLabel, record.revert))
      record.execution = { token, task }
    } else if (wouldWaitForInheritedDisposal(record.execution.token)) {
      task = Promise.resolve({
        operationLabel: record.operationLabel,
        stage: 'wait',
        reason: new EffectReentrantDisposeError(labels),
      })
    } else {
      task = record.execution.task
    }
    published.push(task)
    previous = task.then(() => undefined, () => undefined)
  }

  return published
}

/** Failures of one cleanup scope together with the inverses that scope ran itself. */
interface CleanupOutcome {
  /** Failures in the order the attempts were made. */
  readonly failures: EffectCleanupFailure[]
  /** Inverses this scope published and ran, excluding records another scope owned. */
  readonly attempted: number
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
 * @param token - Token of the release chain claiming new records.
 * @param labels - Labels reported if joining a record would create a wait cycle.
 * @returns Failures in the order the attempts were made, with the count this scope ran.
 */
async function runCleanupBatch(
  records: readonly CleanupRecord[],
  token: number,
  labels: readonly string[],
): Promise<CleanupOutcome> {
  const owned = records.filter(record => record.execution === undefined).length
  return { failures: await collectFailures(publishRecords(records, token, labels)), attempted: owned }
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
      const value = await Promise.resolve().then(operation)

      // Both stacks receive the inverse before this task is marked complete or the value
      // reaches setup, so a concurrent release cannot miss the acquired resource.
      const record: CleanupRecord = {
        operationLabel,
        revert: async () => {
          await revert(value)
        },
      }
      effect.local.push(record)
      owner.global.push(record)
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
 * value reaches the caller, is applied at most once, and is applied serially in the
 * reverse of the order it was accepted.
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
        token: nextDisposalToken++,
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
   * @throws {EffectDisposalFailedError} If an inverse fails or cleanup detects a wait cycle.
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
  await waitForOperations(effect)

  // Final checkpoint: the only place that decides whether this run returns a lease.
  if (outcome.status === 'fulfilled' && owner.state === 'accepting') {
    effect.resolveOwnerReady()
    return makeLease(effect, outcome.value)
  }

  effect.interrupted = outcome.status === 'fulfilled'
  const reason = outcome.status === 'rejected' ? outcome.reason : undefined
  const cleanup = runWithDisposalToken(effect.token, () => cleanupEffect(effect))
  effect.resolveOwnerReady()
  const { attempted, failures } = await cleanup
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
 * @returns Failures in the order the attempts were made.
 */
function cleanupEffect(effect: EffectRecord): Promise<CleanupOutcome> {
  return runCleanupBatch(
    effect.local,
    effect.token,
    [effect.label, effect.owner.label],
  )
}

async function releaseOwner(owner: EffectOwnerRecord): Promise<void> {
  try {
    await Promise.all([...owner.effects].map(effect => waitForForwardWork(effect)))
    const { failures } = await runCleanupBatch(owner.global, owner.token, [owner.label])
    if (failures.length > 0) {
      throw new EffectDisposalFailedError('owner', undefined, failures)
    }
  } finally {
    owner.state = 'disposed'
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

/**
 * Wait for the forward work the runtime tracks for one Effect.
 *
 * `ownerReady` settles only after setup has closed its acceptance entry, every admitted
 * operation has settled, and any startup rollback tasks are visible to the owner.
 *
 * @param effect - Effect whose forward work is awaited.
 */
async function waitForForwardWork(effect: EffectRecord): Promise<void> {
  await Promise.all([
    resolveAsSettled(effect.ownerReady),
    waitForOperations(effect),
  ])
}

async function waitForOperations(effect: EffectRecord): Promise<void> {
  while (effect.operations.size > 0) {
    await Promise.all([...effect.operations].map(promise => resolveAsSettled(promise)))
  }
}
