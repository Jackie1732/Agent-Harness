import { HarnessError } from '../foundation/error.js'
import type { JsonObject } from '../foundation/json.js'

/** Stable categories; business errors are committed results rather than these exceptions. */
export type ToolErrorCode =
  | 'TOOL_REQUEST_INVALID' | 'TOOL_SCHEMA_INVALID' | 'TOOL_SOURCE_INVALID' | 'TOOL_SOURCE_NOT_ACTIONABLE'
  | 'TOOL_SESSION_BUSY' | 'TOOL_ID_CONFLICT' | 'TOOL_SESSION_CHANGED' | 'TOOL_SESSION_CATALOG_INCOMPATIBLE'
  | 'TOOL_REGISTRATION_CONFLICT' | 'TOOL_REGISTRATION_INACTIVE' | 'TOOL_BINDING_MISMATCH'
  | 'TOOL_POLICY_INVALID' | 'TOOL_PROVIDER_BUSY' | 'TOOL_PROVIDER_INACTIVE' | 'TOOL_PROVIDER_INVALID'
  | 'TOOL_RESULT_LIMIT' | 'TOOL_RESULT_INVALID' | 'TOOL_SOURCE_CHANGED' | 'TOOL_PATH_INVALID'
  | 'TOOL_JOURNAL_COMMIT_UNKNOWN' | 'TOOL_JOURNAL_WRITE_FAILED' | 'TOOL_CLEANUP_FAILED'
  | 'TOOL_STATE_INVALID' | 'TOOL_REENTRANT_WAIT' | 'TOOL_RUNNER_INACTIVE' | 'TOOL_CANCELLED'
  | 'TOOL_RECORD_BUDGET' | 'TOOL_WORKSPACE_INVALID' | 'TOOL_HISTORY_INCOMPLETE'

/** Diagnostics are deliberately selected by the runtime and never include the raw cause. */
export class ToolError extends HarnessError<ToolErrorCode> {
  constructor(code: ToolErrorCode, message: string, details?: JsonObject) {
    super(code, message, details === undefined ? {} : { details })
    this.name = 'ToolError'
  }
}
