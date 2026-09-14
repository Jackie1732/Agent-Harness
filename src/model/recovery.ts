import type { SessionHandle } from '../session/session-handle.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { ModelError } from './errors.js'
import { parseModelInvocationId } from './ids.js'
import type { ModelInvocationId } from './ids.js'
import { ModelJournal } from './journal.js'
import type { ModelSettlement } from './settlement.js'

export interface ModelRecoveryOptions {
  readonly invocationId: ModelInvocationId
  /** Explicit administrative assertion, not a distributed fencing proof. */
  readonly predecessorStopped: true
  readonly maxJournalConflicts: number
}

/** Record interruption only after the old driver/Writer or process is known stopped. */
export async function recoverModelInvocation(
  handle: SessionHandle, options: ModelRecoveryOptions,
): Promise<CommittedSessionEvent<ModelSettlement>> {
  parseModelInvocationId(options.invocationId)
  if (options.predecessorStopped !== true || !Number.isSafeInteger(options.maxJournalConflicts) || options.maxJournalConflicts < 0) {
    throw new ModelError('MODEL_REQUEST_INVALID', 'recovery requires explicit predecessor-stop confirmation and a conflict budget')
  }
  const journal = new ModelJournal(handle, options.maxJournalConflicts)
  return await journal.interrupt(options.invocationId)
}
