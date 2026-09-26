import { parseSessionEventId } from '../session/ids.js'
import { invalidHistory } from './errors.js'
import type { WorkflowProposalMessage } from './result-events.js'
import type { WorkflowAssignment, WorkflowDefinition, WorkflowEventRef } from './types.js'
import { sameWorkflowValue } from './work-binding.js'
import { validateWorkValue, workflowField } from './result.js'
import { reviewValue } from './review.js'

/** Validate authorized received copies without dereferencing another Session's private history. */
export function validateWorkflowProposal(recipe: WorkflowDefinition, assignment: WorkflowAssignment,
  reference: WorkflowEventRef, message: WorkflowProposalMessage): void {
  const proposal = message.value
  const node = recipe.nodes.find(node => node.nodeKey === assignment.nodeKey)!
  const producer = assignment.memberAddress
  if (!sameWorkflowValue(message.assignment, reference) || !sameWorkflowValue(proposal.assignment, reference)
    || message.proposal.address !== producer || !sameWorkflowValue(proposal.artifacts, message.artifacts.map(item => item.ref))) invalidHistory('proposal-binding')
  const local = parseSessionEventId(message.proposal.eventId)
  for (const id of [proposal.accepted, proposal.root, proposal.terminal, proposal.executionRelease]) {
    const source = parseSessionEventId(id)
    if (source.sessionId !== local.sessionId || source.sequence >= local.sequence) invalidHistory('proposal-local-source')
  }
  if (proposal.outcome !== 'completed') {
    if (proposal.reason === null || proposal.value !== null || message.artifacts.length !== 0) invalidHistory('proposal-failure-value')
    return
  }
  if (proposal.reason !== null) invalidHistory('proposal-success-reason')
  if (assignment.kind === 'review') {
    reviewValue(proposal.value)
    if (message.artifacts.length !== 0) invalidHistory('review-has-artifacts')
    return
  }
  validateWorkValue(proposal.value, recipe, node.nodeKey)
  const declarations = node.output.kind === 'text' ? [{ name: node.output.name, source: { kind: 'model-final' as const } }] : node.output.artifacts
  if (message.artifacts.length !== declarations.length || message.artifacts.length > recipe.limits.maxArtifactsPerAttempt
    || message.artifacts.reduce((total, item) => total + item.value.byteLength, 0) > recipe.limits.maxTotalArtifactBytes
    || new Set(message.artifacts.map(item => item.ref.eventId)).size !== message.artifacts.length) invalidHistory('proposal-artifact-count')
  for (const [index, copy] of message.artifacts.entries()) {
    const artifact = copy.value
    const declared = declarations[index]!
    const id = parseSessionEventId(copy.ref.eventId)
    if (copy.ref.address !== producer || id.sequence >= local.sequence || id.sequence <= parseSessionEventId(proposal.executionRelease).sequence
      || artifact.accepted !== proposal.accepted || artifact.root !== proposal.root || artifact.executionRelease !== proposal.executionRelease
      || !sameWorkflowValue(artifact.assignment, reference) || artifact.name !== declared.name
      || artifact.byteLength > recipe.limits.maxArtifactBytes || artifact.source.kind !== declared.source.kind) invalidHistory('proposal-artifact-source')
    if (declared.source.kind === 'model-final' && artifact.text !== proposal.value
      || declared.source.kind === 'json-text' && (artifact.source.kind !== 'json-text'
        || !sameWorkflowValue(artifact.source.path, declared.source.path) || artifact.text !== workflowField(proposal.value, declared.source.path))) invalidHistory('proposal-artifact-value')
  }
}
