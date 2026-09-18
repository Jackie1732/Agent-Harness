import type { ModelToolDefinition } from '../model/contract.js'
import { snapshotJson } from '../foundation/json.js'
import type { AgentNativeActionName } from './contract.js'

const text = { type: 'string' } as const
const message = { type: text, payloadVersion: { type: 'integer' }, payloadJson: text } as const
const deadline = { timeoutMs: { type: 'integer' } } as const
const schemas = {
  agent_send_message: { peerKey: text, ...message },
  agent_reply_message: { messageId: text, ...message },
  agent_await_reply: { messageId: text, ...deadline },
  agent_ask_user: { question: text, ...deadline },
} as const
const descriptions = {
  agent_send_message: 'Accept a message into the local outbox for a configured peer. Acceptance does not confirm delivery.',
  agent_reply_message: 'Accept a reply to the current claimed peer input. Acceptance does not confirm delivery.',
  agent_await_reply: 'Wait for an exact reply to a message sent by this root task. This must be the only call in this response.',
  agent_ask_user: 'Record a question and wait for a user answer. This must be the only call in this response.',
} as const

/** Native protocol surfaces are fixed data; they carry no Tool execution rights. */
export function agentNativeToolDefinitions(names: readonly AgentNativeActionName[]): readonly ModelToolDefinition[] {
  return names.map(name => Object.freeze({ name, description: descriptions[name], inputSchema: snapshotJson({
    type: 'object', properties: schemas[name], required: Object.keys(schemas[name]), additionalProperties: false,
  }) as ModelToolDefinition['inputSchema'] }))
}
