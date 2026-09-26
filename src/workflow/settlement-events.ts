import { eventId, exact, record } from '../agent/validation.js'
import { createDurableEventDefinition } from '../session/event-catalog.js'
import type { JsonObject } from '../foundation/json.js'
import type { SessionEventId } from '../session/ids.js'
import type { WorkflowEventRef } from './types.js'
import { workflowReference } from './work-binding.js'
import { invalidHistory } from './errors.js'

export type WorkAssignmentSettled = { readonly assignment: WorkflowEventRef; readonly accepted: SessionEventId;
  readonly inbox: SessionEventId; readonly outcome: 'completed' }
export const workAssignmentSettledEvent = createDurableEventDefinition<WorkAssignmentSettled & JsonObject>({
  type: 'work/assignment-settled', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['assignment', 'accepted', 'inbox', 'outcome'])
    if (p.outcome !== 'completed') invalidHistory('work-settlement-outcome')
    return { assignment: workflowReference(p.assignment), accepted: eventId(p.accepted), inbox: eventId(p.inbox), outcome: 'completed' }
  },
})
