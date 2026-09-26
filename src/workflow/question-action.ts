import type { AgentActionReference, AgentWaitDescriptor } from '../agent/contract.js'
import type { AgentActionResult } from '../agent/event-contract.js'
import type { AgentProjectionState } from '../agent/projection-state.js'
import { choice, exact, integer, text } from '../agent/validation.js'
import { workActionSource } from './action-source.js'
import { workQuestionRequestedEvent, workInteractionResolvedEvent } from './interaction-events.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { Clock } from '../foundation/clock.js'
import type { JsonObject } from '../foundation/json.js'
import { clockTimestamp } from '../foundation/clock.js'
import { AgentJournal } from '../agent/journal.js'
import { foldAgentSession } from '../agent/projection.js'
import type { InteractionAdmission, InteractionRejection } from './interactions.js'
import type { WorkflowEventRef } from './types.js'
import { sameWorkflowValue } from './work-binding.js'
import { invalidHistory, WorkflowError } from './errors.js'
import { formatSessionAddress } from '../session/ids.js'

export interface WorkInteractionAuthority {
  admit(request: CommittedSessionEvent<ReturnType<typeof workQuestionRequestedEvent.decode>>): Promise<InteractionRejection
    | { readonly outcome: 'admitted'; readonly admission: WorkflowEventRef; readonly value: InteractionAdmission }>
}

export function questionIntent(state: AgentProjectionState, action: AgentActionReference, observedAt: string) {
  const { intent, root, binding, accepted, args } = workActionSource(state, action)
  if (root.stopControl !== null) throw new WorkflowError('WORKFLOW_ADMISSION_BLOCKED', 'work-root-stopped')
  if (intent.route !== 'work-ask') invalidHistory('work-question-action')
  exact(args, ['targetNodeKey', 'text', 'timeoutMs'])
  const timeout = integer(args.timeoutMs, 1, Math.min(state.spec!.payload.limits.maxWaitMs, binding.recipe.limits.maxWaitMs))
  return { kind: 'question' as const, assignment: binding.assignment, accepted, root: root.id, action,
    targetNodeKey: text(args.targetNodeKey, 128), text: text(args.text, binding.recipe.limits.maxTextBytes), observedAt,
    deadline: new Date(Math.min(Date.parse(observedAt) + timeout, Date.parse(root.deadline))).toISOString() }
}

export function workReceiveDescriptor(state: AgentProjectionState, action: AgentActionReference, observedAt: string): AgentWaitDescriptor {
  const { root, binding, args } = workActionSource(state, action)
  exact(args, ['kind', 'timeoutMs'])
  const timeout = integer(args.timeoutMs, 1, Math.min(state.spec!.payload.limits.maxWaitMs, binding.recipe.limits.maxWaitMs))
  return { kind: 'work-message', assignment: binding.assignment, receive: choice(args.kind, ['question', 'group', 'either']), root: root.id, observedAt,
    deadline: new Date(Math.min(Date.parse(observedAt) + timeout, Date.parse(root.deadline))).toISOString(),
    protectedTurns: [...state.turns.values()].filter(turn => turn.root === root.id).map(turn => turn.started.stored.eventId) }
}

export function workQuestionResult(state: AgentProjectionState, event: CommittedSessionEvent<ReturnType<typeof workInteractionResolvedEvent.decode>>): AgentActionResult {
  const p = event.payload
  if (p.outcome === 'blocked') return { kind: 'not-started', reason: p.reason }
  const request = workQuestionRequestedEvent.decode(state.sources.get(p.request)!.payload)
  return { kind: 'wait', descriptor: { kind: 'work-answer', request: p.request, interaction: p.admission, root: request.root,
    observedAt: request.observedAt, deadline: p.value.deadline,
    protectedTurns: [...state.turns.values()].filter(turn => turn.root === request.root).map(turn => turn.started.stored.eventId) } }
}

/** Persist the local intent before consulting the coordinator; only a confirmed CP-Q creates the reply wait. */
export async function executeWorkQuestion(session: SessionHandle, clock: Clock, action: AgentActionReference, authority: WorkInteractionAuthority): Promise<AgentActionResult> {
  const state = foldAgentSession(session.snapshot())
  const journal = new AgentJournal(session, state.spec!.payload.limits.maxJournalConflicts, clock)
  const request = await journal.append(workQuestionRequestedEvent, () => questionIntent(state, action, clockTimestamp(clock)))
  const decision = await authority.admit(request)
  const resolved = await journal.append(workInteractionResolvedEvent, () => workInteractionResolvedEvent.decode({ request: request.stored.eventId, ...decision } as JsonObject))
  return workQuestionResult(foldAgentSession(session.snapshot()), resolved)
}

export function validateWorkInteractionEvent(state: AgentProjectionState, event: CommittedSessionEvent): void {
  if (event.stored.type === workQuestionRequestedEvent.type) {
    const value = workQuestionRequestedEvent.decode(event.payload)
    if (!sameWorkflowValue(value, questionIntent(state, value.action, value.observedAt))
      || [...state.sources.values()].some(item => item.stored.type === event.stored.type
        && sameWorkflowValue(workQuestionRequestedEvent.decode(item.payload).action, value.action))) invalidHistory('work-question-intent-source')
    return
  }
  const p = workInteractionResolvedEvent.decode(event.payload)
  const eventSource = state.sources.get(p.request)
  if (eventSource?.stored.type !== workQuestionRequestedEvent.type
    || [...state.sources.values()].some(item => item.stored.type === event.stored.type && workInteractionResolvedEvent.decode(item.payload).request === p.request)) invalidHistory('work-interaction-resolution-source')
  const request = workQuestionRequestedEvent.decode(eventSource.payload)
  const binding = workActionSource(state, request.action).binding
  if (p.outcome === 'admitted' && (p.admission.address !== request.assignment.address || p.value.request.eventId !== p.request
    || p.value.request.address !== formatSessionAddress(eventSource.stored.sessionId)
    || p.value.definition !== binding.definition.eventId || p.value.targetAssignment.address !== binding.definition.address
    || !sameWorkflowValue(p.value.assignment, request.assignment) || p.value.deadline > request.deadline
    || p.value.deadline <= p.value.observedAt)) invalidHistory('work-interaction-admission-source')
}
