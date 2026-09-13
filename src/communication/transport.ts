import type { SessionDirectory } from './directory.js'
import { resolveDirectoryReceiver } from './directory.js'
import { CommunicationError } from './errors.js'
import { decodeMessageEnvelope } from './envelope.js'
import type { MessageDeliveryOutcome, MessageEnvelope } from './types.js'

/** One delivery provider. It records no sender or recipient Session events itself. */
export interface MessageTransport {
  /** Attempt delivery for a sender-authenticated pending Envelope. */
  deliver(
    envelope: MessageEnvelope,
    options: { readonly signal: AbortSignal },
  ): Promise<MessageDeliveryOutcome>
  /** Stop accepting new delivery attempts. */
  dispose(): Promise<void>
}

/** Build the process-local Transport backed by private Directory routes. */
export function createInProcessMessageTransport(directory: SessionDirectory): MessageTransport {
  let active = true
  return Object.freeze({
    async deliver(envelope: MessageEnvelope, options: { readonly signal: AbortSignal }) {
      if (!active) return Object.freeze({ kind: 'retry' as const, code: 'transport-outcome-unknown' as const })
      const candidate = decodeMessageEnvelope(envelope)
      const source = resolveDirectoryReceiver(directory, candidate.sender)
      if (source.status.kind !== 'online' || source.receiver === undefined || !source.receiver.verifyDeliveryAttempt(candidate)) {
        throw new CommunicationError(
          'MESSAGE_TRANSPORT_SOURCE_INVALID',
          'Transport could not authenticate the active sender attempt',
          { details: { messageId: candidate.messageId, sender: candidate.sender } },
        )
      }
      if (options.signal.aborted) {
        return Object.freeze({ kind: 'retry' as const, code: 'attempt-interrupted' as const })
      }
      const target = resolveDirectoryReceiver(directory, candidate.recipient)
      switch (target.status.kind) {
        case 'unknown':
          return Object.freeze({ kind: 'rejected', code: 'recipient-unknown' })
        case 'known-offline':
          return Object.freeze({ kind: 'retry', code: 'recipient-offline' })
        case 'ended':
          return Object.freeze({ kind: 'rejected', code: 'recipient-ended' })
        case 'online':
          break
      }
      try {
        return await target.receiver!.acceptDelivery(candidate, candidate.sender, options.signal)
      } catch (cause) {
        if (cause instanceof CommunicationError && cause.code === 'MESSAGE_INBOX_COMMIT_UNKNOWN') {
          return Object.freeze({ kind: 'retry', code: 'receiver-outcome-unknown' })
        }
        return Object.freeze({ kind: 'retry', code: 'transport-outcome-unknown' })
      }
    },
    async dispose() {
      active = false
    },
  })
}
