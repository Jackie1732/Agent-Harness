import { randomUUID } from 'node:crypto'
import type { Brand } from '../foundation/brand.js'
import { isCanonicalUuid } from '../foundation/protocol-scalars.js'
import { ToolError } from './errors.js'

/** One local, at-most-once dispatch opportunity, not an idempotency key for external systems. */
export type ToolInvocationId = Brand<string, 'ToolInvocationId'>
export interface ToolIdentitySource { nextInvocationId(): ToolInvocationId }

/** Strict, canonical lower-case UUID parsing. */
export function parseToolInvocationId(value: unknown): ToolInvocationId {
  if (typeof value !== 'string' || !isCanonicalUuid(value)) throw new ToolError('TOOL_REQUEST_INVALID', 'tool invocation identity is invalid')
  return value as ToolInvocationId
}

/** Default production identity source; tests and research callers may supply another source. */
export const systemToolIdentitySource: ToolIdentitySource = Object.freeze({
  nextInvocationId: (): ToolInvocationId => parseToolInvocationId(randomUUID()),
})
