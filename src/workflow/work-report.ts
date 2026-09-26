import type { SessionSnapshot } from '../session/types.js'
import { projectAgentSession } from '../agent/projection.js'
import { projectModelSession } from '../model/projection.js'
import { projectToolSession } from '../tool/projection.js'
import { emptyAgentBudget } from '../agent/budget.js'
import { workExecutionReleasedEvent } from './result-events.js'
import { workGroupResultEvent } from './group-events.js'
import { projectWorkRecoveries } from './recovery-projection.js'

/** Attribute local execution facts to their actual work roots; unknown usage never becomes zero. */
export function workExecutionReports(snapshot: SessionSnapshot) {
  const agent = projectAgentSession(snapshot), models = projectModelSession(snapshot), tools = projectToolSession(snapshot)
  const events = snapshot.history.at(-1)!.events.filter(item => item.kind === 'known')
  const releases = events.filter(item => item.stored.type === workExecutionReleasedEvent.type).map(item => workExecutionReleasedEvent.decode(item.payload))
  const recoveries = projectWorkRecoveries(events)
  return agent.roots.flatMap(root => {
    if (root.source.kind !== 'workflow') return []
    const assignment = root.source.assignment
    const turns = agent.turns.filter(turn => turn.root === root.id)
    const belongs = (sequence: number) => turns.some(turn => sequence > turn.started.stored.sequence
      && (turn.settled === null || sequence < turn.settled.stored.sequence))
    const calls = models.invocations.filter(item => belongs(item.prepared.stored.sequence))
    const operations = tools.invocations.filter(item => belongs(item.requested.stored.sequence))
    const release = releases.filter(item => item.assignment.eventId === assignment.eventId).at(-1)
    const delegations = agent.subagents.delegations.filter(item => item.payload.parentRoot === root.id)
    const delegatedBudget = { ...emptyAgentBudget }, localReserved = { ...root.budget }
    for (const delegation of delegations) for (const key of Object.keys(delegatedBudget) as (keyof typeof delegatedBudget)[]) {
      delegatedBudget[key] += delegation.payload.grant[key]; localReserved[key] -= delegation.payload.grant[key]
    }
    const waits = agent.waits.filter(wait => wait.settled === null && turns.some(turn => turn.started.stored.eventId === wait.turn))
    const activeRecovery = recoveries.find(item => item.requested.payload.assignment.eventId === assignment.eventId && item.settled === null && item.supersededBy === null)
    const groups = events.filter(item => item.stored.type === workGroupResultEvent.type).map(item => workGroupResultEvent.decode(item.payload))
      .filter(item => events.some(request => request.stored.eventId === item.request && (request.payload as { root?: string }).root === root.id))
    return [{ assignment, root: root.id, outcome: root.outcome, allowance: root.limit, reserved: root.budget, localReserved, delegatedBudget,
      execution: release?.outcome ?? (root.outcome === null ? 'active' as const : 'release-pending' as const),
      recovery: activeRecovery?.requested.stored.eventId ?? agent.openRecovery,
      pendingWaits: waits.length, externalWaits: waits.filter(wait => wait.created.payload.result.kind === 'wait'
        && wait.created.payload.result.descriptor.kind === 'user').length,
      exhausted: root.outcome === 'budget-exhausted', unknown: root.outcome === 'result-unknown'
        || operations.some(item => item.state === 'settled' && item.settled.payload.execution === 'may-have-executed'),
      usage: { modelCalls: calls.length, toolCalls: operations.length,
        unknownCalls: calls.filter(item => item.state !== 'settled' || item.settled.payload.result.usage.completeness !== 'complete').length,
        inputTokens: calls.some(item => item.state !== 'settled' || item.settled.payload.result.usage.inputTokens === undefined) ? null
          : calls.reduce((sum, item) => sum + (item.state === 'settled' ? item.settled.payload.result.usage.inputTokens! : 0), 0),
        outputTokens: calls.some(item => item.state !== 'settled' || item.settled.payload.result.usage.outputTokens === undefined) ? null
          : calls.reduce((sum, item) => sum + (item.state === 'settled' ? item.settled.payload.result.usage.outputTokens! : 0), 0) },
      groups,
    }]
  })
}
