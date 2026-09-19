import { assertNever } from '../foundation/never.js'
import type { SessionAddress } from '../session/ids.js'
import type { SessionDirectory } from './directory.js'
import { resolveDirectoryReceiver } from './directory.js'
import { decodeMessageEnvelope } from './envelope.js'
import { CommunicationError } from './errors.js'
import type { MessageTransport } from './transport.js'
import type { MessageDeliveryOutcome, MessageEnvelope } from './types.js'

export type MessageRoute =
  | { readonly kind: 'local' }
  | { readonly kind: 'remote'; readonly transport: MessageTransport }
  | { readonly kind: 'unavailable' }

export type MessageRouteResolver = (recipient: SessionAddress) => MessageRoute

async function deliverLocal(
  directory: SessionDirectory,
  envelope: MessageEnvelope,
  signal: AbortSignal,
): Promise<MessageDeliveryOutcome> {
  const target = resolveDirectoryReceiver(directory, envelope.recipient)
  switch (target.status.kind) {
    case 'unknown': return Object.freeze({ kind: 'rejected', code: 'recipient-unknown' })
    case 'known-offline': return Object.freeze({ kind: 'retry', code: 'recipient-offline' })
    case 'ended': return Object.freeze({ kind: 'rejected', code: 'recipient-ended' })
    case 'online': break
    default: return assertNever(target.status, 'Directory status')
  }
  if (target.receiver === undefined) throw new CommunicationError('MESSAGE_DIRECTORY_CONFLICT', 'online recipient route has no receiver')
  try { return await target.receiver.acceptDelivery(envelope, envelope.sender, signal) }
  catch (cause) {
    if (cause instanceof CommunicationError && cause.code === 'MESSAGE_INBOX_COMMIT_UNKNOWN') {
      return Object.freeze({ kind: 'retry', code: 'receiver-outcome-unknown' })
    }
    if (cause instanceof CommunicationError) throw cause
    return Object.freeze({ kind: 'retry', code: 'transport-outcome-unknown' })
  }
}

/** Authenticate the active local attempt once, then select a fixed local or remote route. */
export function createRoutedMessageTransport(directory: SessionDirectory, resolve: MessageRouteResolver): MessageTransport {
  let active = true
  return Object.freeze({
    async deliver(value: MessageEnvelope, options: { readonly signal: AbortSignal }) {
      if (!active) return Object.freeze({ kind: 'retry' as const, code: 'transport-outcome-unknown' as const })
      const envelope = decodeMessageEnvelope(value)
      const source = resolveDirectoryReceiver(directory, envelope.sender)
      if (source.status.kind !== 'online' || source.receiver === undefined || !source.receiver.verifyDeliveryAttempt(envelope)) {
        throw new CommunicationError('MESSAGE_TRANSPORT_SOURCE_INVALID', 'Transport could not authenticate the active sender attempt', {
          details: { messageId: envelope.messageId, sender: envelope.sender },
        })
      }
      if (options.signal.aborted) return Object.freeze({ kind: 'retry' as const, code: 'attempt-interrupted' as const })
      const route = resolve(envelope.recipient)
      if (route.kind === 'local') return await deliverLocal(directory, envelope, options.signal)
      if (route.kind === 'remote') {
        try { return await route.transport.deliver(envelope, options) }
        catch (cause) {
          if (cause instanceof CommunicationError && cause.code === 'MESSAGE_TRANSPORT_SOURCE_INVALID') {
            throw new CommunicationError(cause.code, cause.message, {
              details: { recipient: envelope.recipient }, cause,
            })
          }
          throw cause
        }
      }
      return Object.freeze({ kind: 'retry' as const, code: 'recipient-offline' as const })
    },
    async dispose() { active = false },
  })
}
