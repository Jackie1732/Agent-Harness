import { eventId, exact, record } from '../agent/validation.js'
import type { JsonObject } from '../foundation/json.js'
import { createMessageDefinition } from '../communication/message-catalog.js'
import { decodeWorkAssignmentMessage, workflowReference } from './work-binding.js'
import { decodeWorkflowProposalMessage } from './result-events.js'
import { workflowDecisionCommittedEvent } from './coordinator-events.js'
import { workflowProgressMessage } from './progress.js'

export const workflowAssignmentMessage = createMessageDefinition({ type: 'workflow/assignment', payloadVersion: 1,
  decode: value => decodeWorkAssignmentMessage(value) as ReturnType<typeof decodeWorkAssignmentMessage> & JsonObject })
export const workflowAssignmentAcceptedMessage = createMessageDefinition({ type: 'workflow/assignment-accepted', payloadVersion: 1,
  decode(value) {
    const p = record(value); exact(p, ['assignment', 'accepted'])
    return { assignment: workflowReference(p.assignment), accepted: workflowReference(p.accepted) }
  } })
export const workflowProposalMessage = createMessageDefinition({ type: 'workflow/proposal', payloadVersion: 1,
  decode: decodeWorkflowProposalMessage })
export const workflowReviewMessage = createMessageDefinition({ type: 'workflow/review', payloadVersion: 1,
  decode: decodeWorkflowProposalMessage })
export const workflowDecisionMessage = createMessageDefinition({ type: 'workflow/decision', payloadVersion: 1,
  decode(value) {
    const p = record(value); exact(p, ['assignment', 'decision', 'value'])
    return { assignment: workflowReference(p.assignment), decision: eventId(p.decision), value: workflowDecisionCommittedEvent.decode(p.value!) }
  } })

export const workflowMessageDefinitions = [workflowAssignmentMessage, workflowAssignmentAcceptedMessage,
  workflowProposalMessage, workflowReviewMessage, workflowDecisionMessage, workflowProgressMessage] as const
