import type { AgentRunSelection } from './contract.js'
import { sameWorkflowValue } from '../workflow/work-binding.js'
import { hasPendingAgentAbandon } from './input-ownership.js'
import type { MessageCatalog } from '../communication/message-catalog.js'
import type { AgentSessionSnapshot } from './state.js'
import { AgentError } from './errors.js'
import { referenceKey } from './input-codec.js'

/** Filter actionable inputs using the same ownership, message support and wait rules as selection. */
export function runnableAgentInputs(state: AgentSessionSnapshot, catalog: MessageCatalog, selection: AgentRunSelection = { kind: 'ordinary' }) {
  const spec = state.spec?.payload
  if (spec === undefined) throw new AgentError('AGENT_STATE_INVALID', 'missing-spec')
  return state.inputs.filter(input => {
    const waitRoot = input.reservedBy === null ? undefined : state.waits.find(wait => referenceKey(wait.reference) === referenceKey(input.reservedBy!))?.created.payload.result
    const root = waitRoot?.kind === 'wait' ? state.roots.find(root => root.id === waitRoot.descriptor.root) : undefined
    const assignment = input.work?.assignment ?? input.workMessage?.assignment ?? (root?.source.kind === 'workflow' ? root.source.assignment : undefined)
    if (selection.kind === 'ordinary' ? assignment !== undefined : assignment === undefined || !sameWorkflowValue(assignment, selection.assignment)) return false
    if (selection.kind === 'ordinary' && (state.roots.some(item => item.source.kind === 'workflow' && item.outcome === null)
      || state.inputs.some(item => item.work !== undefined && item.status === 'queued'))) return false
    if (hasPendingAgentAbandon(state.controls, input)) return false
    if (input.protocol?.kind === 'task' && (state.subagents.controls.length > 0 || state.roots.length > 0)) return false
    if (input.message !== null && (catalog.resolve(input.message.type, input.message.payloadVersion) === undefined
      || input.protocol === undefined && input.workMessage === undefined && !spec.messages.some(message => message.type === input.message!.type && message.payloadVersion === input.message!.payloadVersion))) return false
    if (input.status === 'queued' && input.workMessage !== undefined) return false
    if (input.status === 'queued') return input.protocol === undefined ? input.input?.kind !== 'answer' : input.protocol.kind === 'task'
    if (input.status !== 'reserved' || input.reservedBy === null) return false
    const wait = state.waits.find(wait => referenceKey(wait.reference) === referenceKey(input.reservedBy!))
    const result = wait?.created.payload.result
    if (result?.kind !== 'wait') return false
    const waitingRoot = state.roots.find(root => root.id === result.descriptor.root)
    return waitingRoot !== undefined && waitingRoot.outcome === null && waitingRoot.stopControl === null
  })
}

/** Persistent lane cursors and accepted sequence define the complete ordering. */
export function selectAgentInput(state: AgentSessionSnapshot, catalog: MessageCatalog, selection: AgentRunSelection = { kind: 'ordinary' }) {
  const candidates = runnableAgentInputs(state, catalog, selection)
  const spec = state.spec!.payload
  const lanes = new Map<string, typeof candidates[number]>()
  for (const input of candidates) {
    const previous = lanes.get(input.lane)
    if (previous === undefined || previous.sequence > input.sequence) lanes.set(input.lane, input)
  }
  if (lanes.size > spec.limits.maxLanes) throw new AgentError('AGENT_LIMIT_EXCEEDED', 'lane-capacity')
  const ordinal = (lane: string) => state.laneOrdinals.find(item => item.lane === lane)?.ordinal ?? 0
  return [...lanes.values()].sort((a, b) => ordinal(a.lane) - ordinal(b.lane) || a.sequence - b.sequence || (a.lane < b.lane ? -1 : a.lane > b.lane ? 1 : 0))[0] ?? null
}
