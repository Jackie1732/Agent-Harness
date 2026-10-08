import type { JsonObject, JsonValue } from '../foundation/json.js'
import { compileProtocolValidator } from '../protocol/schema-validator.js'
import { createDurableEventDefinition, createDurableEventCatalog } from '../session/event-catalog.js'
import { object, union, literal, choice, nullable, list, stringSchema, eventIdSchema, timestampSchema,
  flagSchema, coverageSchema, inputStatusSchema, rootOutcomeSchema } from '../protocol/schema-fields.js'
import type { AgentInputStatus, AgentRootOutcome } from '../agent/contract.js'
import type { SessionEventId } from '../session/ids.js'
import { AutomationError } from './validation.js'

/** Certified remote facts; final text stays in its original Agent Session. */
export interface AutomationObservation extends JsonObject {
  readonly observedAt: string
  readonly readErrorCode: string | null
  readonly recoveryRequired: boolean
  readonly input: (JsonObject & { readonly eventId: SessionEventId; readonly status: AgentInputStatus; readonly rootId: SessionEventId | null; readonly reason: string | null;
    readonly instanceId: string; readonly cuts: readonly JsonObject[] }) | null
  readonly root: (JsonObject & { readonly rootId: SessionEventId; readonly outcome: AgentRootOutcome | null; readonly executionPending: boolean;
    readonly waitingForUser: boolean; readonly finalEventId: SessionEventId | null; readonly instanceId: string; readonly cuts: readonly JsonObject[] }) | null
}
export type AutomationFact = JsonObject & (
  | { readonly kind: 'configured'; readonly automationKey: string; readonly configDigest: string }
  | { readonly kind: 'accepted'; readonly triggerKey: string; readonly jobKey: string; readonly externalEventId: string; readonly text: string }
  | { readonly kind: 'submit-intent' | 'run-intent'; readonly triggerKey: string }
  | { readonly kind: 'submitted'; readonly triggerKey: string; readonly inputEventId: SessionEventId }
  | { readonly kind: 'run-returned'; readonly triggerKey: string; readonly instanceId: string }
  | { readonly kind: 'rejected'; readonly triggerKey: string; readonly operation: 'submit' | 'run'; readonly acceptance: 'not-accepted' | 'unknown'; readonly code: string }
  | { readonly kind: 'observed'; readonly triggerKey: string; readonly observation: AutomationObservation }
  | { readonly kind: 'run-unknown-acknowledged'; readonly triggerKey: string; readonly runIntent: SessionEventId }
)
const trigger = { triggerKey: { ...stringSchema, pattern: '^[a-f0-9]{64}$' } }
const evidence = { instanceId: { ...stringSchema, format: 'canonical-uuid' }, cuts: list(coverageSchema) }
const observation = object({ observedAt: timestampSchema, readErrorCode: nullable(stringSchema), recoveryRequired: flagSchema,
  input: nullable(object({ eventId: eventIdSchema, status: inputStatusSchema, rootId: nullable(eventIdSchema), reason: nullable(stringSchema), ...evidence })),
  root: nullable(object({ rootId: eventIdSchema, outcome: nullable(rootOutcomeSchema), executionPending: flagSchema, waitingForUser: flagSchema, finalEventId: nullable(eventIdSchema), ...evidence })) })
const schema = union(object({ kind: literal('configured'), automationKey: stringSchema, configDigest: { ...stringSchema, pattern: '^[a-f0-9]{64}$' } }),
  object({ kind: literal('accepted'), ...trigger, jobKey: stringSchema, externalEventId: stringSchema, text: stringSchema }),
  object({ kind: choice(['submit-intent', 'run-intent']), ...trigger }),
  object({ kind: literal('submitted'), ...trigger, inputEventId: eventIdSchema }),
  object({ kind: literal('run-returned'), ...trigger, instanceId: { ...stringSchema, format: 'canonical-uuid' } }),
  object({ kind: literal('rejected'), ...trigger, operation: choice(['submit', 'run']), acceptance: choice(['not-accepted', 'unknown']), code: stringSchema }),
  object({ kind: literal('observed'), ...trigger, observation }),
  object({ kind: literal('run-unknown-acknowledged'), ...trigger, runIntent: eventIdSchema }))
const validate = compileProtocolValidator<AutomationFact>(schema)
/** Required automation facts never enter an Agent's model-visible Session. */
export const automationFactEvent = createDurableEventDefinition<AutomationFact>({ type: 'automation/fact', payloadVersion: 1, ignorable: false,
  decode(value: JsonValue) {
    if (!validate(value)) throw new AutomationError('AUTOMATION_JOURNAL_INVALID')
    return value as AutomationFact
  } })
export const automationCatalog = createDurableEventCatalog([automationFactEvent])
