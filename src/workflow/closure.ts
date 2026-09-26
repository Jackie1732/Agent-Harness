import { workExecutionReleasedEvent } from './result-events.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { SessionEventId } from '../session/ids.js'
import { workAssignmentSettledEvent } from './settlement-events.js'
import { projectWorkflowSession } from './projection.js'

/** Transport closes independently from business; a delivered proposal alone does not retire its reservation. */
export function workflowAssignmentClosed(coordinator: SessionHandle, member: SessionHandle, assignment: SessionEventId, peers: readonly SessionHandle[] = []): boolean {
  if (!member.snapshot().history.at(-1)!.events.some(item => item.kind === 'known' && item.stored.type === workAssignmentSettledEvent.type
    && workAssignmentSettledEvent.decode(item.payload).assignment.eventId === assignment)) return false
  if (!member.snapshot().history.at(-1)!.events.some(item => item.kind === 'known' && item.stored.type === workExecutionReleasedEvent.type
    && workExecutionReleasedEvent.decode(item.payload).assignment.eventId === assignment && workExecutionReleasedEvent.decode(item.payload).outcome === 'released')) return false
  if (projectWorkflowSession(coordinator.snapshot()).interactions.some(item => item.settled === null
    && [item.admitted.payload.assignment.eventId, item.admitted.payload.targetAssignment.eventId].includes(assignment))) return false
  return [...new Set([coordinator, member, ...peers])].every(session => {
    const facts = projectCommunicationFacts(session.snapshot())
    return [...facts.inbox, ...facts.outbox].every(item => {
      const p = item.envelope.payload as { readonly assignment?: { readonly eventId?: string }; readonly targetAssignment?: { readonly eventId?: string } }
      return !item.envelope.type.startsWith('workflow/') || p?.assignment?.eventId !== assignment && p?.targetAssignment?.eventId !== assignment || item.status !== 'pending'
    })
  })
}
