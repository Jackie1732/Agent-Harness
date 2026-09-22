import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'

/** Shared structural language; parameter truth is evaluated by Ajv, not by this module. */
export class InlineSchemaError extends TypeError {}

function invalid(message: string): never { throw new InlineSchemaError(message) }
function object(value: JsonValue | undefined, label: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${label} must be an object`)
  return value as JsonObject
}
function list(value: JsonValue | undefined, label: string): readonly JsonValue[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array`)
  return value as readonly JsonValue[]
}

const inlineSchemaFields = new Set([
  'type', 'description', 'properties', 'required', 'additionalProperties', 'enum', 'items', 'oneOf',
])

/** The exact inline subset inherited from Model; callers preflight untrusted JSON first. */
export function validateInlineSchema(schema: JsonObject, depth = 0, maximumDepth = 32): void {
  if (depth > maximumDepth) invalid(`tool schema nesting exceeds ${maximumDepth}`)
  if (!Object.hasOwn(schema, 'type') || Object.keys(schema).some(key => !inlineSchemaFields.has(key))) {
    invalid('schema has missing or unsupported fields')
  }
  const type = schema.type
  if (typeof type !== 'string' || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type)) {
    invalid('schema type has an unsupported value')
  }
  if (schema.description !== undefined && typeof schema.description !== 'string') invalid('schema description must be a bounded string')
  if (schema.oneOf !== undefined) {
    const alternatives = list(schema.oneOf, 'schema alternatives')
    if (alternatives.length < 2 || alternatives.length > 8) invalid('schema alternatives must be finite')
    for (const alternative of alternatives) {
      const variant = object(alternative, 'schema alternative')
      if (variant.type !== type) invalid('schema alternatives must retain the declared type')
      validateInlineSchema(variant, depth + 1, maximumDepth)
    }
  }
  if (schema.enum !== undefined) {
    const values = list(schema.enum, 'schema enum')
    if (values.length === 0) invalid('schema enum must not be empty')
    const encoded = values.map(value => Buffer.from(canonicalJsonBytes(value)).toString('utf8'))
    if (new Set(encoded).size !== encoded.length) invalid('schema enum contains duplicates')
  }
  if (type === 'object') {
    if (schema.items !== undefined) invalid('object schema cannot have items')
    const properties = schema.properties === undefined ? {} : object(schema.properties, 'schema properties')
    for (const value of Object.values(properties)) validateInlineSchema(object(value, 'property schema'), depth + 1, maximumDepth)
    if (schema.required !== undefined) {
      const names = list(schema.required, 'schema required').map(value => {
        if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > 256) invalid('required name must be a bounded string')
        return value
      })
      if (new Set(names).size !== names.length || names.some(name => !Object.hasOwn(properties, name))) {
        invalid('schema required names must be distinct declared properties')
      }
    }
    if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') invalid('additionalProperties must be boolean')
  } else {
    if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
      invalid('non-object schema contains object keywords')
    }
    if (type === 'array') validateInlineSchema(object(schema.items, 'array items'), depth + 1, maximumDepth)
    else if (schema.items !== undefined) invalid('non-array schema contains items')
  }
}
