import { choice, eventId, exact, record, timestamp } from '../agent/validation.js'
import { createDurableEventDefinition } from '../session/event-catalog.js'
import { createMessageDefinition } from '../communication/message-catalog.js'
import { decodeWorkAssignmentMessage, workflowReference } from './work-binding.js'
import type { JsonObject } from '../foundation/json.js'

export const workflowStoppedEvent = createDurableEventDefinition({ type: 'workflow/stopped', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['definition', 'reason', 'source', 'observedAt'])
    return { definition: eventId(p.definition), reason: choice(p.reason, ['cancelled', 'deadline-exceeded', 'node-failed']),
      source: p.source === null ? null : eventId(p.source), observedAt: timestamp(p.observedAt) }
  } })
export const workflowAssignmentStopEvent = createDurableEventDefinition({ type: 'workflow/assignment-stop-requested', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['assignment', 'source'])
    return { assignment: workflowReference(p.assignment), source: eventId(p.source) }
  } })
export const workflowStopMessage = createMessageDefinition({ type: 'workflow/stop', payloadVersion: 1,
  decode(value) {
    const p = record(value); exact(p, ['assignment', 'stop', 'binding'])
    return { assignment: workflowReference(p.assignment), stop: workflowReference(p.stop), binding: decodeWorkAssignmentMessage(p.binding!) as ReturnType<typeof decodeWorkAssignmentMessage> & JsonObject }
  } })
export const workStopReceivedEvent = createDurableEventDefinition({ type: 'work/stop-received', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['inbox', 'assignment', 'root'])
    return { inbox: eventId(p.inbox), assignment: workflowReference(p.assignment), root: p.root === null ? null : eventId(p.root) }
  } })
export const workAssignmentRejectedEvent = createDurableEventDefinition({ type: 'work/assignment-rejected', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['inbox', 'stop'])
    return { inbox: eventId(p.inbox), stop: eventId(p.stop) }
  } })
export const workStopSettledEvent = createDurableEventDefinition({ type: 'work/stop-settled', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['stop', 'assignment', 'root', 'executionRelease', 'outcome'])
    return { stop: eventId(p.stop), assignment: workflowReference(p.assignment), root: p.root === null ? null : eventId(p.root),
      executionRelease: p.executionRelease === null ? null : eventId(p.executionRelease),
      outcome: choice(p.outcome, ['unexecuted', 'completed', 'failed', 'cancelled', 'result-unknown']) }
  } })
export const workflowStopAcknowledgedMessage = createMessageDefinition({ type: 'workflow/stop-acknowledged', payloadVersion: 1,
  decode(value) {
    const p = record(value); exact(p, ['assignment', 'stop', 'receipt', 'value'])
    return { assignment: workflowReference(p.assignment), stop: workflowReference(p.stop), receipt: workflowReference(p.receipt), value: workStopSettledEvent.decode(p.value!) }
  } })
export const workflowStopAcknowledgedEvent = createDurableEventDefinition({ type: 'workflow/stop-acknowledged', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['inbox', 'message'])
    return { inbox: eventId(p.inbox), message: workflowStopAcknowledgedMessage.decode(p.message!) }
  } })
export const workflowTerminalEvent = createDurableEventDefinition({ type: 'workflow/terminal', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['definition', 'outcome', 'observedAt'])
    return { definition: eventId(p.definition), outcome: choice(p.outcome, ['completed', 'cancelled', 'failed']), observedAt: timestamp(p.observedAt) }
  } })
export const workflowClosedEvent = createDurableEventDefinition({ type: 'workflow/closed', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['terminal', 'observedAt'])
    return { terminal: eventId(p.terminal), observedAt: timestamp(p.observedAt) }
  } })
export const workflowStopEventDefinitions = [workflowStoppedEvent, workflowAssignmentStopEvent, workStopReceivedEvent,
  workAssignmentRejectedEvent, workStopSettledEvent, workflowStopAcknowledgedEvent, workflowTerminalEvent, workflowClosedEvent] as const
