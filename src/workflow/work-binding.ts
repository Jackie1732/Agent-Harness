import { decodeAgentBudget, emptyAgentBudget, reserveAgentBudget } from '../agent/budget.js'
import { validateWorkBaseline } from './workspace.js'
import { eventId, exact, record } from '../agent/validation.js'
import { snapshotJson } from '../foundation/json.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { createDurableEventDefinition } from '../session/event-catalog.js'
import { formatSessionAddress, parseSessionEventId } from '../session/ids.js'
import type { SessionEventId } from '../session/ids.js'
import { decodeWorkflowAssignment } from './assignment-codec.js'
import { decodeWorkflowDefinition } from './definition.js'
import { invalidHistory } from './errors.js'
import type { WorkflowAssignment, WorkflowDefinition, WorkflowEventRef } from './types.js'
import { workflowAssignmentMailboxDemand } from './protocol-capacity.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'

/** The receiver's own Inbox carries the immutable recipe and the exact CP-W value. */
export type WorkAssignmentMessage = {
  readonly definition: WorkflowEventRef
  readonly assignment: WorkflowEventRef
  readonly recipe: WorkflowDefinition
  readonly value: WorkflowAssignment
}
export type WorkAssignmentAccepted = WorkAssignmentMessage & { readonly inbox: SessionEventId }

export function sameWorkflowValue(left: unknown, right: unknown): boolean {
  return Buffer.compare(canonicalJsonBytes(left as JsonValue), canonicalJsonBytes(right as JsonValue)) === 0
}

export function workflowReference(value: unknown): WorkflowEventRef {
  const input = record(value); exact(input, ['address', 'eventId'])
  const id = eventId(input.eventId)
  if (input.address !== formatSessionAddress(parseSessionEventId(id).sessionId)) invalidHistory('work-reference-address')
  return { address: input.address as WorkflowEventRef['address'], eventId: id }
}

/** Validate the frozen production recipe independently from a coordinator's live state. */
export function decodeWorkAssignmentMessage(value: unknown): WorkAssignmentMessage {
  const input = record(snapshotJson(value)); exact(input, ['definition', 'assignment', 'recipe', 'value'])
  const definition = workflowReference(input.definition)
  const assignment = workflowReference(input.assignment)
  const recipe = decodeWorkflowDefinition(input.recipe)
  const work = decodeWorkflowAssignment(input.value!)
  validateWorkBaseline(work)
  const node = recipe.nodes.find(item => item.nodeKey === work.nodeKey)
  const attempt = node?.attempts[work.attempt - 1]
  const member = recipe.roster.find(item => item.memberKey === work.memberKey)
  if (recipe.coordinator !== definition.address || assignment.address !== definition.address
    || work.definition !== definition.eventId || parseSessionEventId(assignment.eventId).sequence <= parseSessionEventId(definition.eventId).sequence
    || node === undefined || attempt === undefined || member === undefined || node.executor !== member.memberKey
    || work.memberAddress !== member.address || !member.canProduce || work.deadline > recipe.deadline
    || !sameWorkflowValue(work.effectiveAllowance, attempt.workerGrant)
    || !sameWorkflowValue(work.reviewerReservations, attempt.reviewerGrants)
    || !sameWorkflowValue(work.toolNames, attempt.toolNames) || !sameWorkflowValue(work.nativeActions, attempt.nativeActions)
    || !sameWorkflowValue(work.workspace, attempt.workspace) || !sameWorkflowValue(work.acceptance, node.acceptance)
    || !sameWorkflowValue(work.protocolReserve, workflowAssignmentMailboxDemand(recipe, 'production'))
    || reserveAgentBudget(emptyAgentBudget, decodeAgentBudget(work.effectiveAllowance), member.budgetCeiling) === null) invalidHistory('work-assignment-recipe')
  return { definition, assignment, recipe, value: work }
}

export const workAssignmentAcceptedEvent = createDurableEventDefinition<WorkAssignmentAccepted & JsonObject>({
  type: 'work/assignment-accepted', payloadVersion: 1, ignorable: false,
  decode(value) {
    const input = record(value); exact(input, ['inbox', 'definition', 'assignment', 'recipe', 'value'])
    const { inbox, ...message } = input
    return { ...decodeWorkAssignmentMessage(message), inbox: eventId(inbox) } as WorkAssignmentAccepted & JsonObject
  },
})
