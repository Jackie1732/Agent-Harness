/** Protocol-owned metadata seeds structural request forms; server authorization remains authoritative. */
import type { JsonObject, JsonValue } from '../foundation/json.js'
import type { ControlMethod, Params } from '../protocol/index.js'
import { decodeParams } from '../protocol/index.js'
import { PARAMS_SCHEMAS } from '../protocol/params-schemas.js'
import { schemaSeed } from './tree-model.js'

/**
 * Fill only explicitly observed identities into a complete editable request tree.
 * @param method Original control method.
 * @param known Fields from the currently selected actual target.
 * @returns Required owner-schema fields; payload content is an editable JSON value.
 */
export function requestDraft(method: ControlMethod, known: JsonObject = {}): JsonValue {
  const seed = schemaSeed(PARAMS_SCHEMAS[method]) as JsonObject
  const draft: Record<string, JsonValue> = { ...seed }
  for (const [key, value] of Object.entries(known)) if (Object.hasOwn(seed, key)) draft[key] = value
  if (method === 'session.events' && typeof known.agentKey === 'string') draft.target = { kind: 'member', agentKey: known.agentKey }
  if (Object.hasOwn(draft, 'payloadJson')) draft.payloadJson = {}
  return draft
}

/**
 * Encode structured message content and validate all fields with the existing parser.
 * @param method Original control method.
 * @param candidate Data-only form value.
 * @returns Original typed parameters, including branded parser-produced references.
 */
export function requestParams<M extends ControlMethod>(method: M, candidate: JsonValue): Params<M> {
  let value = candidate
  if ((method === 'message.send' || method === 'message.reply') && candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)) {
    const object = candidate as JsonObject
    value = { ...object, payloadJson: JSON.stringify(object.payloadJson ?? null) }
  }
  return decodeParams(method, value, { maxBytes: 16 * 1024 * 1024, maxDepth: 64, maxNodes: 200000 })
}

/** @param method Declared method. @returns Whether its cancellation needs an explicit UI confirmation. */
export function cancellationMethod(method: ControlMethod): boolean {
  return method === 'root.cancel' || method === 'delegation.cancel' || method === 'workflow.cancel' || method === 'host.shutdown'
}
