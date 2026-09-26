import { workExecutionReleasedEvent } from './result-events.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { SessionEventId } from '../session/ids.js'
import { workAssignmentSettledEvent } from './settlement-events.js'
import { projectWorkflowSession } from './projection.js'
import { projectAgentSession } from '../agent/projection.js'
import { workStopSettledEvent } from './stop-events.js'

/** Transport closes independently from business; a delivered proposal alone does not retire its reservation. */
export function workflowAssignmentClosed(coordinator: SessionHandle, member: SessionHandle, assignment: SessionEventId, peers: readonly SessionHandle[] = []): boolean {
  const stopped = member.snapshot().history.at(-1)!.events.find(item => item.kind === 'known' && item.stored.type === workStopSettledEvent.type
    && workStopSettledEvent.decode(item.payload).assignment.eventId === assignment)
  const stop = stopped?.kind === 'known' ? workStopSettledEvent.decode(stopped.payload) : undefined
  const coordinatorState = projectWorkflowSession(coordinator.snapshot())
  if (stop !== undefined && !coordinatorState.stopReceipts.some(item => item.payload.message.receipt.eventId === stopped!.stored.eventId)) return false
  if (stop === undefined && !member.snapshot().history.at(-1)!.events.some(item => item.kind === 'known' && item.stored.type === workAssignmentSettledEvent.type
    && workAssignmentSettledEvent.decode(item.payload).assignment.eventId === assignment)) return false
  if (stop?.outcome !== 'unexecuted' && !member.snapshot().history.at(-1)!.events.some(item => item.kind === 'known' && item.stored.type === workExecutionReleasedEvent.type
    && workExecutionReleasedEvent.decode(item.payload).assignment.eventId === assignment && workExecutionReleasedEvent.decode(item.payload).outcome === 'released')) return false
  if (projectAgentSession(member.snapshot()).inputs.some(input => (input.work?.assignment ?? input.workMessage?.assignment ?? input.workGroupResult?.assignment)?.eventId === assignment
    && !['handled', 'abandoned', 'not-adopted'].includes(input.status))) return false
  if (coordinatorState.interactions.some(item => item.settled === null
    && [item.admitted.payload.assignment.eventId, ...(item.admitted.payload.kind === 'question' ? [item.admitted.payload.targetAssignment.eventId]
      : item.admitted.payload.targets.map(target => target.assignment.eventId))].includes(assignment))) return false
  return [...new Set([coordinator, member, ...peers])].every(session => {
    const facts = projectCommunicationFacts(session.snapshot())
    return [...facts.inbox, ...facts.outbox].every(item => {
      const p = item.envelope.payload as { readonly assignment?: { readonly eventId?: string }; readonly targetAssignment?: { readonly eventId?: string } }
      return !item.envelope.type.startsWith('workflow/') || p?.assignment?.eventId !== assignment && p?.targetAssignment?.eventId !== assignment || item.status !== 'pending'
    })
  })
}
