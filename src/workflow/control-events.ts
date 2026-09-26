import { choice, eventId, exact, record, text } from '../agent/validation.js'
import { createDurableEventDefinition } from '../session/event-catalog.js'
import type { JsonObject } from '../foundation/json.js'
import type { SessionEventId } from '../session/ids.js'

export type WorkflowControlRequested = { readonly definition: SessionEventId; readonly requestKey: string;
  readonly kind: 'pause' | 'resume' | 'cancel'; readonly reason: string }
export type WorkflowControlSettled = { readonly request: SessionEventId; readonly outcome: 'applied' | 'no-op'; readonly owner: string }
export const workflowControlRequestedEvent = createDurableEventDefinition<WorkflowControlRequested & JsonObject>({
  type: 'workflow/control-requested', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['definition', 'requestKey', 'kind', 'reason'])
    return { definition: eventId(p.definition), requestKey: text(p.requestKey, 128), kind: choice(p.kind, ['pause', 'resume', 'cancel']), reason: text(p.reason, 1024, true) }
  },
})
export const workflowControlSettledEvent = createDurableEventDefinition<WorkflowControlSettled & JsonObject>({
  type: 'workflow/control-settled', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['request', 'outcome', 'owner'])
    return { request: eventId(p.request), outcome: choice(p.outcome, ['applied', 'no-op']), owner: text(p.owner, 128) }
  },
})

export const workflowControlEventDefinitions = [workflowControlRequestedEvent, workflowControlSettledEvent] as const
