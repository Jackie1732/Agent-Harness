import { workAssignmentSettledEvent } from './settlement-events.js'
import { workflowDecisionMessage } from './messages.js'
import {  workProposalRecordedEvent , workReviewRecordedEvent } from './result-events.js'
import { workReviewTask } from './review.js'
import { emptyAgentBudget, reserveAgentBudget } from '../agent/budget.js'
import { invalidAgent } from '../agent/errors.js'
import { inputKey } from '../agent/input-codec.js'
import type { AgentProjectionState } from '../agent/projection-state.js'
import { requireEntry, requireSpec, source } from '../agent/projection-state.js'
import { inboxAcceptedEvent } from '../communication/session-events.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { formatSessionAddress } from '../session/ids.js'
import { sameWorkflowValue, workAssignmentAcceptedEvent } from './work-binding.js'

/** CP-ACCEPT creates one local input from the receiver's exact protocol Inbox. */
export function applyWorkAssignmentAccepted(state: AgentProjectionState, event: CommittedSessionEvent): void {
  if (event.stored.payloadVersion !== 1 || event.stored.ignorable) invalidAgent('work-accept-version')
  const accepted = workAssignmentAcceptedEvent.decode(event.payload)
  if (!sameWorkflowValue(accepted, event.payload) || !sameWorkflowValue(event.payload, event.stored.payload)) invalidAgent('work-accept-noncanonical')
  if ([...state.inputs.values()].some(input => input.work !== undefined && sameWorkflowValue(input.work.assignment, accepted.assignment))) invalidAgent('duplicate-work-accept')
  const spec = requireSpec(state).payload
  if (spec.protocolVersion !== 3 || spec.workflow.kind !== 'participant'
    || state.openRun !== null || state.openRecovery !== null || state.closing !== null
    || [...state.roots.values()].some(root => root.outcome === null)
    || [...state.inputs.values()].some(input => input.work !== undefined && ![...state.sources.values()].some(item => item.stored.type === workAssignmentSettledEvent.type
      && workAssignmentSettledEvent.decode(item.payload).accepted === input.reference.eventId))) invalidAgent('work-accept-not-admissible')
  const inbox = source(state, accepted.inbox, inboxAcceptedEvent)
  const { inbox: _inbox, ...message } = accepted
  const envelope = inbox.payload.envelope
  const assignment = accepted.value
  if (envelope.type !== 'workflow/assignment' || envelope.payloadVersion !== 1
    || envelope.sender !== accepted.definition.address || envelope.recipient !== formatSessionAddress(event.stored.sessionId)
    || envelope.recipient !== assignment.memberAddress || envelope.channelId !== assignment.channelId
    || !sameWorkflowValue(envelope.payload, message)) invalidAgent('work-accept-inbox')
  const authority = spec.workflow
  if (assignment.toolNames.some(name => !authority.toolNames.includes(name))
    || assignment.nativeActions.some(name => !(authority.nativeActions as readonly string[]).includes(name))
    || assignment.workspace.kind !== 'none' && !authority.resourceIds.includes(assignment.workspace.resourceId)
    || reserveAgentBudget(emptyAgentBudget, assignment.effectiveAllowance, spec.budget) === null) invalidAgent('work-accept-authority')
  const node = accepted.recipe.nodes.find(item => item.nodeKey === assignment.nodeKey)!
  const input = { kind: 'task' as const, text: assignment.kind === 'review' ? workReviewTask : node.task, originLabel: `workflow:${accepted.recipe.workflowKey}` }
  const reference = { kind: 'workflow' as const, eventId: event.stored.eventId }
  state.inputs.set(inputKey(reference), { reference, input, message: null, work: accepted,
    acceptedAt: event.stored.recordedAt, sequence: event.stored.sequence, lane: `workflow:${accepted.assignment.address}`,
    status: 'queued', claimedBy: null, reservedBy: null, everMatched: false, reason: null })
}

/** Every continuation inherits the root's original local acceptance. */
export function workAcceptanceForRoot(state: AgentProjectionState, rootId: import('../session/ids.js').SessionEventId) {
  const rootTurn = requireEntry(state.turns, rootId, 'work-root-turn')
  return requireEntry(state.inputs, inputKey(rootTurn.started.payload.input), 'work-root-input')
}

/** Close local work only after the exact coordinator decision reached this Inbox. */
export function applyWorkAssignmentSettled(state: AgentProjectionState, event: CommittedSessionEvent): void {
  const p = workAssignmentSettledEvent.decode(event.payload)
  const binding = source(state, p.accepted, workAssignmentAcceptedEvent)
  const inbox = source(state, p.inbox, inboxAcceptedEvent).payload.envelope
  const decision = workflowDecisionMessage.decode(inbox.payload)
  const proposal = [...state.sources.values()].find(item => [workProposalRecordedEvent.type, workReviewRecordedEvent.type].includes(item.stored.type)
    && workProposalRecordedEvent.decode(item.payload).accepted === p.accepted)
  if (event.stored.payloadVersion !== 1 || proposal === undefined || inbox.type !== workflowDecisionMessage.type || inbox.payloadVersion !== 1
    || inbox.sender !== binding.payload.assignment.address || inbox.recipient !== binding.payload.value.memberAddress
    || inbox.channelId !== binding.payload.value.channelId || !sameWorkflowValue(p.assignment, binding.payload.assignment)
    || !sameWorkflowValue(decision.assignment, p.assignment) || !sameWorkflowValue(decision.value.assignment, p.assignment)
    || decision.value.definition !== binding.payload.definition.eventId
    || p.outcome !== (workProposalRecordedEvent.decode(proposal.payload).outcome === 'completed' ? decision.value.outcome === 'accepted' ? 'completed' : 'rejected' : workProposalRecordedEvent.decode(proposal.payload).outcome)
    || decision.value.proposal.eventId !== proposal.stored.eventId
    || !sameWorkflowValue(decision.value.value, workProposalRecordedEvent.decode(proposal.payload).value)
    || !sameWorkflowValue(decision.value.artifacts, workProposalRecordedEvent.decode(proposal.payload).artifacts)
    || [...state.sources.values()].some(item => item.stored.type === event.stored.type && workAssignmentSettledEvent.decode(item.payload).accepted === p.accepted)) invalidAgent('work-settlement-source')
}
