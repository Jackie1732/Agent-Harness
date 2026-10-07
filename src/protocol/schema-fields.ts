import type { JsonObject, JsonValue } from '../foundation/json.js'

/** JSON Schema fragments for the finite v1 data vocabulary. */
export const stringSchema: JsonObject = { type: 'string' }
export const flagSchema: JsonObject = { type: 'boolean' }
export const nullSchema: JsonObject = { type: 'null' }
export const integerSchema: JsonObject = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }
export const positiveSchema: JsonObject = { ...integerSchema, minimum: 1 }
export const uuidSchema: JsonObject = { type: 'string', format: 'canonical-uuid' }
export const eventIdSchema: JsonObject = { type: 'string', format: 'session-event-id' }
export const addressSchema: JsonObject = { type: 'string', format: 'session-address' }
export const timestampSchema: JsonObject = { type: 'string', format: 'iso-timestamp' }
export const keySchema: JsonObject = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9._:-]+$' }
export const requestIdSchema: JsonObject = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[\\x21-\\x7e]+$' }
export const nameSchema: JsonObject = { type: 'string', minLength: 1, maxUtf8Bytes: 128 }

export function literal(value: JsonValue): JsonObject { return { const: value } }
export function choice(values: readonly JsonValue[]): JsonObject { return { enum: values } }
export function nullable(schema: JsonObject): JsonObject { return { anyOf: [schema, nullSchema] } }
export function list(items: JsonObject, uniqueItems = false): JsonObject { return { type: 'array', items, ...(uniqueItems ? { uniqueItems: true } : {}) } }
export function object(properties: Readonly<Record<string, JsonObject>>, optional: readonly string[] = []): JsonObject {
  return { type: 'object', properties, required: Object.keys(properties).filter(key => !optional.includes(key)), additionalProperties: false }
}
export function union(...schemas: readonly JsonObject[]): JsonObject { return { oneOf: schemas } }
export function reference(name: string): JsonObject { return { $ref: '#/$defs/' + name } }
export const actionReferenceSchema = object({ eventId: eventIdSchema, index: { ...integerSchema, maximum: 63 } })
export const workflowReferenceSchema = object({ address: addressSchema, eventId: eventIdSchema })
export const budgetSchema = object(Object.fromEntries(['models', 'steps', 'tools', 'messages', 'waits', 'outputTokens'].map(key => [key, integerSchema])))
export const coverageSchema = object({ sessionId: uuidSchema, through: integerSchema })
export const cursorSchema = object({ sessionId: uuidSchema, through: integerSchema, nextSequence: positiveSchema })
export const rootOutcomeSchema = choice(['completed', 'failed', 'cancelled', 'budget-exhausted', 'result-unknown', 'timed-out'])
export const inputStatusSchema = choice(['queued', 'reserved', 'claimed', 'handled', 'review-required', 'abandoned', 'not-adopted'])
export const inputReferenceSchema = object({ kind: choice(['user', 'peer', 'subagent', 'workflow']), eventId: eventIdSchema })
export const runSelectionSchema = union(object({ kind: literal('ordinary') }), object({ kind: literal('workflow'), assignment: workflowReferenceSchema }))
