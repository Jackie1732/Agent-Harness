import type { AgentActionReference } from './contract.js'
import type { AgentActionIntent, AgentActionResult } from './event-contract.js'
import type { JsonObject } from '../foundation/json.js'
import type { SessionEventId } from '../session/ids.js'

/** A Host-installed domain consumer of committed native intents for one Session. */
export interface AgentNativeActionExecutor {
  execute(turn: SessionEventId, action: AgentActionReference, intent: AgentActionIntent, args: JsonObject, signal: AbortSignal): Promise<AgentActionResult>
}
