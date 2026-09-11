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

function serializeCause(cause: unknown): JsonValue | undefined {
  if (cause === undefined) return undefined
  if (cause instanceof Error) return { name: cause.name, message: cause.message }
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
