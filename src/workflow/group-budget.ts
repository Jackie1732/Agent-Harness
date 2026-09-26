import type { AgentProjectionState } from '../agent/projection-state.js'
import type { AgentActionIntent } from '../agent/event-contract.js'
import type { SessionEventId } from '../session/ids.js'
import { modelSettledEvent } from '../model/session-events.js'
import { workAcceptanceForRoot } from './work-projection.js'
import { record } from '../agent/validation.js'
import { invalidHistory } from './errors.js'

/** Each distinct requested recipient reserves one message even when subsequent group admission is denied. */
export function groupMessageBudget(state: AgentProjectionState, root: SessionEventId, actions: readonly AgentActionIntent[]): number {
  let count = 0
  for (const action of actions) {
    if (action.route !== 'work-group') continue
    const source = [...state.sources.values()].find(item => item.stored.type === modelSettledEvent.type && record(item.payload).invocationId === action.source.invocationId)
    if (source === undefined) invalidHistory('group-budget-model-source')
    const model = modelSettledEvent.decode(source.payload)
    const block = model.result.blocks.find(block => block.index === action.source.outputBlockIndex)
    if (block?.kind !== 'tool-call') invalidHistory('group-budget-call-source')
    if (Buffer.byteLength(block.argumentsText) > state.spec!.payload.limits.maxActionBytes) continue
    let parsed: unknown
    try { parsed = JSON.parse(block.argumentsText) } catch (error) { if (error instanceof SyntaxError) continue; throw error }
    if (parsed === null || typeof parsed !== 'object' || !('targetNodeKeys' in parsed) || !Array.isArray(parsed.targetNodeKeys)
      || parsed.targetNodeKeys.some(key => typeof key !== 'string')) continue
    const own = workAcceptanceForRoot(state, root).work!.value.nodeKey
    count += new Set(parsed.targetNodeKeys.filter(key => key !== own)).size
  }
  return count
}
