import type { ModelContinuation, ModelInputMessage, ModelIntentReference } from '../model/contract.js'
import type { ModelInvocationId } from '../model/ids.js'
import type { ModelInvocationSnapshot, ModelSessionSnapshot } from '../model/projection.js'
import type { SessionEventId } from '../session/ids.js'
import type { SessionSnapshot } from '../session/types.js'
import { modelToolHistory } from '../tool/model-bridge.js'
import type { ToolInvocationSnapshot, ToolSessionSnapshot } from '../tool/projection.js'
import type { ContextContinuationIdentity, ContextToolIntentMetadata, ContextToolOutcomeMetadata, ContextUnitReference } from './contract.js'
import { invalidState } from './errors.js'
import { dataNote } from './render.js'
import type { ContextUnit } from './unit.js'

export type SettledModel = Extract<ModelInvocationSnapshot, { state: 'settled' }>
export type SettledTool = Extract<ToolInvocationSnapshot, { state: 'settled' }>

export function modelComplete(model: SettledModel): boolean {
  const value = model.settled.payload
  return value.outcome === 'completed' && value.result.protocolComplete && value.cleanup.status === 'complete'
    && value.cleanup.failedResources === 0 && value.failure === undefined
}
export function capsuleIdentity(capsule: ModelContinuation | undefined): ContextContinuationIdentity | null {
  return capsule === undefined ? null : { namespace: capsule.namespace, version: capsule.version, providerId: capsule.providerId, model: capsule.model }
}
export function modelEventIds(model: SettledModel): SessionEventId[] {
  return [model.prepared.stored.eventId, ...('started' in model && model.started !== undefined ? [model.started.stored.eventId] : []), model.settled.stored.eventId]
}
export function toolEventIds(tool: SettledTool): SessionEventId[] {
  return [tool.requested.stored.eventId, ...(tool.authorization === undefined ? [] : [tool.authorization.stored.eventId]),
    ...(tool.started === undefined ? [] : [tool.started.stored.eventId]), tool.settled.stored.eventId]
}
export function toolOutcome(tool: SettledTool): ContextToolOutcomeMetadata {
  const value = tool.settled.payload
  return { invocationId: tool.invocationId, requestedEventId: tool.requested.stored.eventId, settledEventId: tool.settled.stored.eventId,
    outcome: value.outcome, execution: value.execution, emission: value.emission, cleanup: value.cleanup,
    operationClass: tool.requested.payload.selection.kind === 'resolved' ? tool.requested.payload.selection.definition.operationClass : null }
}

/** Whole model/tool exchanges come from the existing public bridge, not a parallel renderer. */
export function modelHistoryUnits(
  snapshot: SessionSnapshot, models: ModelSessionSnapshot, tools: ToolSessionSnapshot, ordinal: number,
  summaryInvocations: ReadonlySet<ModelInvocationId> = new Set(),
): { readonly units: readonly ContextUnit[]; readonly missing: readonly ContextUnitReference[]; readonly missingIntents: readonly ModelIntentReference[] } {
  const units: ContextUnit[] = []
  const missing: ContextUnitReference[] = []
  const missingIntents: ModelIntentReference[] = []
  for (const model of models.invocations) {
    if (model.state !== 'settled') continue
    const settlement = model.settled.payload
    const blocks = settlement.result.blocks
    const identity = { invocationId: model.invocationId, preparedEventId: model.prepared.stored.eventId, settledEventId: model.settled.stored.eventId }
    const diagnosticMetadata = { kind: 'diagnostic' as const, invocationId: model.invocationId, outcome: settlement.outcome,
      protocolComplete: settlement.result.protocolComplete, stopReason: settlement.result.stopReason, cleanup: settlement.cleanup }
    const diagnosticRef = { eventId: model.settled.stored.eventId, selector: 'diagnostic' as const }
    const diagnosticBody = { text: blocks.filter(block => block.kind === 'text').map(block => ({ index: block.index, text: block.text, complete: block.complete })),
      omittedKinds: blocks.filter(block => block.kind !== 'text').map(block => ({ kind: block.kind, index: block.index })) }
    units.push({ reference: diagnosticRef, sourceEventIds: modelEventIds(model), segmentOrdinal: ordinal,
      closureSequence: model.settled.stored.sequence, metadata: diagnosticMetadata, body: diagnosticBody,
      canonicalSource: settlement, rawMessages: [dataNote('diagnostic', diagnosticRef, diagnosticMetadata, diagnosticBody)], optionalHistory: false, compactable: false })
    if (!modelComplete(model)) continue
    if (settlement.result.stopReason === 'stop') {
      if (blocks.some(block => !block.complete || block.kind === 'tool-call')) continue
      const text = blocks.filter(block => block.kind === 'text')
      const continuation = blocks.filter(block => block.kind === 'continuation')
      if (text.length === 0 || continuation.length > 1) continue
      const capsule = continuation[0]?.capsule
      const message: ModelInputMessage = { role: 'assistant', content: text.map(block => ({ kind: 'text', text: block.text })),
        ...(capsule === undefined ? {} : { continuation: capsule }) }
      const metadata = { kind: 'assistant-response' as const, ...identity, continuation: capsuleIdentity(capsule) }
      units.push({ reference: { eventId: model.settled.stored.eventId, selector: 'assistant-response' }, sourceEventIds: modelEventIds(model),
        segmentOrdinal: ordinal, closureSequence: model.settled.stored.sequence, metadata,
        body: text.map(block => block.text).join('\n\n'), canonicalSource: { metadata, message }, rawMessages: [message], optionalHistory: !summaryInvocations.has(model.invocationId), compactable: !summaryInvocations.has(model.invocationId) })
    } else if (settlement.result.stopReason === 'tool-calls') {
      const reference = { eventId: model.settled.stored.eventId, selector: 'tool-exchange' as const }
      const results: SettledTool[] = []
      const intents: ContextToolIntentMetadata[] = []
      let open = false
      for (const block of blocks) {
        if (block.kind !== 'tool-call') continue
        const result = tools.invocations.find(item => item.requested.payload.source.kind === 'model'
          && item.requested.payload.source.intent.invocationId === model.invocationId && item.requested.payload.source.intent.outputBlockIndex === block.index)
        if (result?.state !== 'settled') {
          open = true; missingIntents.push({ invocationId: model.invocationId, outputBlockIndex: block.index }); continue
        }
        if (!block.complete || block.argumentsStatus === 'partial') invalidState('closed-tool-block')
        results.push(result); intents.push({ outputBlockIndex: block.index, callId: block.callId, name: block.name,
          argumentsStatus: block.argumentsStatus, result: toolOutcome(result) })
      }
      if (open) { missing.push(reference); continue }
      const history = modelToolHistory(snapshot, model.invocationId)
      const metadata = { kind: 'tool-exchange' as const, ...identity, intents, continuation: capsuleIdentity(history.assistant.continuation) }
      const messages = [history.assistant, history.results]
      const eventIds = [...modelEventIds(model), ...results.flatMap(toolEventIds)]
      units.push({ reference, sourceEventIds: eventIds, segmentOrdinal: ordinal,
        closureSequence: Math.max(model.settled.stored.sequence, ...results.map(tool => tool.settled.stored.sequence)),
        metadata, body: messages, canonicalSource: { metadata, messages }, rawMessages: messages, optionalHistory: !summaryInvocations.has(model.invocationId), compactable: !summaryInvocations.has(model.invocationId) })
    }
  }
  for (const tool of tools.invocations) {
    if (tool.state !== 'settled' || tool.requested.payload.source.kind !== 'direct') continue
    const settled = tool.settled.payload
    const good = settled.outcome === 'succeeded' && settled.cleanup.status === 'complete' && settled.cleanup.failed === 0
      && settled.failure === undefined && settled.result.kind === 'success'
    const body = good && settled.result.kind === 'success' ? { status: 'succeeded', value: settled.result.value, truncated: false }
      : { status: settled.cleanup.status !== 'complete' ? 'failed' : settled.outcome,
        code: settled.cleanup.status !== 'complete' ? 'TOOL_CLEANUP_FAILED' : settled.result.kind === 'error' ? settled.result.code : settled.failure?.code ?? settled.outcome,
        truncated: settled.outcome === 'incomplete' }
    const reference = { eventId: tool.settled.stored.eventId, selector: 'tool-observation' as const }
    const metadata = { kind: 'tool-observation' as const, result: toolOutcome(tool) }
    units.push({ reference, sourceEventIds: toolEventIds(tool), segmentOrdinal: ordinal, closureSequence: tool.settled.stored.sequence,
      metadata, body, canonicalSource: { metadata, result: settled.result, failure: settled.failure ?? null },
      rawMessages: [dataNote('tool-observation', reference, metadata, body)], optionalHistory: false, compactable: true })
  }
  return { units, missing, missingIntents }
}
