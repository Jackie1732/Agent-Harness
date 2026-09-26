import { parseMessageId } from '../communication/ids.js'
import { workflowReference } from '../workflow/work-binding.js'
import type { AgentActionReference, AgentInput, AgentInputReference, AgentSendCommand, AgentWaitDescriptor } from './contract.js'
import { AgentError } from './errors.js'
import { agentJson, array, choice, eventId, exact, integer, record, text, timestamp, unique } from './validation.js'

export function actionReference(value: unknown): AgentActionReference {
  const input = record(value); exact(input, ['eventId', 'index']); eventId(input.eventId); integer(input.index, 0, 63)
  return input as AgentActionReference
}
export function inputReference(value: unknown, version: 1 | 2 | 3 = 1): AgentInputReference {
  const input = record(agentJson(value)); exact(input, ['kind', 'eventId']); choice(input.kind, version === 1 ? ['user', 'peer'] : version === 2 ? ['user', 'peer', 'subagent'] : ['user', 'peer', 'subagent', 'workflow']); eventId(input.eventId)
  return input as AgentInputReference
}
export function referenceKey(reference: AgentActionReference): string { return `${reference.eventId}#${reference.index}` }
export function inputKey(reference: AgentInputReference): string { return `${reference.kind}:${reference.eventId}` }

export function decodeAgentInput(value: unknown): AgentInput {
  try {
    const input = record(agentJson(value))
    const kind = choice(input.kind, ['task', 'answer'])
    exact(input, kind === 'task' ? ['kind', 'text', 'originLabel'] : ['kind', 'text', 'originLabel', 'wait'])
    text(input.text, 1024 * 1024); text(input.originLabel, 128)
    if (kind === 'answer') actionReference(input.wait)
    return input as AgentInput
  } catch { throw new AgentError('AGENT_INPUT_INVALID', 'invalid-agent-input') }
}

export function decodeAgentCommand(value: unknown): AgentSendCommand {
  const input = record(agentJson(value))
  const kind = choice(input.kind, ['send', 'reply'])
  exact(input, ['kind', kind === 'send' ? 'peerKey' : 'messageId', 'type', 'payloadVersion', 'payloadJson'])
  if (kind === 'send') text(input.peerKey, 128)
  else parseMessageId(text(input.messageId))
  text(input.type, 128); integer(input.payloadVersion, 1); text(input.payloadJson, 1024 * 1024)
  return input as AgentSendCommand
}

export function decodeWaitDescriptor(value: unknown, version: 1 | 2 | 3 = 1): AgentWaitDescriptor {
  const input = record(value)
  const kind = choice(input.kind, version === 1 ? ['user', 'reply'] : ['user', 'reply', 'delegation', 'parent-answer', ...(version === 3 ? ['work-message', 'work-answer', 'work-group'] as const : [])])
  const fields = kind === 'user' ? ['question'] : kind === 'reply' ? ['messageId', 'outboxEventId']
    : kind === 'delegation' ? ['delegation'] : kind === 'work-message' ? ['assignment', 'receive'] : kind === 'work-answer' || kind === 'work-group' ? ['request', 'interaction'] : ['delegation', 'question']
  exact(input, ['kind', 'root', 'deadline', 'observedAt', 'protectedTurns', ...fields])
  timestamp(input.observedAt)
  eventId(input.root); timestamp(input.deadline); unique(array(input.protectedTurns).map(eventId))
  if (kind === 'user') text(input.question, 1024 * 1024)
  else if (kind === 'reply') { parseMessageId(text(input.messageId)); eventId(input.outboxEventId) }
  else if (kind === 'work-message') { workflowReference(input.assignment); choice(input.receive, ['question', 'group', 'either']) }
  else if (kind === 'work-answer' || kind === 'work-group') { eventId(input.request); workflowReference(input.interaction) }
  else { eventId(input.delegation); if (kind === 'parent-answer') eventId(input.question) }
  return input as AgentWaitDescriptor
}
