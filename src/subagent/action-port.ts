import type { AgentActionReference } from '../agent/contract.js'
import type { AgentActionIntent, AgentActionResult } from '../agent/event-contract.js'
import type { JsonObject } from '../foundation/json.js'
import type { SessionEventId } from '../session/ids.js'

/** A Host-installed consumer of committed native intents, scoped to one Session generation. */
export interface SubagentActionExecutor {
  execute(turn: SessionEventId, action: AgentActionReference, intent: AgentActionIntent, args: JsonObject, signal: AbortSignal): Promise<AgentActionResult>
}
