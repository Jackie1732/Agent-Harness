import { AsyncLocalStorage } from 'node:async_hooks'
import { EffectReentrantDisposeError } from './errors.js'
import type { EffectCleanupFailure } from './errors.js'

/** An accepted inverse, replaced by its single execution when claimed. */
export interface CleanupRecord {
  readonly operationLabel: string
  readonly retainedBy: Set<CleanupRecord>
  state:
    | { readonly kind: 'pending'; readonly revert: () => Promise<void> }
    | { readonly kind: 'claimed'; readonly token: number; readonly task: Promise<EffectCleanupFailure | undefined> }
    | { readonly kind: 'settled'; readonly task: Promise<EffectCleanupFailure | undefined> }
}

/** Ordered failures and the number of inverses this release claimed itself. */
export interface CleanupOutcome {
  readonly failures: EffectCleanupFailure[]
  readonly attempted: number
}

const disposalContext = new AsyncLocalStorage<ReadonlySet<number>>()
const runningDisposals = new Set<number>()
let nextDisposalToken = 1

/**
 * Allocate a token identifying one Owner or Effect release.
 * @returns The private release token.
 */
export function createDisposalToken(): number {
  return nextDisposalToken++
}

/**
 * Run a release with its active token and every token inherited from its caller.
 * @param token - Token of the release being started.
 * @param task - Release work.
 * @returns The release outcome.
 */
export function runWithDisposalToken<T>(token: number, task: () => Promise<T>): Promise<T> {
  const tokens = new Set(disposalContext.getStore())
  tokens.add(token)
  return disposalContext.run(tokens, async () => {
    runningDisposals.add(token)
    try {
      return await task()
    } finally {
      runningDisposals.delete(token)
    }
  })
}

function wouldWaitForInheritedDisposal(token: number): boolean {
  return disposalContext.getStore()?.has(token) === true && runningDisposals.has(token)
}

/**
 * Reject joining the release currently running this asynchronous call chain.
 * @param token - Token of the requested release.
 * @param labels - Owning scope labels for the diagnostic.
 */
export function assertNotReentrant(token: number, labels: readonly string[]): void {
  if (wouldWaitForInheritedDisposal(token)) throw new EffectReentrantDisposeError(labels)
}

/**
 * Reject joining cleanup owned by an active release inherited by this call chain.
 * @param records - Cleanup records of the requested release.
 * @param labels - Owning scope labels for the diagnostic.
 */
export function assertNoInheritedCleanup(records: Iterable<CleanupRecord>, labels: readonly string[]): void {
  for (const record of records) {
    if (record.state.kind === 'claimed' && wouldWaitForInheritedDisposal(record.state.token)) {
      throw new EffectReentrantDisposeError(labels)
    }
  }
}

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
 * Publish shared tasks before running inverses, then release successful records.
 * Newly claimed inverses run serially in reverse acceptance order. Failed records
 * retain their original failure for a later Owner release, without retaining the inverse.
 * @param records - Cleanup records in acceptance order.
 * @param token - Token claiming the new inverse executions.
 * @returns Ordered failures and the number of newly claimed inverses.
 */
export async function runCleanupBatch(
  records: readonly CleanupRecord[],
  token: number,
): Promise<CleanupOutcome> {
  let previous = Promise.resolve()
  let attempted = 0
  const published: { record: CleanupRecord; task: Promise<EffectCleanupFailure | undefined> }[] = []
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]!
    if (record.state.kind === 'pending') {
      const revert = record.state.revert
      const task: Promise<EffectCleanupFailure | undefined> = previous.then(async () => {
        const failure = await callRevert(record.operationLabel, revert)
        record.state = { kind: 'settled', task }
        return failure
      })
      record.state = { kind: 'claimed', token, task }
      attempted++
    }
    const task = record.state.task
    published.push({ record, task })
    previous = task.then(() => undefined)
  }

  const results = await Promise.all(published.map(({ task }) => task))
  const failures: EffectCleanupFailure[] = []
  published.forEach(({ record }, index) => {
    const failure = results[index]
    if (failure === undefined) record.retainedBy.delete(record)
    else failures.push(failure)
  })
  return { failures, attempted }
}
