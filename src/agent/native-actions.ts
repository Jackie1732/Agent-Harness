import type { ModelToolDefinition } from '../model/contract.js'
import { snapshotJson } from '../foundation/json.js'
import type { AgentNativeActionName } from './contract.js'

const text = { type: 'string' } as const
const message = { type: text, payloadVersion: { type: 'integer' }, payloadJson: text } as const
const deadline = { timeoutMs: { type: 'integer' } } as const
const budgetProperties = Object.fromEntries(['models', 'steps', 'tools', 'messages', 'waits', 'outputTokens'].map(key => [key, { type: 'integer' }]))
const paths = { type: 'array', items: text } as const
const schemas = {
  agent_send_message: { peerKey: text, ...message },
  agent_reply_message: { messageId: text, ...message },
  agent_await_reply: { messageId: text, ...deadline },
  agent_ask_user: { question: text, ...deadline },
  agent_spawn_subagent: {
    templateKey: text, templateVersion: { type: 'integer' }, task: text,
    materials: { type: 'array', items: { type: 'object', properties: { label: text, text }, required: ['label', 'text'], additionalProperties: false } },
    requestedBudget: { type: 'object', properties: budgetProperties, required: Object.keys(budgetProperties), additionalProperties: false },
    workspace: { type: 'object', oneOf: [
      { type: 'object', properties: { kind: { type: 'string', enum: ['none'] } }, required: ['kind'], additionalProperties: false },
      { type: 'object', properties: { kind: { type: 'string', enum: ['shared-read', 'exclusive-write'] }, resourceId: text, readFiles: paths, writePrefixes: paths },
        required: ['kind', 'resourceId', 'readFiles', 'writePrefixes'], additionalProperties: false },
    ] },
  },
  agent_await_subagent: { delegationId: text, ...deadline },
  agent_answer_subagent: { delegationId: text, questionMessageId: text, text, ...deadline },
  agent_ask_parent: { question: text, ...deadline },
  agent_report_progress: { text },
} as const
const descriptions = {
  agent_send_message: 'Accept a message into the local outbox for a configured peer. Acceptance does not confirm delivery.',
  agent_reply_message: 'Accept a reply to the current claimed peer input. Acceptance does not confirm delivery.',
  agent_await_reply: 'Wait for an exact reply to a message sent by this root task. This must be the only call in this response.',
  agent_ask_user: 'Record a question and wait for a user answer. This must be the only call in this response.',
  agent_spawn_subagent: 'Delegate a bounded task to an authorized child template and wait for its question or result. This must be the only call in this response.',
  agent_await_subagent: 'Wait for an unadopted question or result of this root task\'s delegation. This must be the only call in this response.',
  agent_answer_subagent: 'Answer the exact adopted child question and wait for its continuation. This must be the only call in this response.',
  agent_ask_parent: 'Ask the parent a bounded question and wait for its exact answer. This must be the only call in this response.',
  agent_report_progress: 'Record bounded progress for the parent without starting a parent model turn. Acceptance does not confirm delivery.',
} as const

/** Native protocol surfaces are fixed data; they carry no Tool execution rights. */
export function agentNativeToolDefinitions(names: readonly AgentNativeActionName[]): readonly ModelToolDefinition[] {
  return names.map(name => Object.freeze({ name, description: descriptions[name], inputSchema: snapshotJson({
    type: 'object', properties: schemas[name], required: Object.keys(schemas[name]), additionalProperties: false,
  }) as ModelToolDefinition['inputSchema'] }))
}
