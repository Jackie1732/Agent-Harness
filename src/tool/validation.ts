import { types as nodeTypes } from 'node:util'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { boundedJson } from '../schema/bounded-json.js'
import type { ToolInvocationLimits, ToolProviderDescriptor, ToolSchemaLimits } from './contract.js'
import { ToolError } from './errors.js'

export function object(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as JsonObject
}
/** Read a required own data field without evaluating a getter or Proxy trap. */
export function dataField(value: unknown, name: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) invalid()
  const descriptor = Object.getOwnPropertyDescriptor(value, name)
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) invalid()
  return descriptor.value
}
export function exact(value: JsonObject, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional])
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !allowed.has(key))) invalid()
}
export function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && value.length === 0) || Buffer.byteLength(value) > maximum) invalid()
  return value
}
export function integer(value: unknown, minimum = 1): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || Object.is(value, -0)) invalid()
  return value
}
export function choice<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) invalid()
  return value as T
}
export function toolName(value: unknown): string {
  const result = text(value, 64)
  if (!/^[A-Za-z0-9_-]+$/.test(result)) invalid()
  return result
}
export function safeCode(value: unknown): string {
  const result = text(value, 64)
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(result)) invalid()
  return result
}
export function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid()
  return value
}
export function jsonBytes(value: JsonValue): number { return canonicalJsonBytes(value).byteLength }
export function equalJson(left: JsonValue, right: JsonValue): boolean {
  return Buffer.from(canonicalJsonBytes(left)).equals(Buffer.from(canonicalJsonBytes(right)))
}
export function invalid(): never { throw new ToolError('TOOL_REQUEST_INVALID', 'tool data has invalid or unsupported fields') }

const schemaFields = ['maxSchemaBytes', 'maxSchemaDepth', 'maxSchemaNodes'] as const
const invocationFields = [
  ...schemaFields, 'maxRequestBytes', 'maxPlanBytes', 'maxArgumentsBytes',
  'maxJsonDepth', 'maxJsonNodes', 'maxResultBytes', 'maxJournalConflicts',
] as const

/** Configuration is itself small, closed data; it is not an arbitrary options bag. */
export function readSchemaLimits(value: unknown): ToolSchemaLimits {
  const copy = object(boundedJson(value, { maxBytes: 2048, maxDepth: 2, maxNodes: 16 }))
  exact(copy, schemaFields)
  for (const field of schemaFields) integer(copy[field])
  if (integer(copy.maxSchemaDepth) > 128
    || !Number.isSafeInteger(2 * integer(copy.maxSchemaBytes) + 66560)
    || !Number.isSafeInteger(2 * integer(copy.maxSchemaNodes) + 16)) invalid()
  return copy as ToolSchemaLimits
}
export function readLimits(value: unknown): ToolInvocationLimits {
  const copy = object(boundedJson(value, { maxBytes: 4096, maxDepth: 2, maxNodes: 32 }))
  exact(copy, invocationFields)
  for (const field of invocationFields) integer(copy[field], field === 'maxJournalConflicts' ? 0 : 1)
  if (integer(copy.maxJsonDepth) > 128 || integer(copy.maxSchemaDepth) > 128 || integer(copy.maxResultBytes) < 128
    || !Number.isSafeInteger(2 * integer(copy.maxSchemaBytes) + 66560)
    || !Number.isSafeInteger(integer(copy.maxJsonNodes) + 2 * integer(copy.maxSchemaNodes) + 1024)
    || !Number.isSafeInteger(integer(copy.maxPlanBytes) + 1024)
    || !Number.isSafeInteger(integer(copy.maxResultBytes) + 256)) invalid()
  return copy as ToolInvocationLimits
}
export function argumentBudget(limits: ToolInvocationLimits) {
  return { maxBytes: limits.maxArgumentsBytes, maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes }
}
export function resultBudget(limits: ToolInvocationLimits) {
  return { maxBytes: limits.maxResultBytes, maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes }
}
export function readDescriptor(value: unknown): ToolProviderDescriptor {
  const copy = object(boundedJson(value, { maxBytes: 16384, maxDepth: 4, maxNodes: 512 }))
  exact(copy, ['providerId', 'adapterVersion', 'resourceId', 'tools', 'maxConcurrentExecutions', 'maxArgumentsBytes', 'maxResultBytes'])
  safeCode(copy.providerId); safeCode(copy.adapterVersion); safeCode(copy.resourceId)
  integer(copy.maxConcurrentExecutions); integer(copy.maxArgumentsBytes); integer(copy.maxResultBytes, 128)
  if (!Array.isArray(copy.tools) || copy.tools.length === 0 || copy.tools.length > 64) invalid()
  const support = new Set<string>()
  for (const entry of copy.tools) {
    const item = object(entry); exact(item, ['name', 'version'])
    const key = `${toolName(item.name)}@${integer(item.version)}`
    if (support.has(key)) invalid()
    support.add(key)
  }
  return copy as ToolProviderDescriptor
}

/** Decode the safe declarative fields that may cross a Tool consumer boundary. */
export const decodeToolProviderDescriptor = readDescriptor

/** The policy sees the same already-resolved limits later passed to acquire/start. */
export function effectiveLimits(limits: ToolInvocationLimits, provider: ToolProviderDescriptor): ToolInvocationLimits {
  return Object.freeze({ ...limits,
    maxArgumentsBytes: Math.min(limits.maxArgumentsBytes, provider.maxArgumentsBytes),
    maxResultBytes: Math.min(limits.maxResultBytes, provider.maxResultBytes),
  })
}
