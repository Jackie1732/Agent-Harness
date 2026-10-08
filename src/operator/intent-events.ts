import type { JsonObject, JsonValue } from '../foundation/json.js'
import { createDurableEventCatalog, createDurableEventDefinition } from '../session/event-catalog.js'
import { compileProtocolValidator } from '../protocol/schema-validator.js'
import { CONTROL_METHODS, decodeParams } from '../protocol/index.js'
import { object, union, literal, nullable, choice, stringSchema, uuidSchema, timestampSchema } from '../protocol/schema-fields.js'
import { OperatorError } from './errors.js'
import type { OperatorIntent } from './types.js'

export type OperatorFact = JsonObject & (
  | { readonly kind: 'configured'; readonly profileKey: string; readonly bindingDigest: string; readonly certificateFingerprint: string | null }
  | { readonly kind: 'prepared'; readonly intent: Omit<OperatorIntent, 'outcome'> }
  | { readonly kind: 'outcome'; readonly intentId: string; readonly outcome: NonNullable<OperatorIntent['outcome']> }
  | { readonly kind: 'checkpoint'; readonly sessionId: string; readonly sequence: number }
)
const digest = { ...stringSchema, pattern: '^[a-f0-9]{64}$' }
const scope = object({ connection: choice(['local', 'remote']), connectionLifetime: choice(['command', 'session']),
  hostKey: stringSchema, instanceId: uuidSchema, sessionId: nullable(uuidSchema) })
const intent = object({ id: uuidSchema, method: choice(CONTROL_METHODS), params: { type: 'object', additionalProperties: true },
  scope, preparedAt: timestampSchema, parentIntent: nullable(uuidSchema), callerNamespace: nullable(stringSchema),
  certificateFingerprint: nullable(digest), configDigest: digest, acknowledgedIntent: nullable(uuidSchema),
  acknowledgementReason: nullable(literal('operator-requested-new-batch')) })
const outcome = object({ acceptance: choice(['accepted', 'not-accepted', 'unknown', 'not-applicable']), resultDigest: nullable(digest),
  summary: { type: 'object', additionalProperties: true }, receivedAt: timestampSchema, errorCode: nullable(stringSchema) })
const validate = compileProtocolValidator<OperatorFact>(union(
  object({ kind: literal('configured'), profileKey: uuidSchema, bindingDigest: digest, certificateFingerprint: nullable(digest) }),
  object({ kind: literal('prepared'), intent }), object({ kind: literal('outcome'), intentId: uuidSchema, outcome }),
  object({ kind: literal('checkpoint'), sessionId: uuidSchema, sequence: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } }),
))

/** Operator facts live in a separate Session and do not enter model-visible transcripts. */
export const operatorFactEvent = createDurableEventDefinition<OperatorFact>({ type: 'operator/fact', payloadVersion: 1, ignorable: false,
  decode(value: JsonValue) {
    if (!validate(value)) throw new OperatorError('OPERATOR_JOURNAL_INVALID', 1)
    if (value.kind === 'prepared') decodeParams(value.intent.method, value.intent.params,
      { maxBytes: 16 * 1024 * 1024, maxDepth: 64, maxNodes: 100000 })
    return value as OperatorFact
  } })
export const operatorCatalog = createDurableEventCatalog([operatorFactEvent])
