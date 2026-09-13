import { HarnessError } from '../foundation/error.js'
import type { HarnessErrorOptions } from '../foundation/error.js'

/** Stable error codes produced by the durable Session subsystem. */
export type SessionErrorCode =
  | 'SESSION_IDENTIFIER_INVALID'
  | 'SESSION_POSITION_INVALID'
  | 'SESSION_NOT_FOUND'
  | 'SESSION_ALREADY_EXISTS'
  | 'SESSION_REPOSITORY_INACTIVE'
  | 'SESSION_HANDLE_INACTIVE'
  | 'SESSION_WRITE_LEASED'
  | 'SESSION_POSITION_CONFLICT'
  | 'SESSION_RECORD_TOO_LARGE'
  | 'SESSION_EVENT_DEFINITION_CONFLICT'
  | 'SESSION_EVENT_UNREGISTERED'
  | 'SESSION_EVENT_INVALID'
  | 'SESSION_ENDED'
  | 'SESSION_FORMAT_UNSUPPORTED'
  | 'SESSION_ENVELOPE_UNSUPPORTED'
  | 'SESSION_EVENT_UNSUPPORTED'
  | 'SESSION_LOG_INVALID'
  | 'SESSION_APPEND_OUTCOME_UNKNOWN'
  | 'SESSION_PROJECTION_FAILED'
  | 'SESSION_LINEAGE_INVALID'
  | 'SESSION_LINEAGE_LIMIT'

/** Structured failure raised by durable Session operations. */
export class SessionError extends HarnessError<SessionErrorCode> {
  constructor(code: SessionErrorCode, message: string, options: HarnessErrorOptions = {}) {
    super(code, message, options)
    this.name = 'SessionError'
  }
}
