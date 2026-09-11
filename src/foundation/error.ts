import { assertJsonValue, isJsonValue } from './json.js'
import type { JsonObject, JsonValue } from './json.js'

/** Optional diagnostic fields for a structured Harness error. */
export interface HarnessErrorOptions extends ErrorOptions {
  readonly details?: JsonObject
}

/** JSON-safe diagnostic projection of a Harness error. */
export interface HarnessErrorJson {
  readonly name: string
  readonly code: string
  readonly message: string
  readonly details?: JsonObject
  readonly cause?: JsonValue
}

const MAX_CAUSE_DEPTH = 16

/**
 * Serialize an error cause to a JSON-safe value.
 *
 * @param cause - Cause to serialize.
 * @param active - Error objects in the current cause chain.
 * @param depth - Current cause depth.
 * @returns A bounded JSON-safe representation, or `undefined` for no cause.
 */
function serializeCause(
  cause: unknown,
  active: Set<Error> = new Set(),
  depth = 0,
): JsonValue | undefined {
  if (cause === undefined) return undefined

  if (cause instanceof Error) {
    if (active.has(cause)) return '[circular Error cause]'
    if (depth >= MAX_CAUSE_DEPTH) return '[Error cause depth limit reached]'
    active.add(cause)
    try {
      const nestedCause = serializeCause(cause.cause, active, depth + 1)
      return {
        name: cause.name,
        message: cause.message,
        ...(nestedCause === undefined ? {} : { cause: nestedCause }),
      }
    } finally {
      active.delete(cause)
    }
  }

  if (isJsonValue(cause)) return cause

  try {
    return String(cause)
  } catch {
    return '[unserializable cause]'
  }
}

/** Base error carrying a stable code and JSON-safe diagnostics. */
export class HarnessError<Code extends string = string> extends Error {
  readonly code: Code
  readonly details: JsonObject | undefined

  constructor(code: Code, message: string, options: HarnessErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'HarnessError'
    this.code = code
    if (options.details !== undefined) assertJsonValue(options.details, 'error details')
    this.details = options.details === undefined ? undefined : structuredClone(options.details)
  }

  /** Return the stable JSON-safe fields used by logs and protocol adapters. */
  toJSON(): HarnessErrorJson {
    const cause = serializeCause(this.cause)
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.details === undefined ? {} : { details: this.details }),
      ...(cause === undefined ? {} : { cause }),
    }
  }
}
