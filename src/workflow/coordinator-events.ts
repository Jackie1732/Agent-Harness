import { array, choice, eventId, exact, record } from '../agent/validation.js'
import { snapshotJson } from '../foundation/json.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { createDurableEventDefinition } from '../session/event-catalog.js'
import type { SessionEventId } from '../session/ids.js'
import { invalidHistory } from './errors.js'
import { decodeWorkflowProposalMessage } from './result-events.js'
import type { WorkflowProposalMessage } from './result-events.js'
import { workflowReference } from './work-binding.js'
import type { WorkflowEventRef } from './types.js'

export type WorkflowProposalReceived = {
  readonly definition: SessionEventId
  readonly inbox: SessionEventId
  readonly message: WorkflowProposalMessage
}
export type WorkflowDecisionCommitted = {
  readonly definition: SessionEventId
  readonly assignment: WorkflowEventRef
  readonly proposal: WorkflowEventRef
  readonly expectedOutputRevision: 0
  readonly outcome: 'accepted' | 'rejected'
  readonly value: JsonValue
  readonly artifacts: readonly WorkflowEventRef[]
  readonly reviews: readonly WorkflowEventRef[]
}
export const workflowProposalReceivedEvent = createDurableEventDefinition<WorkflowProposalReceived & JsonObject>({
  type: 'workflow/proposal-received', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['definition', 'inbox', 'message'])
    return { definition: eventId(p.definition), inbox: eventId(p.inbox), message: decodeWorkflowProposalMessage(p.message) }
  },
})
export const workflowDecisionCommittedEvent = createDurableEventDefinition<WorkflowDecisionCommitted & JsonObject>({
  type: 'workflow/decision-committed', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['definition', 'assignment', 'proposal', 'expectedOutputRevision', 'outcome', 'value', 'artifacts', 'reviews'])
    if (p.expectedOutputRevision !== 0) invalidHistory('decision-output-revision')
    return { definition: eventId(p.definition), assignment: workflowReference(p.assignment), proposal: workflowReference(p.proposal),
      expectedOutputRevision: 0, outcome: choice(p.outcome, ['accepted', 'rejected']), value: snapshotJson(p.value),
      artifacts: array(p.artifacts, 1024).map(workflowReference), reviews: array(p.reviews, 128).map(workflowReference) }
  },
})

export const workflowCoordinatorEventDefinitions = [workflowProposalReceivedEvent, workflowDecisionCommittedEvent] as const
