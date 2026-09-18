import type { JsonValue } from '../foundation/json.js'
import type { ModelInputMessage, ModelToolResultBlock } from '../model/contract.js'
import { composeModelExchange } from '../model/history-exchange.js'
import { projectModelSession } from '../model/projection.js'
import type { SessionSnapshot } from '../session/types.js'
import type { SessionEventId } from '../session/ids.js'
import { toolResultForModel } from '../tool/model-bridge.js'
import { projectToolSession } from '../tool/projection.js'
import { invalidAgent } from './errors.js'
import { projectAgentSession } from './projection.js'
import { referenceKey } from './input-codec.js'
import type { AgentSessionSnapshot } from './state.js'
import { record } from './validation.js'

/** Complete original calls plus one result per intent; no result text can create an action. */
export function agentActionHistory(snapshot: SessionSnapshot, decisionId: SessionEventId, state: AgentSessionSnapshot = projectAgentSession(snapshot)): readonly ModelInputMessage[] {
  const decision = state.steps.find(item => item.decided?.stored.eventId === decisionId)?.decided
  if (decision?.payload.model === null || decision === undefined || decision === null) return invalidAgent('history-decision-missing')
  const model = projectModelSession(snapshot).invocations.find(item => item.invocationId === decision.payload.model!.invocationId)
  if (model?.state !== 'settled') return invalidAgent('history-model-unsettled')
  if (decision.payload.classification === 'final') {
    const blocks = model.settled.payload.result.blocks
    const continuation = blocks.find(block => block.kind === 'continuation')
    if (blocks.filter(block => block.kind === 'continuation').length > 1) invalidAgent('history-continuation-count')
    return [{ role: 'assistant', content: blocks.flatMap(block => block.kind === 'text' ? [{ kind: 'text' as const, text: block.text }] : []),
      ...(continuation?.kind === 'continuation' ? { continuation: continuation.capsule } : {}) }]
  }
  if (decision.payload.classification !== 'actions') return [{ role: 'user', content: [{ kind: 'text',
    text: JSON.stringify({ kind: 'agent-model-diagnostic', decision: decisionId, reason: decision.payload.reason }) }] }]
  const tools = projectToolSession(snapshot).invocations
  const results: ModelToolResultBlock[] = decision.payload.actions.map((intent, index) => {
    const action = state.actions.find(item => referenceKey(item.payload.action) === referenceKey({ eventId: decisionId, index }))
    if (action === undefined) return invalidAgent('history-action-unsettled')
    const block = model.settled.payload.result.blocks.find(block => block.index === intent.source.outputBlockIndex)
    if (block?.kind !== 'tool-call') return invalidAgent('history-call-missing')
    const result = action.payload.result
    if (result.kind === 'tool') {
      const tool = tools.find(item => item.state === 'settled' && item.settled.stored.eventId === result.settled)
      if (tool === undefined) return invalidAgent('history-tool-missing')
      return toolResultForModel(snapshot, tool.invocationId)
    }
    let body: JsonValue = result
    if (result.kind === 'outbox') {
      const accepted = snapshot.history.at(-1)?.events.find(item => item.stored.eventId === result.accepted)
      if (accepted?.kind !== 'known') return invalidAgent('history-outbox-missing')
      const envelope = record(record(accepted.payload).envelope)
      body = { status: 'accepted', accepted: result.accepted, messageId: envelope.messageId!, recipient: envelope.recipient! }
    }
    return { kind: 'tool-result', callId: block.callId, source: intent.source, result: body,
      isError: result.kind === 'not-started' || result.kind === 'communication-not-accepted' }
  })
  const exchange = composeModelExchange(model.invocationId, model.settled.payload.result, results, invalidAgent)
  return [exchange.assistant, exchange.results]
}
