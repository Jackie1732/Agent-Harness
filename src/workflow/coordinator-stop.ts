import type { CommittedSessionEvent } from '../session/types.js'
import type { SessionEventId } from '../session/ids.js'
import type { WorkflowSnapshot } from './projection.js'
import { inboxAcceptedEvent } from '../communication/session-events.js'
import { workflowStoppedEvent, workflowAssignmentStopEvent, workflowStopAcknowledgedEvent, workflowStopAcknowledgedMessage, workflowTerminalEvent, workflowClosedEvent } from './stop-events.js'
import { workflowControlRequestedEvent } from './control-events.js'
import { workflowDecisionCommittedEvent } from './coordinator-events.js'
import { invalidHistory } from './errors.js'
import { sameWorkflowValue } from './work-binding.js'
import { workflowNodeResolvedEvent } from './definition-events.js'

export interface WorkflowStopState {
  stop: CommittedSessionEvent<ReturnType<typeof workflowStoppedEvent.decode>> | null
  readonly assignmentStops: CommittedSessionEvent<ReturnType<typeof workflowAssignmentStopEvent.decode>>[]
  readonly stopReceipts: CommittedSessionEvent<ReturnType<typeof workflowStopAcknowledgedEvent.decode>>[]
  terminal: CommittedSessionEvent<ReturnType<typeof workflowTerminalEvent.decode>> | null
  closed: CommittedSessionEvent<ReturnType<typeof workflowClosedEvent.decode>> | null
}
export function initialWorkflowStopState(): WorkflowStopState { return { stop: null, assignmentStops: [], stopReceipts: [], terminal: null, closed: null } }

/** A known failure with an unused template remains open for the separately bounded retry decision. */
export function finalWorkflowFailure(state: Pick<WorkflowSnapshot, 'definition' | 'assignments' | 'decisions' | 'upstream'>,
  sources: Iterable<CommittedSessionEvent>) {
  const failed = (assignment: SessionEventId) => {
    const work = state.assignments.find(item => item.stored.eventId === assignment)!
    if (work.payload.kind !== 'production') return false
    const node = state.definition!.payload.nodes.find(node => node.nodeKey === work.payload.nodeKey)!
    return state.upstream.find(item => item.nodeKey === node.nodeKey)?.state.kind === 'result-unknown' || work.payload.attempt === node.attempts.length
  }
  return state.decisions.find(decision => {
    const work = state.assignments.find(item => item.stored.eventId === decision.payload.assignment.eventId)!
    if (work.payload.kind !== 'production' || decision.payload.outcome !== 'rejected') return false
    return failed(work.stored.eventId)
  }) ?? [...sources].find(event => {
    if (event.stored.type === workflowNodeResolvedEvent.type) {
      const p = workflowNodeResolvedEvent.decode(event.payload)
      return p.outcome === 'failed' || state.definition!.payload.requiredOutputs.includes(p.nodeKey)
    }
    if (event.stored.type !== workflowStopAcknowledgedEvent.type) return false
    const p = workflowStopAcknowledgedEvent.decode(event.payload)
    return failed(p.message.assignment.eventId)
  })
}

/** Coordinator-local proofs order stop against output acceptance; participant release remains a separate fact. */
export function applyCoordinatorStop(lifecycle: WorkflowStopState,
  state: Pick<WorkflowSnapshot, 'definition' | 'assignments' | 'decisions' | 'upstream' | 'resolved'>,
  sources: ReadonlyMap<SessionEventId, CommittedSessionEvent>, event: CommittedSessionEvent): void {
  const definition = state.definition!
  if (event.stored.payloadVersion !== 1 || event.stored.ignorable) invalidHistory('workflow-stop-version')
  if (event.stored.type === workflowStoppedEvent.type) {
    const p = workflowStoppedEvent.decode(event.payload)
    if (p.definition !== definition.stored.eventId || lifecycle.stop !== null || lifecycle.terminal !== null) invalidHistory('workflow-stop-state')
    const cause = p.source === null ? undefined : sources.get(p.source)
    if (p.reason === 'cancelled') {
      if (cause?.stored.type !== workflowControlRequestedEvent.type || workflowControlRequestedEvent.decode(cause.payload).kind !== 'cancel') invalidHistory('workflow-stop-control')
    } else if (p.reason === 'deadline-exceeded') {
      if (p.source !== null || p.observedAt < definition.payload.deadline) invalidHistory('workflow-stop-deadline')
    } else if (finalWorkflowFailure(state, sources.values())?.stored.eventId !== p.source) invalidHistory('workflow-stop-failure')
    lifecycle.stop = { ...event, payload: p }
  } else if (event.stored.type === workflowAssignmentStopEvent.type) {
    const p = workflowAssignmentStopEvent.decode(event.payload), work = state.assignments.find(item => item.stored.eventId === p.assignment.eventId)
    const decision = state.decisions.find(item => item.payload.assignment.eventId === p.assignment.eventId)
    if (work === undefined || p.assignment.address !== definition.payload.coordinator || decision?.payload.outcome === 'accepted'
      || lifecycle.assignmentStops.some(item => sameWorkflowValue(item.payload.assignment, p.assignment))) invalidHistory('assignment-stop-state')
    if (p.source === work.stored.eventId) {
      if (event.stored.recordedAt < work.payload.deadline) invalidHistory('assignment-stop-before-deadline')
    } else if (p.source !== lifecycle.stop?.stored.eventId) {
      const source = sources.get(p.source)
      if (work.payload.kind !== 'review' || source?.stored.type !== workflowDecisionCommittedEvent.type) invalidHistory('assignment-stop-cause')
      const rejected = workflowDecisionCommittedEvent.decode(source.payload)
      if (rejected.outcome !== 'rejected' || !sameWorkflowValue(rejected.assignment, work.payload.reviewOf.assignment)) invalidHistory('review-stop-cause')
    }
    lifecycle.assignmentStops.push({ ...event, payload: p })
  } else if (event.stored.type === workflowStopAcknowledgedEvent.type) {
    const p = workflowStopAcknowledgedEvent.decode(event.payload), message = p.message
    const stop = lifecycle.assignmentStops.find(item => item.stored.eventId === message.stop.eventId)
    const work = state.assignments.find(item => item.stored.eventId === message.assignment.eventId)
    const incoming = sources.get(p.inbox)
    if (incoming?.stored.type !== inboxAcceptedEvent.type || stop === undefined || work === undefined
      || !sameWorkflowValue(stop.payload.assignment, message.assignment) || !sameWorkflowValue(message.value.assignment, message.assignment)
      || message.stop.address !== definition.payload.coordinator || message.receipt.address !== work.payload.memberAddress
      || lifecycle.stopReceipts.some(item => sameWorkflowValue(item.payload.message.stop, message.stop))) invalidHistory('workflow-stop-receipt-source')
    const envelope = inboxAcceptedEvent.decode(incoming.payload).envelope
    if (envelope.type !== workflowStopAcknowledgedMessage.type || envelope.payloadVersion !== 1 || envelope.sender !== work.payload.memberAddress
      || envelope.recipient !== definition.payload.coordinator || envelope.channelId !== work.payload.channelId || !sameWorkflowValue(envelope.payload, message)) invalidHistory('workflow-stop-receipt-inbox')
    lifecycle.stopReceipts.push({ ...event, payload: p })
  } else if (event.stored.type === workflowTerminalEvent.type) {
    const p = workflowTerminalEvent.decode(event.payload)
    const complete = definition.payload.requiredOutputs.every(key => state.upstream.some(item => item.nodeKey === key && item.state.kind === 'accepted'))
      && definition.payload.nodes.every(node => state.upstream.some(item => item.nodeKey === node.nodeKey && ['accepted', 'skipped'].includes(item.state.kind)))
    const expected = lifecycle.stop === null ? complete ? 'completed' : undefined : lifecycle.stop.payload.reason === 'cancelled' ? 'cancelled' : 'failed'
    if (p.definition !== definition.stored.eventId || lifecycle.terminal !== null || p.outcome !== expected) invalidHistory('workflow-terminal-source')
    lifecycle.terminal = { ...event, payload: p }
  } else {
    const p = workflowClosedEvent.decode(event.payload)
    if (lifecycle.terminal?.stored.eventId !== p.terminal || lifecycle.closed !== null
      || lifecycle.assignmentStops.some(stop => !lifecycle.stopReceipts.some(receipt => receipt.payload.message.stop.eventId === stop.stored.eventId))) invalidHistory('workflow-close-source')
    lifecycle.closed = { ...event, payload: p }
  }
}
