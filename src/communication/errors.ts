import { HarnessError } from '../foundation/error.js'
import type { HarnessErrorOptions } from '../foundation/error.js'

/** Stable error codes raised by Session communication operations. */
export type CommunicationErrorCode =
  | 'MESSAGE_IDENTIFIER_INVALID'
  | 'MESSAGE_SEQUENCE_EXHAUSTED'
  | 'MESSAGE_CONFIG_INVALID'
  | 'MESSAGE_DEFINITION_INVALID'
  | 'MESSAGE_DEFINITION_CONFLICT'
  | 'MESSAGE_DEFINITION_UNREGISTERED'
  | 'MESSAGE_PAYLOAD_INVALID'
  | 'MESSAGE_ENVELOPE_INVALID'
  | 'MESSAGE_STATE_INVALID'
  | 'MESSAGE_NOT_FOUND'
  | 'MESSAGE_ID_CONFLICT'
  | 'MESSAGE_SEND_KEY_CONFLICT'
  | 'MESSAGE_SEND_JOURNAL_CONFLICT'
  | 'MESSAGE_SEND_FORBIDDEN'
  | 'MESSAGE_OUTBOX_FULL'
  | 'MESSAGE_PENDING'
  | 'MESSAGE_SESSION_ENDED'
  | 'MESSAGE_SESSION_CATALOG_INCOMPATIBLE'
  | 'MESSAGE_MAILBOX_ALREADY_ATTACHED'
  | 'MESSAGE_MAILBOX_FOREIGN'
  | 'MESSAGE_MAILBOX_INACTIVE'
  | 'MESSAGE_SERVICE_INACTIVE'
  | 'MESSAGE_DIRECTORY_CONFLICT'
  | 'MESSAGE_TRANSPORT_SOURCE_INVALID'
  | 'MESSAGE_OUTBOX_COMMIT_UNKNOWN'
  | 'MESSAGE_INBOX_COMMIT_UNKNOWN'
  | 'MESSAGE_OUTBOX_STATUS_COMMIT_UNKNOWN'
  | 'MESSAGE_INBOX_STATUS_COMMIT_UNKNOWN'

/** Structured failure raised by the communication subsystem. */
export class CommunicationError extends HarnessError<CommunicationErrorCode> {
  constructor(
    code: CommunicationErrorCode,
    message: string,
    options: HarnessErrorOptions = {},
  ) {
    super(code, message, options)
    this.name = 'CommunicationError'
  }
}
