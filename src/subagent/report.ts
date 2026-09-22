import type { SessionSnapshot } from '../session/types.js'
import type { SessionEventId } from '../session/ids.js'
import { projectAgentSession } from '../agent/projection.js'
import { delegationClosure } from './closure.js'
import { effectiveResourceRelease } from './resource-evidence.js'

/** Public parent facts only; counters use the full set before applying the presentation limit. */
export function delegationReport(parents: readonly { parentKey: string; snapshot: SessionSnapshot }[], limit: number,
  flags: (id: SessionEventId) => { suspended: boolean; recoveryRequired: boolean; failed: boolean; failureCode?: string | null }) {
  const delegations = parents.flatMap(({ parentKey, snapshot }) => {
    const state = projectAgentSession(snapshot)
    return state.subagents.delegations.map(event => {
      const id = event.stored.eventId
      const root = state.roots.find(root => root.id === event.payload.parentRoot)!
      const grants = state.subagents.delegations.filter(item => item.payload.parentRoot === root.id)
      const localReserved = { ...root.budget }
      for (const item of grants) for (const key of Object.keys(localReserved) as (keyof typeof localReserved)[]) localReserved[key] -= item.payload.grant[key]
      const observed = state.subagents.observations.filter(item => item.payload.delegation === id).at(-1)?.payload
      const generations = state.subagents.resources.filter(item => item.opened.payload.delegation === id)
      const resources = (['execution', 'protocol'] as const).flatMap(component => {
        const latest = generations.filter(item => item.opened.payload.component === component).at(-1)
        return latest === undefined ? [] : [latest]
      }).map(item => ({
        component: item.opened.payload.component, generation: item.opened.payload.generation,
        outcome: effectiveResourceRelease(item, state.subagents.recoveries)?.outcome ?? 'pending',
      }))
      const runtime = flags(id)
      const failed = runtime.failed || state.subagents.provisions.some(item => item.payload.delegation === id && item.payload.outcome !== 'installed')
        || state.subagents.failures.some(item => item.payload.delegation === id) || (observed?.deliveryFailures.length ?? 0) > 0
        || observed?.business.kind === 'terminal' && observed.business.outcome !== 'completed'
      return { delegationId: id, parentKey, parentRoot: root.id, childSessionId: event.payload.childSessionId, deadline: event.payload.deadline,
        grant: event.payload.grant, localReserved, parentProtocolReserve: event.payload.parentProtocolReserve,
        childModelUsage: observed?.modelUsage ?? null, parentResourceGenerations: generations.length,
        ...delegationClosure(state, id, snapshot.history.at(-1)!.events.filter(item => item.kind === 'known')),
        resultAvailable: state.inputs.some(item => item.protocol?.delegation === id && ['result', 'failure'].includes(item.protocol.kind)),
        pendingQuestions: state.inputs.filter(item => item.protocol?.delegation === id && item.protocol.kind === 'question' && ['queued', 'reserved'].includes(item.status)).length,
        parentResources: resources, childResources: observed?.resources ?? [],
        cleanupIncomplete: [...resources, ...observed?.resources ?? []].some(item => item.outcome === 'cleanup-incomplete'),
        ...runtime, failed,
      }
    })
  })
  const count = delegations.length
  const unresolved = delegations.filter(item => !item.closed).length
  const blocked = delegations.filter(item => item.recoveryRequired || item.cleanupIncomplete).length
  const failed = delegations.filter(item => item.failed).length
  const active = delegations.filter(item => !item.executionReleased).length
  const nextDeadline = delegations.filter(item => !item.businessResolved).map(item => item.deadline).sort()[0] ?? null
  return { count, unresolved, blocked, failed, active, nextDeadline, delegations: delegations.slice(0, limit), truncated: count > limit }
}
