import type { WorkflowSnapshot } from './projection.js'
import type { WorkflowAssignment } from './types.js'
import { resolveWorkflowNode } from './graph.js'
import { workflowAssignmentMailboxDemand } from './protocol-capacity.js'
import { sameWorkflowValue } from './work-binding.js'
import { validateWorkBaseline } from './workspace.js'
import { nextWorkflowAttempt, reserveWorkflowAttempt, workflowBudgetWithRetries } from './retry.js'
import { invalidHistory } from './errors.js'

type AdmissionState = Pick<WorkflowSnapshot, 'definition' | 'assignments' | 'decisions' | 'resolved' | 'upstream' | 'controls' | 'retries' | 'reservedBudget'>

/** Production CP-W binds one authorized template, accepted predecessor data, and the complete grant debit. */
export function validateProductionAssignment(state: AdmissionState, payload: Extract<WorkflowAssignment, { kind: 'production' }>, recordedAt: string) {
  const definition = state.definition!, recipe = definition.payload
  const node = recipe.nodes.find(item => item.nodeKey === payload.nodeKey), attempt = node?.attempts[payload.attempt - 1]
  if (payload.definition !== definition.stored.eventId || node === undefined || attempt === undefined
    || state.resolved.some(item => item.nodeKey === payload.nodeKey) || payload.attempt !== nextWorkflowAttempt(state, payload.nodeKey)) invalidHistory('assignment-not-admissible')
  const member = recipe.roster.find(item => item.memberKey === node.executor)
  const selected = resolveWorkflowNode(node, new Map(state.upstream.map(item => [item.nodeKey, item.state])), recipe)
  const sourceAccepted = state.decisions.filter(item => item.payload.outcome === 'accepted' && node.inputs.some(input => input.source.kind === 'accepted'
    && state.assignments.find(assignment => assignment.payload.kind === 'production' && assignment.stored.eventId === item.payload.assignment.eventId)?.payload.nodeKey === input.source.nodeKey))
    .map(item => ({ address: recipe.coordinator, eventId: item.stored.eventId }))
  if (selected.kind !== 'ready' || payload.memberKey !== node.executor || payload.memberAddress !== member?.address
    || !sameWorkflowValue(payload.sourceAccepted, sourceAccepted) || !sameWorkflowValue(payload.inputs, selected.inputs)
    || !sameWorkflowValue(payload.effectiveAllowance, attempt.workerGrant) || !sameWorkflowValue(payload.reviewerReservations, attempt.reviewerGrants)
    || !sameWorkflowValue(payload.toolNames, attempt.toolNames) || !sameWorkflowValue(payload.nativeActions, attempt.nativeActions)
    || !sameWorkflowValue(payload.workspace, attempt.workspace) || !sameWorkflowValue(payload.acceptance, node.acceptance)
    || !sameWorkflowValue(payload.protocolReserve, workflowAssignmentMailboxDemand(recipe, 'production'))) invalidHistory('assignment-recipe-mismatch')
  const until = Math.min(Date.parse(recipe.deadline), Date.parse(recordedAt) + attempt.durationMs)
  validateWorkBaseline(payload)
  if (Date.parse(payload.deadline) > until) invalidHistory('assignment-deadline')
  const next = reserveWorkflowAttempt(state.reservedBudget, attempt, recipe.budget)
  if (next === null) invalidHistory('workflow-budget-exceeded')
  const previous = state.assignments.filter(item => item.payload.kind === 'production' && item.payload.nodeKey === node.nodeKey).at(-1)
  if (workflowBudgetWithRetries({ ...state, reservedBudget: next }, previous?.stored.eventId) === null) invalidHistory('workflow-retry-budget-claimed')
  return next
}
