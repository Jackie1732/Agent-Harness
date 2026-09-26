import { projectCommunicationFacts } from '../communication/projection.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { SessionEventId } from '../session/ids.js'
import { workAssignmentSettledEvent } from './settlement-events.js'

/** Transport closes independently from business; a delivered proposal alone does not retire its reservation. */
export function workflowAssignmentClosed(coordinator: SessionHandle, member: SessionHandle, assignment: SessionEventId): boolean {
  if (!member.snapshot().history.at(-1)!.events.some(item => item.kind === 'known' && item.stored.type === workAssignmentSettledEvent.type
    && workAssignmentSettledEvent.decode(item.payload).assignment.eventId === assignment)) return false
  return [coordinator, member].every(session => {
    const facts = projectCommunicationFacts(session.snapshot())
    return [...facts.inbox, ...facts.outbox].every(item => {
      const p = item.envelope.payload as { readonly assignment?: { readonly eventId?: string } }
      return !item.envelope.type.startsWith('workflow/') || p?.assignment?.eventId !== assignment || item.status !== 'pending'
    })
  })
}
