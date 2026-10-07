import type { SessionSnapshot } from '../session/types.js'
import type { WorkflowEventRef } from './types.js'
import { projectWorkflowSession } from './projection.js'
import { sameWorkflowValue } from './work-binding.js'

/** Only a production acceptance supplies a node's authoritative output. */
export function selectWorkflowOutput(snapshot: SessionSnapshot, nodeKey: string) {
  const state = projectWorkflowSession(snapshot)
  if (!state.definition!.payload.nodes.some(item => item.nodeKey === nodeKey)) return { kind: 'node-missing' as const }
  const decision = state.decisions.find(item => item.payload.outcome === 'accepted' && state.assignments.some(work => work.stored.eventId === item.payload.assignment.eventId
    && work.payload.kind === 'production' && work.payload.nodeKey === nodeKey))
  if (decision === undefined) return { kind: 'not-available' as const }
  return { kind: 'available' as const, value: decision.payload.value,
    decisionRef: { address: snapshot.header.address, eventId: decision.stored.eventId }, assignmentRef: decision.payload.assignment, proposalRef: decision.payload.proposal }
}

/** A disclosed proposal becomes an accepted artifact only through its exact production decision. */
export function selectWorkflowArtifact(snapshot: SessionSnapshot, reference: WorkflowEventRef) {
  const state = projectWorkflowSession(snapshot)
  const decision = state.decisions.find(item => item.payload.outcome === 'accepted' && item.payload.artifacts.some(ref => sameWorkflowValue(ref, reference))
    && state.assignments.some(work => work.stored.eventId === item.payload.assignment.eventId && work.payload.kind === 'production'))
  if (decision === undefined) return null
  const proposal = state.proposals.find(item => sameWorkflowValue(item.payload.message.proposal, decision.payload.proposal))
  const copy = proposal?.payload.message.artifacts.find(item => sameWorkflowValue(item.ref, reference))
  if (copy === undefined) return null
  return { decisionRef: { address: snapshot.header.address, eventId: decision.stored.eventId }, assignmentRef: decision.payload.assignment,
    proposalRef: decision.payload.proposal, mediaType: copy.value.mediaType, text: copy.value.text, byteLength: copy.value.byteLength, sha256: copy.value.sha256 }
}
