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

function findJsonProblem(value: unknown, path: string, active: Set<object>): JsonProblem | undefined {
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
    case 'object':
      break
  }

  if (active.has(value)) return { path, reason: 'circular reference' }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return { path, reason: 'symbol-keyed properties are not JSON fields' }
  }

  active.add(value)
  try {
    if (Array.isArray(value)) {
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

    if (!isPlainRecord(value)) return { path, reason: 'object must be a plain record' }

    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        return { path: propertyPath(path, key), reason: 'object fields must be enumerable data properties' }
      }
      const problem = findJsonProblem(descriptor.value, propertyPath(path, key), active)
      if (problem !== undefined) return problem
    }
    return undefined
  } finally {
    active.delete(value)
  }
}

/** Return whether a value can cross a JSON protocol without implicit coercion. */
export function isJsonValue(value: unknown): value is JsonValue {
  return findJsonProblem(value, '$', new Set()) === undefined
}

/**
 * Require a JSON-safe value.
 *
 * @throws {TypeError} with the first invalid path and reason.
 */
export function assertJsonValue(value: unknown, label = 'value'): asserts value is JsonValue {
  const problem = findJsonProblem(value, '$', new Set())
  if (problem !== undefined) {
    throw new TypeError(`${label}${problem.path.slice(1)}: ${problem.reason}`)
  }
}
