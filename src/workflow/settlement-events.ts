import { choice, eventId, exact, record } from '../agent/validation.js'
import { createDurableEventDefinition } from '../session/event-catalog.js'
import type { JsonObject } from '../foundation/json.js'
import type { SessionEventId } from '../session/ids.js'
import type { WorkflowEventRef } from './types.js'
import { workflowReference } from './work-binding.js'

export type WorkAssignmentSettled = { readonly assignment: WorkflowEventRef; readonly accepted: SessionEventId;
  readonly inbox: SessionEventId; readonly outcome: 'completed' | 'rejected' | 'failed' | 'cancelled' | 'result-unknown' }
export const workAssignmentSettledEvent = createDurableEventDefinition<WorkAssignmentSettled & JsonObject>({
  type: 'work/assignment-settled', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['assignment', 'accepted', 'inbox', 'outcome'])
    return { assignment: workflowReference(p.assignment), accepted: eventId(p.accepted), inbox: eventId(p.inbox), outcome: choice(p.outcome, ['completed', 'rejected', 'failed', 'cancelled', 'result-unknown']) }
  },
})
