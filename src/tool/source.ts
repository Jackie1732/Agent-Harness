import type { JsonValue } from '../foundation/json.js'
import { isCanonicalUuid } from '../foundation/protocol-scalars.js'
import type { ModelIntentReference, ModelOutputBlock, ModelToolDefinition } from '../model/contract.js'
import { projectModelSession } from '../model/projection.js'
import type { ModelInvocationSnapshot } from '../model/projection.js'
import type { ModelInvocationId } from '../model/ids.js'
import { boundedJson, parseBoundedJson } from '../schema/bounded-json.js'
import type { SessionSnapshot } from '../session/types.js'
import type { ToolDefinition, ToolRequestedPayload, ToolSource } from './contract.js'
import { ToolError } from './errors.js'
import { argumentBudget, equalJson, exact, integer, object, text, toolName } from './validation.js'

export interface CommittedModelIntent {
  readonly source: Extract<ToolSource, { kind: 'model' }>
  readonly block: Extract<ModelOutputBlock, { kind: 'tool-call' }>
  readonly invocation: Extract<ModelInvocationSnapshot, { state: 'settled' }>
  readonly advertised: ModelToolDefinition | null
}

/** A reference is never accepted as a caller-supplied result or a validation claim. */
export function readIntentReference(value: unknown): ModelIntentReference {
  try {
    const copy = object(boundedJson(value, { maxBytes: 256, maxDepth: 2, maxNodes: 8 }))
    exact(copy, ['invocationId', 'outputBlockIndex'])
    if (!isCanonicalUuid(text(copy.invocationId, 36))) throw new TypeError('invalid id')
    integer(copy.outputBlockIndex, 0)
    return copy as ModelIntentReference
  } catch { throw new ToolError('TOOL_SOURCE_INVALID', 'model intent reference is invalid') }
}

function committedIntent(reference: ModelIntentReference, invocation: ModelInvocationSnapshot | undefined): CommittedModelIntent {
  if (invocation === undefined) throw new ToolError('TOOL_SOURCE_INVALID', 'model intent has no local source')
  if (invocation.state !== 'settled') throw new ToolError('TOOL_SOURCE_NOT_ACTIONABLE', 'model invocation is not durably settled')
  const settlement = invocation.settled.payload
  if (settlement.outcome !== 'completed' || !settlement.result.protocolComplete
    || settlement.result.stopReason !== 'tool-calls' || settlement.cleanup.status !== 'complete'
    || settlement.cleanup.failedResources !== 0 || settlement.failure !== undefined) {
    throw new ToolError('TOOL_SOURCE_NOT_ACTIONABLE', 'model result is not actionable')
  }
  const block = settlement.result.blocks.find(item => item.index === reference.outputBlockIndex)
  if (block?.kind !== 'tool-call' || !block.complete || block.argumentsStatus === 'partial') {
    throw new ToolError('TOOL_SOURCE_NOT_ACTIONABLE', 'reference is not a complete tool intent')
  }
  const source = Object.freeze({ kind: 'model' as const, intent: reference,
    preparedEventId: invocation.prepared.stored.eventId,
    settledEventId: invocation.settled.stored.eventId, callId: block.callId })
  return Object.freeze({ source, block, invocation,
    advertised: invocation.prepared.payload.submission.request.tools.find(tool => tool.name === block.name) ?? null })
}

function directSource(request: ToolRequestedPayload): null {
  toolName(request.name)
  if (request.arguments.kind !== 'json') throw new ToolError('TOOL_STATE_INVALID', 'direct request cannot impersonate model arguments')
  return null
}

function modelSource(request: ToolRequestedPayload, original: CommittedModelIntent, requestedSequence: number): CommittedModelIntent {
  if (!equalJson(request.source, original.source) || original.invocation.settled.stored.sequence >= requestedSequence
    || request.name !== original.block.name || request.arguments.kind !== 'text'
    || request.arguments.text !== original.block.argumentsText) {
    throw new ToolError('TOOL_STATE_INVALID', 'tool source snapshot differs from its earlier local model fact')
  }
  return original
}

/**
 * Own one lazy Model index for a fixed immutable Session snapshot; direct requests never load it.
 * @param snapshot The local facts validated on the first Model intent read.
 * @returns Source readers retained only for this snapshot's replay operation.
 */
export function createToolSourceReader(snapshot: SessionSnapshot): {
  readModelIntent(value: unknown): CommittedModelIntent
  validateRequestSource(request: ToolRequestedPayload, requestedSequence: number): CommittedModelIntent | null
} {
  let models: ReadonlyMap<ModelInvocationId, ModelInvocationSnapshot> | undefined
  const readModelIntent = (value: unknown): CommittedModelIntent => {
    const reference = readIntentReference(value)
    if (models === undefined) {
      try { models = new Map(projectModelSession(snapshot).invocations.map(item => [item.invocationId, item])) }
      catch { throw new ToolError('TOOL_SOURCE_INVALID', 'local model history is invalid') }
    }
    return committedIntent(reference, models.get(reference.invocationId))
  }
  return { readModelIntent,
    validateRequestSource(request, requestedSequence) {
      return request.source.kind === 'direct' ? directSource(request)
        : modelSource(request, readModelIntent(request.source.intent), requestedSequence)
    },
  }
}

/** Read only the current local committed Model state; no Model provider or network is involved. */
export function readModelIntent(snapshot: SessionSnapshot, value: unknown): CommittedModelIntent {
  const reference = readIntentReference(value)
  let invocation: ModelInvocationSnapshot | undefined
  try { invocation = projectModelSession(snapshot).invocations.find(item => item.invocationId === reference.invocationId) }
  catch { throw new ToolError('TOOL_SOURCE_INVALID', 'local model history is invalid') }
  return committedIntent(reference, invocation)
}

export function modelSurface(definition: ToolDefinition): ModelToolDefinition {
  return Object.freeze({ name: definition.name, description: definition.description, inputSchema: definition.inputSchema })
}

/** Cross-check recorded provenance during replay, including temporal order of source facts. */
export function validateRequestSource(request: ToolRequestedPayload, snapshot: SessionSnapshot, requestedSequence: number): CommittedModelIntent | null {
  return request.source.kind === 'direct' ? directSource(request)
    : modelSource(request, readModelIntent(snapshot, request.source.intent), requestedSequence)
}

/** Selection refusal is durable Tool feedback, unlike an unactionable Model source. */
export function selectionRejection(request: ToolRequestedPayload, original: CommittedModelIntent | null): string | null {
  if (original !== null && original.advertised === null) return 'not-advertised'
  if (request.selection.kind === 'missing') return 'tool-unavailable'
  if (original !== null && !equalJson(modelSurface(request.selection.definition), original.advertised!)) return 'surface-mismatch'
  return null
}

export function requestedArguments(request: ToolRequestedPayload): JsonValue {
  return request.arguments.kind === 'json'
    ? boundedJson(request.arguments.value, argumentBudget(request.limits))
    : parseBoundedJson(request.arguments.text, argumentBudget(request.limits))
}

export function sourceKey(source: ToolSource): string | null {
  return source.kind === 'direct' ? null : `${source.intent.invocationId}:${source.intent.outputBlockIndex}`
}
