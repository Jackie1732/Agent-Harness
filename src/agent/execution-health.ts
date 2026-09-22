import type { SessionSnapshot } from '../session/types.js'
import { projectModelSession } from '../model/projection.js'
import { projectToolSession } from '../tool/projection.js'
import { AgentError } from './errors.js'
import { projectAgentSession } from './projection.js'

/** Discarding an input cannot erase a resource whose release has not been confirmed. */
export function assertAgentExecutionQuiescent(snapshot: SessionSnapshot): void {
  const models = projectModelSession(snapshot)
  const tools = projectToolSession(snapshot)
  if (models.pendingInvocationId !== null || tools.pendingInvocationId !== null) throw new AgentError('AGENT_RECOVERY_REQUIRED', 'lower-execution-open')
  const state = projectAgentSession(snapshot)
  const reconciled = (sequence: number) => state.subagents.recoveries.some(item => item.settled?.payload.outcome === 'complete' && item.requested.payload.through >= sequence)
  if (models.invocations.some(item => item.state === 'settled' && item.settled.payload.cleanup.status !== 'complete' && !reconciled(item.prepared.stored.sequence))
    || tools.invocations.some(item => item.state === 'settled' && item.settled.payload.cleanup.status !== 'complete' && !reconciled(item.requested.stored.sequence))) throw new AgentError('AGENT_CLEANUP_FAILED', 'historical-release-unconfirmed')
}
