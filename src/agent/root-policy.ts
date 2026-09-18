import { clockTimestamp } from '../foundation/clock.js'
import { projectAgentSession } from './projection.js'
import { agentControlRequestedEvent } from './session-events.js'
import type { AgentRuntime } from './runtime-contract.js'
import type { SessionSnapshot } from '../session/types.js'
import type { SessionEventId } from '../session/ids.js'
import type { AgentSessionSnapshot } from './state.js'
import { projectModelSession } from '../model/projection.js'

/** Usage uncertainty belongs to the entire root, including calls before a durable wait. */
export function agentRootUsageUnknown(snapshot: SessionSnapshot, state: AgentSessionSnapshot, root: SessionEventId): boolean {
  if (state.spec?.payload.usagePolicy !== 'stop-on-unknown') return false
  const turns = new Set(state.turns.filter(turn => turn.root === root).map(turn => turn.started.stored.eventId))
  const calls = new Set(state.steps.filter(step => turns.has(step.opened.payload.turn)).flatMap(step => step.decided?.payload.model == null ? [] : [step.decided.payload.model.invocationId]))
  return projectModelSession(snapshot).invocations.some(item => calls.has(item.invocationId)
    && item.state === 'settled' && item.settled.payload.result.usage.completeness !== 'complete')
}

/** Observe expiry only at driver boundaries; a concurrently committed stop or terminal wins. */
export async function expireAgentRoot(runtime: AgentRuntime, id: SessionEventId): Promise<void> {
  const current = () => projectAgentSession(runtime.session.snapshot()).roots.find(root => root.id === id)!
  const root = current()
  if (root.outcome !== null || root.stopControl !== null || clockTimestamp(runtime.clock) < root.deadline) return
  try {
    await runtime.journal.append(agentControlRequestedEvent, () => ({ kind: 'expire-work' as const, root: id,
      deadline: root.deadline, observedAt: clockTimestamp(runtime.clock), reason: 'root-deadline' }))
  } catch (error) {
    if (runtime.journal.faulted || current().outcome === null && current().stopControl === null) throw error
  }
}
