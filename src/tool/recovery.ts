import type { SessionHandle } from '../session/session-handle.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { ToolSettlement } from './contract.js'
import { ToolError } from './errors.js'
import { ToolJournal } from './journal.js'
import { toolSessionEventDefinitions } from './session-events.js'
import { integer } from './validation.js'

/**
 * Explicit management after the predecessor has stopped and released its Writer. Historical
 * approvals never call policy/acquire/start again. This is not cross-process fencing.
 */
export function recoverToolSession(session: SessionHandle, options: {
  readonly predecessorStopped: true
  readonly maxJournalConflicts: number
}): Promise<CommittedSessionEvent<ToolSettlement> | null> {
  if (options.predecessorStopped !== true) throw new ToolError('TOOL_REQUEST_INVALID', 'recovery requires confirmation that the predecessor stopped')
  const conflicts = integer(options.maxJournalConflicts, 0)
  if (!toolSessionEventDefinitions.every(definition => session.supportsEventDefinition(definition))) {
    throw new ToolError('TOOL_SESSION_CATALOG_INCOMPATIBLE', 'recovery requires the complete tool event catalog')
  }
  return new ToolJournal(session, conflicts).recover(pending => {
    const request = pending.requested.payload
    if (pending.state === 'decided' && pending.authorization.payload.decision.kind === 'deny') {
      return { invocationId: pending.invocationId, outcome: 'rejected', execution: 'not-started', emission: 'none',
        result: { kind: 'error', code: 'policy-denied' }, cleanup: { status: 'complete', attempted: 0, failed: 0 } }
    }
    const started = pending.state === 'started'
    return { invocationId: pending.invocationId, outcome: 'interrupted',
      execution: started ? 'may-have-executed' : 'not-started',
      emission: started && request.selection.kind === 'resolved' && request.selection.definition.operationClass === 'external'
        ? 'may-have-occurred' : 'none', result: { kind: 'none' },
      cleanup: { status: 'unknown-after-process-loss', attempted: null, failed: null } }
  })
}
