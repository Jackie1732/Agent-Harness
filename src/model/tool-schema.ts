import type { JsonObject } from '../foundation/json.js'
import { validateInlineSchema } from '../schema/inline.js'
import { ModelError } from './errors.js'

/** Structural validation of the shared advertised subset, not tool execution. */
export function validateToolSchema(schema: JsonObject, depth = 0): void {
  try {
    validateInlineSchema(schema, depth)
    if (depth === 0 && schema.type !== 'object') throw new TypeError('model tool input must be an object schema')
  } catch (reason) {
    throw new ModelError('MODEL_REQUEST_INVALID', reason instanceof Error ? reason.message : 'tool schema is invalid')
  }
}
