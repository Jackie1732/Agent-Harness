import { compileInlineValidator } from '../schema/inline-validator.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import type { SessionEventId, SessionAddress } from '../session/ids.js'
import type { ChannelId } from '../communication/ids.js'
import type { WorkflowAssignment, WorkflowDefinition } from './types.js'
import type { WorkflowSnapshot } from './projection.js'
import { sameWorkflowValue } from './work-binding.js'
import { workflowAssignmentMailboxDemand } from './protocol-capacity.js'
import { WorkflowError, invalidHistory } from './errors.js'
import { decodeWorkflowProposalMessage } from './result-events.js'
import { workOutputAtAttempt } from './output.js'

export const workReviewSchema: JsonObject = { type: 'object', properties: {
  decision: { type: 'string', enum: ['accept', 'reject'] }, reason: { type: 'string' },
}, required: ['decision', 'reason'], additionalProperties: false }
export const workReviewTask = 'Review the exact candidate and artifacts against the supplied task and output requirements. Return only JSON with decision (accept or reject) and reason.'
export const workReviewOutput = { kind: 'json' as const, schema: workReviewSchema, artifacts: [] }

export function reviewValue(value: JsonValue): { readonly decision: 'accept' | 'reject'; readonly reason: string } {
  if (!compileInlineValidator(workReviewSchema)(value)) throw new WorkflowError('WORKFLOW_RESULT_INVALID', 'review-output-schema')
  return value as { readonly decision: 'accept' | 'reject'; readonly reason: string }
}

/** Consume one producer-owned reviewer reservation without charging the workflow grant twice. */
export function reviewAssignment(state: Pick<WorkflowSnapshot, 'definition' | 'assignments' | 'proposals' | 'decisions'>,
  production: SessionEventId, memberAddress: SessionAddress, channelId: ChannelId, observedAt: string,
  protocolLimits: WorkflowAssignment['protocolLimits'], nativeActions: readonly string[] = []): WorkflowAssignment {
  const definition = state.definition!
  const producer = state.assignments.find(item => item.stored.eventId === production)
  const candidate = state.proposals.find(item => item.payload.message.assignment.eventId === production)
  const member = definition.payload.roster.find(item => item.address === memberAddress)
  const reservation = producer?.payload.reviewerReservations.find(item => item.memberKey === member?.memberKey)
  if (producer?.payload.kind !== 'production' || producer.payload.acceptance.kind !== 'reviewed-all'
    || candidate?.payload.message.value.outcome !== 'completed' || member === undefined || reservation === undefined
    || state.decisions.some(item => item.payload.assignment.eventId === production)
    || state.assignments.some(item => item.payload.kind === 'review' && item.payload.reviewOf.assignment.eventId === production && item.payload.memberKey === member.memberKey)
    || observedAt >= producer.payload.deadline || nativeActions.length > 1 || nativeActions.some(name => name !== 'agent_ask_user')
    || nativeActions.length !== 0 && reservation.grant.waits === 0) invalidHistory('review-not-admissible')
  const node = definition.payload.nodes.find(item => item.nodeKey === producer.payload.nodeKey)!
  return { definition: definition.stored.eventId, kind: 'review', nodeKey: node.nodeKey, attempt: producer.payload.attempt,
    reviewOf: { assignment: candidate.payload.message.assignment, proposal: candidate.payload.message.proposal },
    memberKey: member.memberKey, memberAddress, channelId, inputs: {
      candidate: candidate.payload.message as unknown as JsonObject, criteria: { task: node.task, output: workOutputAtAttempt(node.output, producer.payload.attempt) as unknown as JsonObject },
    }, sourceAccepted: [], effectiveAllowance: reservation.grant, reviewerReservations: [], toolNames: [], nativeActions,
    workspace: { kind: 'none' }, workspaceBaseline: null, protocolLimits,
    protocolReserve: workflowAssignmentMailboxDemand(definition.payload, 'review'), deadline: producer.payload.deadline,
    acceptance: { kind: 'schema-only' } }
}

/** Receiver-side checks use only its disclosed candidate and frozen definition. */
export function validateReviewRecipe(recipe: WorkflowDefinition, work: Extract<WorkflowAssignment, { kind: 'review' }>): void {
  const node = recipe.nodes.find(item => item.nodeKey === work.nodeKey)!
  const grant = node.attempts[work.attempt - 1]?.reviewerGrants.find(item => item.memberKey === work.memberKey)
  const candidate = decodeWorkflowProposalMessage(work.inputs.candidate)
  if (node.acceptance.kind !== 'reviewed-all' || !node.acceptance.reviewers.includes(work.memberKey)
    || work.memberKey === node.executor || !recipe.roster.find(item => item.memberKey === work.memberKey)?.canReview
    || grant === undefined || !sameWorkflowValue(work.effectiveAllowance, grant.grant)
    || work.reviewOf.assignment.address !== recipe.coordinator
    || !sameWorkflowValue(candidate.assignment, work.reviewOf.assignment) || !sameWorkflowValue(candidate.proposal, work.reviewOf.proposal)
    || work.toolNames.length !== 0 || work.nativeActions.length > 1 || work.nativeActions.some(name => name !== 'agent_ask_user')
    || work.reviewerReservations.length !== 0 || work.sourceAccepted.length !== 0 || work.workspace.kind !== 'none'
    || work.acceptance.kind !== 'schema-only'
    || !sameWorkflowValue(work.inputs.criteria, { task: node.task, output: workOutputAtAttempt(node.output, work.attempt) })
    || !sameWorkflowValue(work.protocolReserve, workflowAssignmentMailboxDemand(recipe, 'review'))) invalidHistory('review-assignment-recipe')
}

/** Fixed reviewer order determines the exact evidence set used by the conditional decision. */
export function resolveWorkflowReviews(state: Pick<WorkflowSnapshot, 'assignments' | 'reviews'>, production: SessionEventId) {
  const work = state.assignments.find(item => item.stored.eventId === production)!.payload
  if (work.acceptance.kind !== 'reviewed-all') return { outcome: 'accepted' as const, reviews: [], resultUnknown: false }
  const results = work.acceptance.reviewers.map(memberKey => {
    const assignment = state.assignments.find(item => item.payload.kind === 'review'
      && item.payload.reviewOf.assignment.eventId === production && item.payload.memberKey === memberKey)
    return state.reviews.find(item => item.payload.message.assignment.eventId === assignment?.stored.eventId)
  })
  const rejected = results.some(item => item !== undefined && (item.payload.message.value.outcome !== 'completed'
    || reviewValue(item.payload.message.value.value).decision === 'reject'))
  if (!rejected && results.some(item => item === undefined)) return undefined
  return { outcome: rejected ? 'rejected' as const : 'accepted' as const,
    resultUnknown: results.some(item => item?.payload.message.value.outcome === 'result-unknown'),
    reviews: results.flatMap(item => item === undefined ? [] : [item.payload.message.proposal]) }
}
