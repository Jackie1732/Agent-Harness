import { isCanonicalUuid } from '../foundation/protocol-scalars.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { boundedJson } from '../schema/bounded-json.js'
import { createDurableEventDefinition } from '../session/event-catalog.js'
import type { DurableEventDefinition } from '../session/event-catalog.js'
import { parseSessionEventId } from '../session/ids.js'
import type { ToolAuthorizationPayload, ToolRequestedPayload, ToolSettlement, ToolSource, ToolStartedPayload } from './contract.js'
import { decodeDefinition } from './definition.js'
import { ToolError } from './errors.js'
import { parseToolInvocationId } from './ids.js'
import { decodePlan, schemaLimits } from './plan.js'
import { argumentBudget, choice, dataField, exact, integer, invalid, jsonBytes, object, readDescriptor, readLimits, safeCode, text } from './validation.js'

function eventId(value: unknown): void { parseSessionEventId(text(value, 96)) }
export function decodeSource(value: JsonValue | undefined): ToolSource {
  const copy = object(value)
  choice(copy.kind, ['direct', 'model'])
  if (copy.kind === 'direct') exact(copy, ['kind'])
  else {
    exact(copy, ['kind', 'intent', 'preparedEventId', 'settledEventId', 'callId'])
    const intent = object(copy.intent); exact(intent, ['invocationId', 'outputBlockIndex'])
    if (!isCanonicalUuid(text(intent.invocationId, 36))) invalid()
    integer(intent.outputBlockIndex, 0); eventId(copy.preparedEventId); eventId(copy.settledEventId)
    text(copy.callId, 256)
  }
  return copy as ToolSource
}

export function decodeRequested(value: JsonValue): ToolRequestedPayload {
  const item = object(value)
  const limits = readLimits(dataField(value, 'limits'))
  const copy = object(boundedJson(item, { maxBytes: limits.maxRequestBytes, maxDepth: 128,
    maxNodes: limits.maxJsonNodes + 2 * limits.maxSchemaNodes + 1024 }))
  exact(copy, ['invocationId', 'source', 'name', 'arguments', 'selection', 'limits'])
  parseToolInvocationId(copy.invocationId); decodeSource(copy.source)
  // Invalid model-generated names remain bounded rejection data, not executable names.
  text(copy.name, 256)
  const args = object(copy.arguments)
  choice(args.kind, ['json', 'text'])
  if (args.kind === 'json') { exact(args, ['kind', 'value']); boundedJson(args.value, argumentBudget(limits)) }
  else { exact(args, ['kind', 'text']); text(args.text, limits.maxArgumentsBytes, true) }
  const selection = object(copy.selection)
  choice(selection.kind, ['missing', 'resolved'])
  if (selection.kind === 'missing') exact(selection, ['kind'])
  else {
    exact(selection, ['kind', 'definition', 'provider'])
    const definition = decodeDefinition(selection.definition, schemaLimits(limits))
    const provider = readDescriptor(selection.provider)
    if (definition.name !== copy.name || !provider.tools.some(tool => tool.name === definition.name && tool.version === definition.version)) invalid()
  }
  if (jsonBytes(copy) > limits.maxRequestBytes) invalid()
  return copy as ToolRequestedPayload
}

export function decodeDecision(value: unknown) {
  const copy = object(boundedJson(value, { maxBytes: 1024, maxDepth: 2, maxNodes: 8 }))
  exact(copy, ['kind', 'reasonCode']); choice(copy.kind, ['allow', 'deny']); safeCode(copy.reasonCode)
  return copy as import('./contract.js').ToolPolicyDecision
}
function decodeAuthorization(value: JsonValue): ToolAuthorizationPayload {
  const item = object(value)
  const plan = decodePlan(dataField(value, 'plan'))
  const copy = object(boundedJson(item, { maxBytes: plan.limits.maxPlanBytes + 1024, maxDepth: 128,
    maxNodes: plan.limits.maxJsonNodes + 2 * plan.limits.maxSchemaNodes + 1024 }))
  exact(copy, ['invocationId', 'requestedEventId', 'policy', 'decision', 'plan'])
  parseToolInvocationId(copy.invocationId); eventId(copy.requestedEventId)
  const policy = object(copy.policy); exact(policy, ['policyId', 'version']); safeCode(policy.policyId); integer(policy.version)
  decodeDecision(copy.decision)
  return copy as ToolAuthorizationPayload
}
function decodeStarted(value: JsonValue): ToolStartedPayload {
  const copy = object(boundedJson(value, { maxBytes: 1024, maxDepth: 2, maxNodes: 8 }))
  exact(copy, ['invocationId', 'authorizationEventId'])
  parseToolInvocationId(copy.invocationId); eventId(copy.authorizationEventId)
  return copy as ToolStartedPayload
}

/** Decode shape only here; predecessor, selection, output-schema, and budget checks belong to projection. */
export function decodeSettlement(value: JsonValue): ToolSettlement {
  const copy = object(value)
  exact(copy, ['invocationId', 'outcome', 'execution', 'emission', 'result', 'cleanup'], ['failure', 'receipt'])
  parseToolInvocationId(copy.invocationId)
  choice(copy.outcome, ['succeeded', 'rejected', 'failed', 'cancelled', 'incomplete', 'interrupted'])
  choice(copy.execution, ['not-started', 'may-have-executed', 'execution-observed'])
  choice(copy.emission, ['none', 'may-have-occurred', 'observed'])
  const result = object(copy.result); choice(result.kind, ['success', 'error', 'none'])
  if (result.kind === 'success') exact(result, ['kind', 'value'])
  else if (result.kind === 'error') { exact(result, ['kind', 'code']); safeCode(result.code) }
  else exact(result, ['kind'])
  const cleanup = object(copy.cleanup); exact(cleanup, ['status', 'attempted', 'failed'])
  choice(cleanup.status, ['complete', 'incomplete', 'unknown-after-process-loss'])
  if (cleanup.status === 'unknown-after-process-loss') {
    if (cleanup.attempted !== null || cleanup.failed !== null || copy.outcome !== 'interrupted') invalid()
  } else {
    const attempted = integer(cleanup.attempted, 0); const failed = integer(cleanup.failed, 0)
    if (failed > attempted || (cleanup.status === 'complete' ? failed !== 0 : failed === 0)) invalid()
  }
  if (copy.failure !== undefined) {
    const failure = object(copy.failure); exact(failure, ['code', 'phase']); safeCode(failure.code)
    choice(failure.phase, ['selection', 'validation', 'preparing', 'authorizing', 'acquiring', 'starting', 'executing', 'closing', 'committing', 'settled'])
  }
  if (copy.receipt !== undefined) {
    if (!/^[A-Za-z0-9._/-]+$/.test(text(copy.receipt, 128))) invalid()
    if (copy.emission !== 'observed' || copy.execution !== 'execution-observed') invalid()
  }
  if (copy.emission === 'observed' && copy.receipt === undefined) invalid()
  if (copy.execution === 'not-started' && copy.emission !== 'none') invalid()
  if (copy.outcome === 'succeeded' && (result.kind !== 'success' || copy.execution !== 'execution-observed' || copy.failure !== undefined)) invalid()
  if (copy.outcome === 'failed' && result.kind !== 'error') invalid()
  if (result.kind === 'success' && copy.outcome !== 'succeeded') invalid()
  if (copy.outcome === 'rejected' && (copy.execution !== 'not-started' || result.kind !== 'error')) invalid()
  if (copy.outcome === 'interrupted' && (result.kind !== 'none' || copy.execution === 'execution-observed' || copy.receipt !== undefined)) invalid()
  return copy as ToolSettlement
}

function event<T extends JsonObject>(type: string, decode: (value: JsonValue) => T): DurableEventDefinition<T> {
  return createDurableEventDefinition({ type, payloadVersion: 1, ignorable: false, decode: value => {
    try { return decode(value) } catch {
      throw new ToolError('TOOL_STATE_INVALID', 'tool durable fact has invalid fields')
    }
  } })
}
export const toolRequestedEvent = event('tool/invocation-requested', decodeRequested)
export const toolAuthorizationEvent = event('tool/authorization-decided', decodeAuthorization)
export const toolStartedEvent = event('tool/invocation-started', decodeStarted)
export const toolSettledEvent = event('tool/invocation-settled', decodeSettlement)

/** Required definitions to compose into the Session Catalog; no second Tool store. */
export const toolSessionEventDefinitions: readonly DurableEventDefinition[] = Object.freeze([
  toolRequestedEvent, toolAuthorizationEvent, toolStartedEvent, toolSettledEvent,
])
