import { createDurableEventDefinition } from '../session/event-catalog.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { requireExactKeys, requireRecord } from './codec-fields.js'
import { decodeMessageEnvelope } from './envelope.js'
import type { MessageEnvelope } from './types.js'
import { decodeSendCommand, decodeSendKey } from './send-command.js'
import type { MessageSendCommand, MessageSendKey } from './send-command.js'

export interface KeyedOutboxAcceptedPayload extends JsonObject {
  readonly envelope: MessageEnvelope
  readonly sendKey: MessageSendKey
  readonly command: MessageSendCommand
}
function decode(value: JsonValue): KeyedOutboxAcceptedPayload {
  const input = requireRecord(value, 'keyed outbox acceptance')
  requireExactKeys(input, ['envelope', 'sendKey', 'command'], [], 'keyed outbox acceptance')
  return Object.freeze({ envelope: decodeMessageEnvelope(input.envelope!), sendKey: decodeSendKey(input.sendKey), command: decodeSendCommand(input.command) })
}
/** The command key and accepted envelope share one durable commit. */
export const keyedOutboxAcceptedEvent = createDurableEventDefinition({
  type: 'communication/outbox-accepted', payloadVersion: 2, ignorable: false, decode,
})
