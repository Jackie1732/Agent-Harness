import type { JsonObject, JsonValue } from '../foundation/json.js'
import { boundedJson } from '../schema/bounded-json.js'
import { parseSessionAddress, parseSessionEventId } from '../session/ids.js'
import type { SessionEventId } from '../session/ids.js'
import { requireExactKeys, requireRecord, requireString } from './codec-fields.js'
import { parseChannelId, parseMessageId } from './ids.js'
import type { MessageId } from './ids.js'
import type { MessageSendRequest } from './types.js'

export type MessageSendKey = { readonly eventId: SessionEventId; readonly index: number }
export type MessageCommandContent = { readonly type: string; readonly payloadVersion: number; readonly payload: JsonValue }
export type MessageSendCommand = MessageCommandContent & (
  | { readonly kind: 'send'; readonly request: MessageSendRequest }
  | { readonly kind: 'reply'; readonly inboxMessageId: MessageId }
)

function copy(value: unknown): JsonObject {
  return requireRecord(boundedJson(value, { maxBytes: 16 * 1024 * 1024, maxDepth: 64, maxNodes: 250000 }), 'send command')
}
export function decodeSendKey(value: unknown): MessageSendKey {
  const input = copy(value)
  requireExactKeys(input, ['eventId', 'index'], [], 'send key')
  const id = requireString(input.eventId, 'send event id'); parseSessionEventId(id)
  if (typeof input.index !== 'number' || !Number.isSafeInteger(input.index) || input.index < 0 || Object.is(input.index, -0)) throw new TypeError('send key index')
  return input as MessageSendKey
}
export function decodeSendRequest(value: unknown): MessageSendRequest {
  const input = copy(value)
  if (input.kind !== 'root' && input.kind !== 'derived') throw new TypeError('send request kind')
  requireExactKeys(input, input.kind === 'root' ? ['kind', 'recipient', 'channelId'] : ['kind', 'recipient', 'channelId', 'correlationId', 'causationId'], [], 'send request')
  parseSessionAddress(requireString(input.recipient, 'recipient')); parseChannelId(requireString(input.channelId, 'channel'))
  if (input.kind === 'derived') {
    parseMessageId(requireString(input.correlationId, 'correlation')); parseMessageId(requireString(input.causationId, 'causation'))
  }
  return input as MessageSendRequest
}
/** Raw commands are copied independently from decoder-normalized envelopes. */
export function decodeSendCommand(value: unknown): MessageSendCommand {
  const input = copy(value)
  if (input.kind !== 'send' && input.kind !== 'reply') throw new TypeError('send command kind')
  requireExactKeys(input, ['kind', 'type', 'payloadVersion', 'payload', input.kind === 'send' ? 'request' : 'inboxMessageId'], [], 'send command')
  const type = requireString(input.type, 'message type')
  if (type.length === 0 || type.length > 128 || !Number.isSafeInteger(input.payloadVersion) || Number(input.payloadVersion) < 1) throw new TypeError('message type/version')
  if (input.kind === 'send') decodeSendRequest(input.request)
  else parseMessageId(requireString(input.inboxMessageId, 'inbox id'))
  return input as MessageSendCommand
}
export function sendKeyText(key: MessageSendKey): string { return `${key.eventId}#${key.index}` }
