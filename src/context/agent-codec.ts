import { inputReference } from '../agent/input-codec.js'
import type { AgentContextAssembly, AgentContextConsumer } from './agent-contract.js'
import { decodeContextAssembly } from './assembly-codec.js'
import { array, contextJson, eventId, exact, record, unique } from './validation.js'

export function decodeAgentContextConsumer(value: unknown): AgentContextConsumer {
  const input = record(contextJson(value)); exact(input, ['spec', 'run', 'turn', 'step'])
  for (const key of ['spec', 'run', 'turn', 'step']) eventId(input[key])
  return input as AgentContextConsumer
}

/** v2 keeps the v1 accounting vocabulary while carrying an explicit Agent claim. */
export function decodeAgentContextAssembly(value: unknown, version: 2 | 3 = 2): AgentContextAssembly {
  const input = record(contextJson(value))
  const { consumer, claimedInput, requiredTurns, historyRoots, deferredInputs, ...base } = input
  decodeContextAssembly(base)
  decodeAgentContextConsumer(consumer); inputReference(claimedInput, version === 2 ? 1 : 2)
  unique(array(requiredTurns).map(eventId)); unique(array(historyRoots).map(eventId))
  unique(array(deferredInputs).map(item => { const ref = inputReference(item, version === 2 ? 1 : 2); return `${ref.kind}:${ref.eventId}` }))
  return input as AgentContextAssembly
}
