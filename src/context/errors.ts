import { HarnessError } from '../foundation/error.js'
import type { JsonObject } from '../foundation/json.js'

export type ContextErrorCode =
  | 'CONTEXT_REQUEST_INVALID' | 'CONTEXT_SOURCE_INVALID' | 'CONTEXT_STATE_INVALID'
  | 'CONTEXT_REVISION_CONFLICT' | 'CONTEXT_SOURCE_CHANGED' | 'CONTEXT_SESSION_BUSY'
  | 'CONTEXT_INACTIVE' | 'CONTEXT_JOURNAL_COMMIT_UNKNOWN' | 'CONTEXT_JOURNAL_WRITE_FAILED'

/** Only bounded identifiers/rule names/counters belong in diagnostics; never raw inputs. */
export class ContextError extends HarnessError<ContextErrorCode> {
  constructor(code: ContextErrorCode, rule: string, details?: JsonObject) {
    super(code, `context rejected ${rule}`, details === undefined ? {} : { details })
    this.name = 'ContextError'
  }
}

export function invalidContext(rule: string): never {
  throw new ContextError('CONTEXT_REQUEST_INVALID', rule)
}
export function invalidSource(rule: string): never {
  throw new ContextError('CONTEXT_SOURCE_INVALID', rule)
}
export function invalidState(rule: string): never {
  throw new ContextError('CONTEXT_STATE_INVALID', rule)
}
export function assertNever(value: never): never {
  void value
  return invalidState('unreachable-variant')
}
