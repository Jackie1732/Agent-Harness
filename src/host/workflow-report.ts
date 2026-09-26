import type { SessionHandle } from '../session/session-handle.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import { projectWorkflowSession } from '../workflow/projection.js'
import { workflowAssignmentClosed } from '../workflow/closure.js'
import type { HostSlot } from './runtime-types.js'

/** Count the whole run before truncating the operator's entry vectors. */
export function workflowReport(session: SessionHandle, slots: readonly HostSlot[], resumed: boolean) {
  const state = projectWorkflowSession(session.snapshot())
  const definition = state.definition!.payload
  const maximum = definition.limits.maxReportEntries
  const nodes = definition.nodes.map(node => ({ nodeKey: node.nodeKey,
    status: state.upstream.find(item => item.nodeKey === node.nodeKey)?.state.kind ?? (state.stop !== null ? state.stop.payload.reason === 'cancelled' ? 'cancelled' : 'failed'
      : state.assignments.some(item => item.payload.nodeKey === node.nodeKey) ? 'assigned' : state.ready.includes(node.nodeKey) ? 'ready' : 'blocked') }))
  const closed = state.assignments.every(assignment => {
    const member = slots.find(slot => slot.session.header.address === assignment.payload.memberAddress)
    return member !== undefined && workflowAssignmentClosed(session, member.session, assignment.stored.eventId, slots.map(slot => slot.session))
  })
  const completed = definition.requiredOutputs.every(key => state.upstream.find(item => item.nodeKey === key)?.state.kind === 'accepted')
    && nodes.every(node => ['accepted', 'skipped'].includes(node.status))
  const failed = state.upstream.some(item => ['failed', 'result-unknown', 'cancelled'].includes(item.state.kind))
    || definition.requiredOutputs.some(key => state.upstream.find(item => item.nodeKey === key)?.state.kind === 'skipped')
  const communication = projectCommunicationFacts(session.snapshot())
  const retries = state.retries.filter(item => item.expired === null && item.consumed === null)
  return Object.freeze({ workflowKey: definition.workflowKey, desired: state.desired,
    state: state.terminal?.payload.outcome ?? (state.stop !== null ? state.stop.payload.reason === 'cancelled' ? 'cancelled' as const : 'failed' as const
      : failed ? 'failed' as const : completed ? 'completed' as const : state.desired === 'paused' ? 'paused' as const
        : !resumed ? 'suspended' as const : retries.some(item => item.request === null) ? 'retry-awaiting-decision' as const : 'running' as const),
    settled: state.terminal !== null, closed: state.closed !== null && closed && state.controls.every(item => item.settled !== null),
    terminal: state.terminal === null ? null : { address: session.header.address, eventId: state.terminal.stored.eventId },
    budget: definition.budget, reservedBudget: state.reservedBudget,
    counts: { nodes: nodes.length, assignments: state.assignments.length, proposals: state.proposals.length, reviews: state.reviews.length, progress: state.progress.length,
      accepted: state.decisions.filter(item => item.payload.outcome === 'accepted' && state.assignments.some(work => work.stored.eventId === item.payload.assignment.eventId && work.payload.kind === 'production')).length,
      failed: state.decisions.filter(item => item.payload.outcome === 'rejected' && state.assignments.some(work => work.stored.eventId === item.payload.assignment.eventId && work.payload.kind === 'production')).length,
      pendingInbox: communication.inbox.filter(item => item.status === 'pending').length,
      questions: state.interactions.filter(item => item.admitted.payload.kind === 'question').length,
      pendingQuestions: state.interactions.filter(item => item.admitted.payload.kind === 'question' && item.settled === null).length,
      groups: state.interactions.filter(item => item.admitted.payload.kind === 'group').length,
      pendingGroups: state.interactions.filter(item => item.admitted.payload.kind === 'group' && item.settled === null).length,
      pendingControls: state.controls.filter(item => item.settled === null).length,
      retries: state.retries.length, pendingRetries: state.stop === null ? retries.filter(item => item.request === null).length : 0,
      pendingStops: state.assignmentStops.filter(item => !state.stopReceipts.some(receipt => receipt.payload.message.stop.eventId === item.stored.eventId)).length,
      pendingOutbox: communication.outbox.filter(item => item.status === 'pending').length },
    progress: Object.freeze(state.progress.slice(0, maximum)),
    retries: Object.freeze(retries.slice(0, maximum)),
    nodes: Object.freeze(nodes.slice(0, maximum)), assignments: Object.freeze(state.assignments.slice(0, maximum).map(item => ({
      ref: { address: session.header.address, eventId: item.stored.eventId }, nodeKey: item.payload.nodeKey, memberKey: item.payload.memberKey, attempt: item.payload.attempt }))),
    truncated: nodes.length > maximum || state.assignments.length > maximum || state.progress.length > maximum || retries.length > maximum })
}
