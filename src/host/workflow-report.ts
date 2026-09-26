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
    status: state.upstream.find(item => item.nodeKey === node.nodeKey)?.state.kind ?? (state.assignments.some(item => item.payload.nodeKey === node.nodeKey) ? 'assigned' : state.ready.includes(node.nodeKey) ? 'ready' : 'blocked') }))
  const closed = state.assignments.every(assignment => {
    const member = slots.find(slot => slot.session.header.address === assignment.payload.memberAddress)
    return member !== undefined && workflowAssignmentClosed(session, member.session, assignment.stored.eventId)
  })
  const completed = definition.requiredOutputs.every(key => state.upstream.find(item => item.nodeKey === key)?.state.kind === 'accepted')
    && nodes.every(node => ['accepted', 'skipped'].includes(node.status))
  const failed = state.upstream.some(item => ['failed', 'result-unknown', 'cancelled'].includes(item.state.kind))
    || definition.requiredOutputs.some(key => state.upstream.find(item => item.nodeKey === key)?.state.kind === 'skipped')
  const communication = projectCommunicationFacts(session.snapshot())
  return Object.freeze({ workflowKey: definition.workflowKey, desired: state.desired,
    state: failed ? 'failed' as const : completed ? 'completed' as const : state.desired === 'paused' ? 'paused' as const : resumed ? 'running' as const : 'suspended' as const,
    settled: completed || failed, closed: (completed || failed) && closed, budget: definition.budget, reservedBudget: state.reservedBudget,
    counts: { nodes: nodes.length, assignments: state.assignments.length, proposals: state.proposals.length, accepted: state.decisions.filter(item => item.payload.outcome === 'accepted').length,
      failed: state.decisions.filter(item => item.payload.outcome === 'rejected').length,
      pendingInbox: communication.inbox.filter(item => item.status === 'pending').length,
      pendingOutbox: communication.outbox.filter(item => item.status === 'pending').length },
    nodes: Object.freeze(nodes.slice(0, maximum)), assignments: Object.freeze(state.assignments.slice(0, maximum).map(item => ({
      ref: { address: session.header.address, eventId: item.stored.eventId }, nodeKey: item.payload.nodeKey, memberKey: item.payload.memberKey, attempt: item.payload.attempt }))),
    truncated: nodes.length > maximum || state.assignments.length > maximum })
}
