import type { JsonObject } from '../foundation/json.js'
import { HarnessError } from '../foundation/error.js'

/** Stable automation failures contain no token, text, certificate or local path. */
export class AutomationError extends HarnessError<'AUTOMATION_CONFIG_INVALID' | 'AUTOMATION_CONFLICT' | 'AUTOMATION_LIMIT' | 'AUTOMATION_INACTIVE' | 'AUTOMATION_JOURNAL_INVALID'> {
  constructor(code: 'AUTOMATION_CONFIG_INVALID' | 'AUTOMATION_CONFLICT' | 'AUTOMATION_LIMIT' | 'AUTOMATION_INACTIVE' | 'AUTOMATION_JOURNAL_INVALID', message = code) {
    super(code, message); this.name = 'AutomationError'
  }
}
export function record(value: unknown, fields: readonly string[]): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AutomationError('AUTOMATION_CONFIG_INVALID')
  const result = value as JsonObject
  if (Object.keys(result).length !== fields.length || fields.some(field => !Object.hasOwn(result, field))) throw new AutomationError('AUTOMATION_CONFIG_INVALID')
  return result
}
export function text(value: unknown, maximum = 4096): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maximum) throw new AutomationError('AUTOMATION_CONFIG_INVALID')
  return value
}
export function key(value: unknown): string {
  const result = text(value, 32)
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(result)) throw new AutomationError('AUTOMATION_CONFIG_INVALID')
  return result
}
export function integer(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum || Object.is(value, -0)) throw new AutomationError('AUTOMATION_CONFIG_INVALID')
  return value
}
