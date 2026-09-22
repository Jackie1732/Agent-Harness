import { actionReference } from '../agent/input-codec.js'
import { agentJson, choice, eventId, exact, integer, record, text, timestamp } from '../agent/validation.js'
import { decodeSendCommand } from '../communication/send-command.js'
import { decodeIntentReference } from '../model/request.js'
import { parseSessionAddress } from '../session/ids.js'
import type { SubagentInputDisposed, SubagentMessageClassified, SubagentProtocolRecorded } from './event-contract.js'
import { decodeSubagentMessage, subagentMessageKinds } from './messages.js'

const common = ['delegation', 'parentAddress', 'childAddress'] as const
function identity(input: ReturnType<typeof record>): void {
  eventId(input.delegation); parseSessionAddress(text(input.parentAddress)); parseSessionAddress(text(input.childAddress))
  if (input.parentAddress === input.childAddress) throw new TypeError('same-session')
}
export function decodeSubagentProtocolRecorded(value: unknown): SubagentProtocolRecorded {
  const input = record(agentJson(value)); exact(input, [...common, 'kind', 'ordinal', 'command', 'source', 'observedAt'])
  identity(input); const kind = choice(input.kind, subagentMessageKinds); integer(input.ordinal, 1); timestamp(input.observedAt)
  const command = decodeSendCommand(input.command)
  if (command.type !== `subagent/${kind}` || command.payloadVersion !== 1) throw new TypeError('protocol-message-version')
  const body = decodeSubagentMessage(kind, command.payload)
  if (body.delegation !== input.delegation) throw new TypeError('protocol-delegation')
  const source = record(input.source)
  switch (source.kind) {
    case 'action': exact(source, ['kind', 'action', 'intent']); actionReference(source.action); decodeIntentReference(source.intent); break
    case 'delegation': exact(source, ['kind', 'requested']); eventId(source.requested); break
    case 'terminal': exact(source, ['kind', 'turn', 'release']); eventId(source.turn); eventId(source.release); break
    default: throw new TypeError('protocol-source')
  }
  return input as SubagentProtocolRecorded
}
export function decodeSubagentMessageClassified(value: unknown): SubagentMessageClassified {
  const input = record(agentJson(value)); exact(input, [...common, 'inbox', 'kind', 'classification', 'reasonCode'])
  identity(input); eventId(input.inbox); choice(input.kind, subagentMessageKinds)
  choice(input.classification, ['eligible', 'progress-only', 'rejected']); text(input.reasonCode, 128)
  return input as SubagentMessageClassified
}
export function decodeSubagentInputDisposed(value: unknown): SubagentInputDisposed {
  const input = record(agentJson(value)); exact(input, [...common, 'input', 'disposition', 'reasonCode'])
  identity(input); eventId(input.input); choice(input.disposition, ['handled', 'not-adopted']); text(input.reasonCode, 128)
  return input as SubagentInputDisposed
}
