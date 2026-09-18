import type { JsonObject } from '../foundation/json.js'
import { snapshotJson } from '../foundation/json.js'
import type { ModelInputMessage, ModelToolDefinition, ModelToolResultBlock } from '../model/contract.js'
import type { ModelInvocationId } from '../model/ids.js'
import { composeModelExchange } from '../model/history-exchange.js'
import { projectModelSession } from '../model/projection.js'
import type { SessionSnapshot } from '../session/types.js'
import type { ToolDefinition } from './contract.js'
import { ToolError } from './errors.js'
import type { ToolInvocationId } from './ids.js'
import { projectToolSession } from './projection.js'
import type { ToolInvocationSnapshot } from './projection.js'
import { modelSurface } from './source.js'

type Settled = Extract<ToolInvocationSnapshot, { state: 'settled' }>

/** Exactly the descriptor Model currently accepts; no hidden version/output-schema fields. */
export function describeToolForModel(definition: ToolDefinition): ModelToolDefinition {
  return modelSurface(definition)
}
function resultBlock(invocation: Settled): ModelToolResultBlock {
  const source = invocation.requested.payload.source
  if (source.kind !== 'model') throw new ToolError('TOOL_SOURCE_INVALID', 'direct tools have no model call association')
  const settled = invocation.settled.payload
  const success = settled.outcome === 'succeeded' && settled.cleanup.status === 'complete' && settled.failure === undefined
    && settled.result.kind === 'success'
  const envelope: JsonObject = success && settled.result.kind === 'success'
    ? { status: 'succeeded', value: settled.result.value, truncated: false }
    : { status: settled.cleanup.status === 'incomplete' ? 'failed' : settled.outcome,
      code: settled.cleanup.status === 'incomplete' ? 'TOOL_CLEANUP_FAILED'
        : settled.result.kind === 'error' ? settled.result.code : settled.failure?.code ?? settled.outcome,
      truncated: settled.outcome === 'incomplete' }
  return snapshotJson({ kind: 'tool-result', callId: source.callId, source: source.intent,
    result: envelope, isError: !success }) as ModelToolResultBlock
}

/** Pure projection of one local committed settlement. It does not construct or send a new request. */
export function toolResultForModel(snapshot: SessionSnapshot, invocationId: ToolInvocationId): ModelToolResultBlock {
  const invocation = projectToolSession(snapshot).invocations.find(item => item.invocationId === invocationId)
  if (invocation?.state !== 'settled') throw new ToolError('TOOL_HISTORY_INCOMPLETE', 'tool result is not durably settled')
  return resultBlock(invocation)
}

/**
 * Preserve all original assistant blocks and require one committed result for every call,
 * in original block order. Invalid original JSON is retained, never silently repaired.
 */
export function modelToolHistory(snapshot: SessionSnapshot, invocationId: ModelInvocationId): {
  readonly assistant: Extract<ModelInputMessage, { role: 'assistant' }>
  readonly results: Extract<ModelInputMessage, { role: 'user' }>
} {
  const model = projectModelSession(snapshot).invocations.find(item => item.invocationId === invocationId)
  if (model?.state !== 'settled' || model.settled.payload.outcome !== 'completed'
    || !model.settled.payload.result.protocolComplete || model.settled.payload.result.stopReason !== 'tool-calls'
    || model.settled.payload.cleanup.status !== 'complete' || model.settled.payload.cleanup.failedResources !== 0 || model.settled.payload.failure !== undefined) {
    throw new ToolError('TOOL_SOURCE_NOT_ACTIONABLE', 'model history is not a complete local tool-call result')
  }
  const tools = projectToolSession(snapshot).invocations
  const results: ModelToolResultBlock[] = []
  for (const block of model.settled.payload.result.blocks) {
    if (block.kind !== 'tool-call') continue
    const matches = tools.filter(item => {
      const source = item.requested.payload.source
      return source.kind === 'model' && source.intent.invocationId === invocationId && source.intent.outputBlockIndex === block.index
    })
    if (matches.length !== 1 || matches[0]?.state !== 'settled') throw new ToolError('TOOL_HISTORY_INCOMPLETE', 'every original assistant tool call requires exactly one committed result')
    const result = resultBlock(matches[0])
    if (result.callId !== block.callId) throw new ToolError('TOOL_STATE_INVALID', 'tool result differs from the original call identity')
    results.push(result)
  }
  return composeModelExchange(invocationId, model.settled.payload.result, results, reason => {
    throw new ToolError('TOOL_HISTORY_INCOMPLETE', reason)
  })
}
