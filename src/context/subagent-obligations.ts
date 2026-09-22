import type { AgentSessionSnapshot } from '../agent/state.js'
import type { SessionEventId } from '../session/ids.js'
import type { AgentContextUnit } from './agent-sources.js'
import { agentDataMessage } from './agent-sources.js'

/** Required parent-local obligations remain present through compaction and history trimming. */
export function subagentObligationUnits(state: AgentSessionSnapshot, root: SessionEventId): readonly AgentContextUnit[] {
  if (state.spec?.payload.protocolVersion !== 2) return []
  return state.subagents.delegations.filter(item => item.payload.parentRoot === root).map(item => {
    const id = item.stored.eventId
    const observed = state.subagents.observations.filter(item => item.payload.delegation === id).at(-1)
    const inputs = state.inputs.filter(input => input.protocol?.delegation === id)
    return { reference: { eventId: id, selector: 'diagnostic' as const },
      sourceEventIds: [id, ...inputs.map(input => input.reference.eventId), ...(observed === undefined ? [] : [observed.stored.eventId])],
      messages: [agentDataMessage('subagent-obligation', id, { delegationId: id, childAddress: item.payload.childAddress,
        grant: item.payload.grant, deadline: item.payload.deadline, parentProtocolReserve: item.payload.parentProtocolReserve,
        business: observed?.payload.business ?? { kind: 'pending' }, resources: observed?.payload.resources ?? [],
        inputs: inputs.map(input => ({ kind: input.protocol!.kind, reference: input.reference, status: input.status, claimedBy: input.claimedBy })),
      })] }
  })
}
