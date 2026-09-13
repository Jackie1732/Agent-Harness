/** JSON primitive value. */
export type JsonPrimitive = null | boolean | number | string

/** JSON array value. */
export type JsonArray = readonly JsonValue[]

/** JSON object value. */
export interface JsonObject {
  readonly [key: string]: JsonValue
}

/** Value that can be represented without loss by the project's JSON protocols. */
export type JsonValue = JsonPrimitive | JsonArray | JsonObject

interface JsonProblem {
  readonly path: string
  readonly reason: string
}

function propertyPath(parent: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`
}

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null
  return prototype === null || Object.getPrototypeOf(prototype) === null
}

/**
 * Validate a primitive value for JSON compatibility.
 *
 * @param value - The value to validate
 * @param path - The current path in the object tree
 * @returns A problem description if invalid, undefined if valid
 */
function validatePrimitive(value: unknown, path: string): JsonProblem | undefined {
  if (value === null) return undefined

  switch (typeof value) {
    case 'boolean':
    case 'string':
      return undefined
    case 'number':
      return Number.isFinite(value) ? undefined : { path, reason: 'number must be finite' }
    case 'undefined':
    case 'bigint':
    case 'function':
    case 'symbol':
      return { path, reason: `${typeof value} is not a JSON value` }
    default:
      return undefined
  }
}

/**
 * Validate an array for JSON compatibility.
 *
 * Checks for:
 * - Dense indexed elements only
 * - No sparse elements
 * - Data properties only (no getters/setters)
 * - Recursively valid elements
 *
 * @param value - The array to validate
 * @param path - The current path in the object tree
 * @param active - Set tracking objects currently being validated (for cycle detection)
 * @returns A problem description if invalid, undefined if valid
 */
function validateArray(value: unknown[], path: string, active: Set<object>): JsonProblem | undefined {
  const ownNames = Object.getOwnPropertyNames(value).filter(name => name !== 'length')
  if (ownNames.length !== value.length) {
    return { path, reason: 'array must contain only dense indexed elements' }
  }

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined) {
      return { path: `${path}[${index}]`, reason: 'sparse array element' }
    }
    if (!('value' in descriptor)) {
      return { path: `${path}[${index}]`, reason: 'array elements must be data properties' }
    }
    const problem = findJsonProblem(descriptor.value, `${path}[${index}]`, active)
    if (problem !== undefined) return problem
  }

  return undefined
}

/**
 * Validate an object for JSON compatibility.
 *
 * Checks for:
 * - Plain record only (no custom classes, Date, etc.)
 * - Enumerable data properties only
 * - Recursively valid property values
 *
 * @param value - The object to validate
 * @param path - The current path in the object tree
 * @param active - Set tracking objects currently being validated (for cycle detection)
 * @returns A problem description if invalid, undefined if valid
 */
function validateObject(value: object, path: string, active: Set<object>): JsonProblem | undefined {
  if (!isPlainRecord(value)) {
    return { path, reason: 'object must be a plain record' }
  }

  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      return { path: propertyPath(path, key), reason: 'object fields must be enumerable data properties' }
    }
    const problem = findJsonProblem(descriptor.value, propertyPath(path, key), active)
    if (problem !== undefined) return problem
  }

  return undefined
}

/**
 * Recursively find the first JSON incompatibility in a value.
 *
 * @param value - The value to validate
 * @param path - The current path in the object tree
 * @param active - Set tracking objects currently being validated (for cycle detection)
 * @returns A problem description if invalid, undefined if valid
 */
function findJsonProblem(value: unknown, path: string, active: Set<object>): JsonProblem | undefined {
  if (value === null || typeof value !== 'object') return validatePrimitive(value, path)

  if (active.has(value)) {
    return { path, reason: 'circular reference' }
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    return { path, reason: 'symbol-keyed properties are not JSON fields' }
  }

  active.add(value)
  try {
    if (Array.isArray(value)) {
      return validateArray(value, path, active)
    }
    return validateObject(value, path, active)
  } finally {
    active.delete(value)
  }
}

/**
 * Check whether a value can cross a JSON protocol without implicit coercion.
 *
 * @param value - The value to check
 * @returns True if the value is JSON-safe, false otherwise
 *
 */
export function isJsonValue(value: unknown): value is JsonValue {
  return findJsonProblem(value, '$', new Set()) === undefined
}

/**
 * Require a JSON-safe value.
 *
 * @param value - The value to validate
 * @param label - A label for the value in error messages
 * @throws {TypeError} with the first invalid path and reason
 */
export function assertJsonValue(value: unknown, label = 'value'): asserts value is JsonValue {
  const problem = findJsonProblem(value, '$', new Set())
  if (problem !== undefined) {
    throw new TypeError(`${label}${problem.path.slice(1)}: ${problem.reason}`)
  }
}

function freezeJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value
  for (const child of Object.values(value)) freezeJson(child)
  return Object.freeze(value)
}

/** Validate, serialize, copy, and deeply freeze one JSON value. */
export function snapshotJson(value: unknown, label = 'value'): JsonValue {
  assertJsonValue(value, label)
  const encoded = JSON.stringify(value)
  const parsed: unknown = JSON.parse(encoded)
  assertJsonValue(parsed, label)
  return freezeJson(parsed)
}

/** Deeply freeze a newly decoded JSON value without serializing it again. */
export function freezeDecodedJson(value: JsonValue): JsonValue {
  return freezeJson(value)
}
