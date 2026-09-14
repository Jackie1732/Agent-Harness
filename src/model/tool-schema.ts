import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonObject } from '../foundation/json.js'
import { ModelError } from './errors.js'
import { bool, keys, list, object, oneOf, text } from './validation.js'

/** Structural validation of the advertised JSON Schema subset, not tool execution. */
export function validateToolSchema(schema: JsonObject, depth = 0): void {
  if (depth > 32) throw new ModelError('MODEL_REQUEST_INVALID', 'tool schema nesting exceeds 32')
  keys(schema, ['type'], ['description', 'properties', 'required', 'additionalProperties', 'enum', 'items'])
  const type = oneOf(schema.type, ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'], 'schema type')
  if (schema.description !== undefined) text(schema.description, 'schema description')
  if (schema.enum !== undefined) {
    const values = list(schema.enum, 'schema enum')
    if (values.length === 0) throw new ModelError('MODEL_REQUEST_INVALID', 'schema enum must not be empty')
    const encoded = values.map(value => Buffer.from(canonicalJsonBytes(value)).toString('utf8'))
    if (new Set(encoded).size !== encoded.length) throw new ModelError('MODEL_REQUEST_INVALID', 'schema enum contains duplicates')
  }
  if (type === 'object') {
    if (schema.items !== undefined) throw new ModelError('MODEL_REQUEST_INVALID', 'object schema cannot have items')
    const properties = schema.properties === undefined ? {} : object(schema.properties, 'schema properties')
    for (const value of Object.values(properties)) validateToolSchema(object(value, 'property schema'), depth + 1)
    if (schema.required !== undefined) {
      const names = list(schema.required, 'schema required').map(value => text(value, 'required name', 256, false))
      if (new Set(names).size !== names.length || names.some(name => !Object.hasOwn(properties, name))) {
        throw new ModelError('MODEL_REQUEST_INVALID', 'schema required names must be distinct declared properties')
      }
    }
    if (schema.additionalProperties !== undefined) bool(schema.additionalProperties, 'additionalProperties')
  } else {
    if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
      throw new ModelError('MODEL_REQUEST_INVALID', 'non-object schema contains object keywords')
    }
    if (type === 'array') validateToolSchema(object(schema.items, 'array items'), depth + 1)
    else if (schema.items !== undefined) throw new ModelError('MODEL_REQUEST_INVALID', 'non-array schema contains items')
  }
}
