import { HarnessError } from '../foundation/error.js'

/** Stable diagnostics contain protocol reasons, never arbitrary provider exceptions. */
export const agentErrorCodes = [
  'AGENT_SPEC_INVALID', 'AGENT_INPUT_INVALID', 'AGENT_STATE_INVALID', 'AGENT_SOURCE_INVALID',
  'AGENT_CATALOG_INCOMPATIBLE', 'AGENT_BUSY', 'AGENT_RECOVERY_BUSY', 'AGENT_RECOVERY_REQUIRED',
  'AGENT_INACTIVE', 'AGENT_CANCELLED', 'AGENT_REENTRANT_WAIT', 'AGENT_WAIT_INVALID',
  'AGENT_WAIT_TERMINAL', 'AGENT_LIMIT_EXCEEDED', 'AGENT_JOURNAL_CONFLICT',
  'AGENT_COMMIT_UNKNOWN', 'AGENT_WRITE_FAILED', 'AGENT_CLEANUP_FAILED',
  'AGENT_COMMUNICATION_UNAVAILABLE',
] as const
export type AgentErrorCode = typeof agentErrorCodes[number]

export class AgentError extends HarnessError<AgentErrorCode> {
  constructor(code: AgentErrorCode, reason: string) {
    super(code, reason)
    this.name = 'AgentError'
  }
}

export function invalidAgent(reason: string): never { throw new AgentError('AGENT_STATE_INVALID', reason) }
