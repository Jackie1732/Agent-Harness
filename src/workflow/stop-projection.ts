import type { AgentProjectionState } from '../agent/projection-state.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { inboxAcceptedEvent } from '../communication/session-events.js'
import { source } from '../agent/projection-state.js'
import { inputKey } from '../agent/input-codec.js'
import { invalidHistory } from './errors.js'
import { sameWorkflowValue, decodeWorkAssignmentMessage } from './work-binding.js'
import { workStopReceivedEvent, workStopSettledEvent, workAssignmentRejectedEvent, workflowStopMessage } from './stop-events.js'
import { workExecutionReleasedEvent } from './result-events.js'

/** A stop names one coordinator assignment; queued work is disposed without opening a root. */
export function applyWorkStop(state: AgentProjectionState, event: CommittedSessionEvent): void {
  if (event.stored.payloadVersion !== 1 || event.stored.ignorable) invalidHistory('work-stop-version')
  if (event.stored.type === workStopReceivedEvent.type) {
    const p = workStopReceivedEvent.decode(event.payload), inbox = source(state, p.inbox, inboxAcceptedEvent).payload.envelope
    const message = workflowStopMessage.decode(inbox.payload), binding = message.binding
    const root = [...state.roots.values()].find(root => root.source.kind === 'workflow' && sameWorkflowValue(root.source.assignment, p.assignment))
    if (inbox.type !== workflowStopMessage.type || inbox.payloadVersion !== 1 || inbox.sender !== p.assignment.address
      || inbox.recipient !== binding.value.memberAddress || inbox.channelId !== binding.value.channelId
      || !sameWorkflowValue(p.assignment, message.assignment) || !sameWorkflowValue(p.assignment, binding.assignment)
      || message.stop.address !== p.assignment.address || (root?.id ?? null) !== p.root
      || [...state.sources.values()].some(item => item.stored.type === event.stored.type && sameWorkflowValue(workStopReceivedEvent.decode(item.payload).assignment, p.assignment))) invalidHistory('work-stop-source')
    const input = [...state.inputs.values()].find(input => input.work !== undefined && sameWorkflowValue(input.work.assignment, p.assignment))
    if (input !== undefined && p.root === null) {
      if (input.status !== 'queued') invalidHistory('work-stop-input')
      input.status = 'not-adopted'; input.reason = 'workflow-stopped'
    }
  } else if (event.stored.type === workAssignmentRejectedEvent.type) {
    const p = workAssignmentRejectedEvent.decode(event.payload), stop = source(state, p.stop, workStopReceivedEvent).payload
    const inbox = source(state, p.inbox, inboxAcceptedEvent).payload.envelope
    const message = decodeWorkAssignmentMessage(inbox.payload)
    const original = workflowStopMessage.decode(source(state, stop.inbox, inboxAcceptedEvent).payload.envelope.payload)
    if (inbox.type !== 'workflow/assignment' || inbox.payloadVersion !== 1 || !sameWorkflowValue(message, original.binding)
      || inbox.sender !== stop.assignment.address || inbox.recipient !== message.value.memberAddress || inbox.channelId !== message.value.channelId
      || [...state.sources.values()].some(item => item.stored.type === event.stored.type && workAssignmentRejectedEvent.decode(item.payload).inbox === p.inbox)) invalidHistory('work-reject-source')
  } else {
    const p = workStopSettledEvent.decode(event.payload), stop = source(state, p.stop, workStopReceivedEvent).payload
    if (!sameWorkflowValue(p.assignment, stop.assignment) || p.root !== stop.root
      || [...state.sources.values()].some(item => item.stored.type === event.stored.type && workStopSettledEvent.decode(item.payload).stop === p.stop)) invalidHistory('work-stop-settlement-source')
    if (p.root === null) {
      if (p.executionRelease !== null || p.outcome !== 'unexecuted') invalidHistory('work-stop-unexecuted')
      return
    }
    const root = state.roots.get(p.root)!
    const release = p.executionRelease === null ? undefined : source(state, p.executionRelease, workExecutionReleasedEvent).payload
    if (root.outcome === null || release?.root !== root.id || !sameWorkflowValue(release.assignment, p.assignment)
      || p.outcome !== (release.outcome === 'unknown' || root.outcome === 'result-unknown' ? 'result-unknown'
        : root.outcome === 'completed' ? 'completed' : root.outcome === 'cancelled' ? 'cancelled' : 'failed')) invalidHistory('work-stop-release')
    const input = state.inputs.get(inputKey(state.turns.get(root.id)!.started.payload.input))!
    if (input.status === 'review-required') { input.status = 'not-adopted'; input.reason = 'workflow-stopped' }
    if (!['handled', 'abandoned', 'not-adopted'].includes(input.status)) invalidHistory('work-stop-root-input')
  }
}
