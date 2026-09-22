import type { SubagentResourceState, SubagentRecoveryState } from './state.js'
import type { SessionEventId } from '../session/ids.js'

/** Recovery confirms that a stopped predecessor no longer owns resources; it never rewrites its execution outcome. */
export function effectiveResourceRelease(resource: SubagentResourceState, recoveries: Iterable<SubagentRecoveryState>):
  { readonly eventId: SessionEventId; readonly outcome: 'released' | 'cleanup-incomplete' | 'unknown'; readonly recovery: SessionEventId | null } | null {
  const recovery = [...recoveries].filter(item => item.requested.payload.through >= resource.opened.stored.sequence
    && item.settled?.payload.outcome === 'complete' && item.settled.payload.evidence.includes(resource.opened.stored.eventId)).at(-1)
  if (recovery?.settled != null) return { eventId: recovery.settled.stored.eventId, outcome: 'released', recovery: recovery.requested.stored.eventId }
  const released = resource.released
  return released === null ? null : { eventId: released.stored.eventId, outcome: released.payload.outcome, recovery: null }
}
