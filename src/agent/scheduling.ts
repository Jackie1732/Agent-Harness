import { hasPendingAgentAbandon } from './input-ownership.js'
import type { MessageCatalog } from '../communication/message-catalog.js'
import type { AgentSessionSnapshot } from './state.js'
import { AgentError } from './errors.js'
import { referenceKey } from './input-codec.js'

/** Persistent lane cursors and accepted sequence define the complete ordering. */
export function selectAgentInput(state: AgentSessionSnapshot, catalog: MessageCatalog) {
  const spec = state.spec?.payload
  if (spec === undefined) throw new AgentError('AGENT_STATE_INVALID', 'missing-spec')
  const candidates = state.inputs.filter(input => {
    if (hasPendingAgentAbandon(state.controls, input)) return false
    if (input.message !== null && (catalog.resolve(input.message.type, input.message.payloadVersion) === undefined
      || !spec.messages.some(message => message.type === input.message!.type && message.payloadVersion === input.message!.payloadVersion))) return false
    if (input.status === 'queued') return input.input?.kind !== 'answer'
    if (input.status !== 'reserved' || input.reservedBy === null) return false
    const wait = state.waits.find(wait => referenceKey(wait.reference) === referenceKey(input.reservedBy!))
    const result = wait?.created.payload.result
    if (result?.kind !== 'wait') return false
    const root = state.roots.find(root => root.id === result.descriptor.root)
    return root !== undefined && root.outcome === null && root.stopControl === null
  })
  const lanes = new Map<string, typeof candidates[number]>()
  for (const input of candidates) {
    const previous = lanes.get(input.lane)
    if (previous === undefined || previous.sequence > input.sequence) lanes.set(input.lane, input)
  }
  if (lanes.size > spec.limits.maxLanes) throw new AgentError('AGENT_LIMIT_EXCEEDED', 'lane-capacity')
  const ordinal = (lane: string) => state.laneOrdinals.find(item => item.lane === lane)?.ordinal ?? 0
  return [...lanes.values()].sort((a, b) => ordinal(a.lane) - ordinal(b.lane) || a.sequence - b.sequence || (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0))[0] ?? null
}
