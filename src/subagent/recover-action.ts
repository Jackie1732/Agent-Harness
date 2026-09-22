import type { AgentActionReference } from '../agent/contract.js'
import type { AgentActionIntent, AgentActionResult } from '../agent/event-contract.js'
import type { AgentSessionSnapshot } from '../agent/state.js'
import { foldAgentSession } from '../agent/projection.js'
import { originalAgentActionArguments } from '../agent/model-source.js'
import { equal, integer } from '../agent/validation.js'
import type { SessionSnapshot } from '../session/types.js'

/** Recover accepted native effects from their exact intent; no service, clock or new request is involved. */
export function recoverSubagentAction(snapshot: SessionSnapshot, state: AgentSessionSnapshot,
  action: AgentActionReference, intent: AgentActionIntent): AgentActionResult | undefined {
  const requested = state.subagents.delegations.find(item => item.payload.source.kind === 'model' && equal(item.payload.source.action, action))
  const protocol = state.subagents.protocol.find(item => item.payload.source.kind === 'action' && equal(item.payload.source.action, action))
  if (requested === undefined && protocol === undefined) return undefined
  if (protocol?.payload.kind === 'progress') return { kind: 'protocol-accepted', protocol: protocol.stored.eventId }
  const step = state.steps.find(item => item.decided?.stored.eventId === action.eventId)!
  const turn = state.turns.find(item => item.started.stored.eventId === step.opened.payload.turn)!
  const root = state.roots.find(item => item.id === turn.root)!
  const delegation = requested?.stored.eventId ?? protocol!.payload.delegation
  const request = requested?.payload ?? state.subagents.delegations.find(item => item.stored.eventId === delegation)?.payload ?? state.subagents.bound!.payload.requested
  const observedAt = requested?.payload.observedAt ?? protocol!.payload.observedAt
  const args = originalAgentActionArguments(foldAgentSession(snapshot), intent)
  const deadline = requested !== undefined ? request.deadline : new Date(Math.min(Date.parse(observedAt) + integer(args.timeoutMs, 1, state.spec!.payload.limits.maxWaitMs), Date.parse(root.deadline), Date.parse(request.deadline))).toISOString()
  const common = { root: root.id, delegation, observedAt, deadline, protectedTurns: state.turns.filter(item => item.root === root.id).map(item => item.started.stored.eventId) }
  return { kind: 'wait', descriptor: protocol?.payload.kind === 'question' ? { ...common, kind: 'parent-answer', question: protocol.stored.eventId } : { ...common, kind: 'delegation' } }
}
