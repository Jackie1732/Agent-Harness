import { modelSettledEvent } from '../model/session-events.js'
import type { AgentActionIntent } from './event-contract.js'
import type { AgentProjectionState } from './projection-state.js'
import { requireSpec, source } from './projection-state.js'
import { agentJson, record } from './validation.js'
import { invalidAgent } from './errors.js'

/** Only a complete persisted model tool-call supplies native action arguments. */
export function originalAgentActionArguments(state: AgentProjectionState, intent: AgentActionIntent) {
  const settled = [...state.sources.values()].find(item => item.stored.type === modelSettledEvent.type && record(item.payload).invocationId === intent.source.invocationId)
  if (settled === undefined) return invalidAgent('action-model-missing')
  const cp2 = source(state, settled.stored.eventId, modelSettledEvent)
  const block = cp2.payload.result.blocks.find(item => item.index === intent.source.outputBlockIndex)
  if (block?.kind !== 'tool-call' || Buffer.byteLength(block.argumentsText) > requireSpec(state).payload.limits.maxActionBytes) return invalidAgent('action-model-arguments')
  try { return record(agentJson(JSON.parse(block.argumentsText))) } catch { return invalidAgent('action-model-json') }
}
