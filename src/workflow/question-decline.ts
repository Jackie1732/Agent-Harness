import type { AgentProjectionState } from '../agent/projection-state.js'
import { source } from '../agent/projection-state.js'
import { inboxAcceptedEvent } from '../communication/session-events.js'
import type { SessionEventId } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { Clock } from '../foundation/clock.js'
import { clockTimestamp } from '../foundation/clock.js'
import { foldAgentSession } from '../agent/projection.js'
import { AgentJournal } from '../agent/journal.js'
import { workAssignmentAcceptedEvent, sameWorkflowValue } from './work-binding.js'
import { workProtocolRecordedEvent } from './protocol.js'
import { workProtocolClassifiedEvent, workQuestionDeclinedEvent, workflowQuestionMessage, workflowAnswerMessage } from './interaction-events.js'
import { invalidHistory } from './errors.js'
import { workStopReceivedEvent } from './stop-events.js'

/** Required replies consume the reservation only when the root can no longer provide a business answer. */
export function questionDecline(state: AgentProjectionState, inbox: SessionEventId, observedAt: string) {
  const incoming = source(state, inbox, inboxAcceptedEvent).payload.envelope
  const question = workflowQuestionMessage.decode(incoming.payload)
  const classified = [...state.sources.values()].find(event => event.stored.type === workProtocolClassifiedEvent.type
    && workProtocolClassifiedEvent.decode(event.payload).inbox === inbox)
  if (classified === undefined) return undefined
  const classification = workProtocolClassifiedEvent.decode(classified.payload)
  const binding = source(state, classification.accepted, workAssignmentAcceptedEvent).payload
  if ([...state.sources.values()].some(event => event.stored.type === workProtocolRecordedEvent.type
    && workProtocolRecordedEvent.decode(event.payload).commands.some(command => command.type === workflowAnswerMessage.type
      && sameWorkflowValue(workflowAnswerMessage.decode(command.payload).question, question.question)))) return undefined
  if ([...state.sources.values()].some(event => event.stored.type === workQuestionDeclinedEvent.type
    && workQuestionDeclinedEvent.decode(event.payload).inbox === inbox)) return undefined
  const root = [...state.roots.values()].find(root => root.source.kind === 'workflow' && sameWorkflowValue(root.source.assignment, question.targetAssignment))
  const stopped = [...state.sources.values()].some(event => event.stored.type === workStopReceivedEvent.type
    && sameWorkflowValue(workStopReceivedEvent.decode(event.payload).assignment, question.targetAssignment))
  const reason = observedAt >= question.deadline ? 'question-expired' as const
    : stopped || root !== undefined && (root.outcome !== null || root.stopControl !== null) ? 'work-root-terminal' as const
      : root !== undefined && state.openTurn === null && (!root.allowedNativeActions.includes('agent_answer_work_peer')
        || root.budget.messages >= root.limit.messages || root.budget.models >= root.limit.models || root.budget.steps >= root.limit.steps
        || root.limit.outputTokens - root.budget.outputTokens < state.spec!.payload.target.maxOutputTokens) ? 'work-answer-unavailable' as const : undefined
  return reason === undefined ? undefined : { accepted: classification.accepted, inbox, reason, observedAt, binding, question, incoming }
}

export function applyWorkQuestionDeclined(state: AgentProjectionState, event: CommittedSessionEvent): void {
  const p = workQuestionDeclinedEvent.decode(event.payload)
  const expected = questionDecline(state, p.inbox, p.observedAt)
  if (expected === undefined || expected.reason !== p.reason || expected.accepted !== p.accepted) invalidHistory('work-decline-source')
  const input = [...state.inputs.values()].find(input => input.workMessage?.inbox === p.inbox)
  if (input?.status === 'queued') { input.status = 'not-adopted'; input.reason = p.reason }
}

export function declineCommands(sources: ReadonlyMap<SessionEventId, CommittedSessionEvent>, id: SessionEventId) {
  const declined = workQuestionDeclinedEvent.decode(sources.get(id)!.payload)
  const incoming = inboxAcceptedEvent.decode(sources.get(declined.inbox)!.payload).envelope
  const question = workflowQuestionMessage.decode(incoming.payload)
  const binding = workAssignmentAcceptedEvent.decode(sources.get(declined.accepted)!.payload)
  return { assignment: binding.assignment, source: id, commands: [{ kind: 'reply' as const, inboxMessageId: incoming.messageId, type: workflowAnswerMessage.type, payloadVersion: 1,
    payload: { definition: binding.definition, assignment: binding.assignment, targetAssignment: question.assignment, interaction: question.interaction,
      question: question.question, questionMessageId: incoming.messageId, outcome: 'unavailable', text: declined.reason } }] }
}

export function nextWorkQuestionDecline(session: SessionHandle, clock: Clock): (() => Promise<unknown>) | undefined {
  const snapshot = session.snapshot()
  if (!snapshot.history.at(-1)!.events.some(item => item.kind === 'known' && item.stored.type === workProtocolClassifiedEvent.type
    && workProtocolClassifiedEvent.decode(item.payload).kind === 'question')) return undefined
  const state = foldAgentSession(snapshot)
  for (const event of state.sources.values()) {
    if (event.stored.type !== workProtocolClassifiedEvent.type) continue
    const p = workProtocolClassifiedEvent.decode(event.payload)
    if (p.kind !== 'question') continue
    const candidate = questionDecline(state, p.inbox, clockTimestamp(clock))
    if (candidate !== undefined) return () => new AgentJournal(session, state.spec!.payload.limits.maxJournalConflicts, clock).append(workQuestionDeclinedEvent,
      () => ({ accepted: candidate.accepted, inbox: candidate.inbox, reason: candidate.reason, observedAt: candidate.observedAt }))
  }
  return undefined
}
