import { HarnessError } from '../foundation/error.js'

export const subagentErrorCodes = [
  'SUBAGENT_REQUEST_INVALID', 'SUBAGENT_AUTHORITY_DENIED', 'SUBAGENT_BUDGET_EXHAUSTED',
  'SUBAGENT_STATE_INVALID', 'SUBAGENT_REQUEST_CONFLICT', 'SUBAGENT_CAPACITY',
  'SUBAGENT_COMMIT_UNKNOWN', 'SUBAGENT_RECOVERY_REQUIRED', 'SUBAGENT_INACTIVE',
] as const
export type SubagentErrorCode = typeof subagentErrorCodes[number]

/** Diagnostics carry bounded reason codes, never task text, paths or credentials. */
export class SubagentError extends HarnessError<SubagentErrorCode> {
  constructor(code: SubagentErrorCode, reason: string) {
    super(code, reason)
    this.name = 'SubagentError'
  }
}
