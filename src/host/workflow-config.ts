import type { JsonObject, JsonValue } from '../foundation/json.js'
import { snapshotJson } from '../foundation/json.js'
import { formatSessionAddress, parseSessionId } from '../session/ids.js'
import { decodeWorkflowDefinition } from '../workflow/definition.js'
import type { WorkflowDefinition } from '../workflow/types.js'
import { HostError } from './errors.js'

export type HostWorkflowConfig = { readonly kind: 'disabled' } | {
  readonly kind: 'enabled'
  readonly definitions: readonly { readonly sessionId: string | null; readonly definition: JsonObject }[]
  readonly maxBusinessConcurrency: 1 | 2
}
export type ResolvedHostWorkflowConfig = { readonly kind: 'disabled' } | {
  readonly kind: 'enabled'
  readonly definitions: readonly { readonly sessionId: string; readonly definition: WorkflowDefinition }[]
  readonly maxBusinessConcurrency: 1 | 2
}

const planningAddress = 'ah-session:00000000-0000-4000-8000-000000000000'
function invalid(reason: string): never { throw new HostError('HOST_CONFIG_INVALID', reason) }
function object(value: unknown, label: string): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(`${label}-object`)
  return value as Record<string, JsonValue>
}
function exact(value: Record<string, JsonValue>, expected: readonly string[], label: string): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) invalid(`${label}-fields`)
}

/** Decode fixed coordinator recipes without allocating their Session identities. */
export function decodeHostWorkflows(value: unknown): HostWorkflowConfig {
  const input = object(value, 'workflows')
  if (input.kind === 'disabled') { exact(input, ['kind'], 'workflows'); return { kind: 'disabled' } }
  if (input.kind !== 'enabled') invalid('workflows-kind')
  exact(input, ['kind', 'definitions', 'maxBusinessConcurrency'], 'workflows')
  if (input.maxBusinessConcurrency !== 1 && input.maxBusinessConcurrency !== 2) invalid('workflow-concurrency')
  if (!Array.isArray(input.definitions) || input.definitions.length === 0 || input.definitions.length > 64) {
    invalid('workflow-definitions')
  }
  const definitions = input.definitions.map(value => {
    const entry = object(value, 'workflow-entry'); exact(entry, ['sessionId', 'definition'], 'workflow-entry')
    const sessionId = entry.sessionId === null ? null : parseSessionId(entry.sessionId as string)
    const raw = object(entry.definition, 'workflow-definition')
    const address = sessionId === null ? planningAddress : formatSessionAddress(sessionId)
    if (raw.coordinator !== (sessionId === null ? null : address)) invalid('workflow-coordinator-identity')
    const definition = decodeWorkflowDefinition({ ...raw, coordinator: address })
    return { sessionId, definition: snapshotJson({ ...definition, coordinator: sessionId === null ? null : address }) as JsonObject }
  })
  if (new Set(definitions.map(item => item.definition.workflowKey)).size !== definitions.length
    || new Set(definitions.flatMap(item => item.sessionId === null ? [] : [item.sessionId])).size
      !== definitions.filter(item => item.sessionId !== null).length) invalid('workflow-identity-duplicate')
  return { kind: 'enabled', definitions, maxBusinessConcurrency: input.maxBusinessConcurrency }
}
