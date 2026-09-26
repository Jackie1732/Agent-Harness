import type { AgentActionIntent, AgentActionSettled } from '../agent/event-contract.js'
import { originalAgentActionArguments } from '../agent/model-source.js'
import type { AgentProjectionState } from '../agent/projection-state.js'
import { requireEntry, requireSpec } from '../agent/projection-state.js'
import { equal, eventId, exact, integer } from '../agent/validation.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { SubagentError } from './errors.js'

/** Validate new action results against the accepted request or exact persisted protocol intent. */
export function validateSubagentActionSource(state: AgentProjectionState, event: CommittedSessionEvent<AgentActionSettled>, intent: AgentActionIntent | null): void {
  const result = event.payload.result
  if (intent === null) invalid('subagent-action-required')
  const step = [...state.steps.values()].find(item => item.decided?.stored.eventId === event.payload.action.eventId)
  const turn = step === undefined ? undefined : state.turns.get(step.opened.payload.turn)
  if (turn === undefined) invalid('subagent-turn-required')
  const spec = requireSpec(state).payload
  if (spec.protocolVersion === 1) invalid('subagent-spec-required')
  const root = requireEntry(state.roots, turn.root, 'missing-root')
  if (result.kind === 'protocol-accepted') {
    const protocol = requireEntry(state.subagents.protocol, result.protocol, 'missing-progress-intent')
    if (intent.route !== 'progress' || protocol.payload.kind !== 'progress' || protocol.payload.source.kind !== 'action'
      || !equal(protocol.payload.source.action, event.payload.action) || !equal(protocol.payload.source.intent, intent.source)) invalid('progress-source')
    return
  }
  if (result.kind !== 'wait' || result.descriptor.kind !== 'delegation' && result.descriptor.kind !== 'parent-answer') invalid('subagent-result-kind')
  const descriptor = result.descriptor
  const request = state.subagents.delegations.get(descriptor.delegation)?.payload
    ?? (state.subagents.bound?.payload.delegation === descriptor.delegation ? state.subagents.bound.payload.requested : undefined)
  if (request === undefined || root.id !== descriptor.root
    || !equal(descriptor.protectedTurns, [...state.turns.values()].filter(item => item.root === root.id).map(item => item.started.stored.eventId))) invalid('subagent-wait-root')
  const args = originalAgentActionArguments(state, intent)
  if (intent.route === 'spawn') {
    if (descriptor.kind !== 'delegation' || request.parentRoot !== root.id || request.source.kind !== 'model'
      || !equal(request.source.action, event.payload.action) || !equal(args, request.request)
      || descriptor.observedAt !== request.observedAt || descriptor.deadline !== request.deadline) invalid('spawn-wait-source')
    return
  }
  exact(args, intent.route === 'ask-parent' ? ['question', 'timeoutMs'] : intent.route === 'answer-subagent'
    ? ['delegationId', 'questionMessageId', 'text', 'timeoutMs'] : ['delegationId', 'timeoutMs'])
  const timeout = integer(args.timeoutMs, 1, spec.limits.maxWaitMs)
  const deadline = new Date(Math.min(Date.parse(descriptor.observedAt) + timeout, Date.parse(root.deadline), Date.parse(request.deadline))).toISOString()
  if (descriptor.deadline !== deadline) invalid('subagent-wait-deadline')
  if (descriptor.kind === 'delegation') {
    if (request.parentRoot !== root.id || eventId(args.delegationId) !== descriptor.delegation || !['await-subagent', 'answer-subagent'].includes(intent.route)) invalid('delegation-wait-source')
  } else if (intent.route !== 'ask-parent') invalid('parent-answer-route')
  if (intent.route !== 'await-subagent') {
    const protocol = [...state.subagents.protocol.values()].find(item => item.payload.source.kind === 'action' && equal(item.payload.source.action, event.payload.action))
    if (protocol === undefined || protocol.payload.delegation !== descriptor.delegation
      || protocol.payload.kind !== (intent.route === 'ask-parent' ? 'question' : 'answer')
      || protocol.payload.observedAt !== descriptor.observedAt
      || descriptor.kind === 'parent-answer' && descriptor.question !== protocol.stored.eventId) invalid('subagent-wait-intent')
  }
}
function invalid(reason: string): never { throw new SubagentError('SUBAGENT_STATE_INVALID', reason) }
