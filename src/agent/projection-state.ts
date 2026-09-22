import type { JsonValue } from '../foundation/json.js'
import type { DurableEventDefinition } from '../session/event-catalog.js'
import type { SessionEventId } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { AgentSpec } from './contract.js'
import type { AgentActionSettled, AgentCommandAccepted } from './event-contract.js'
import type { AgentControlState, AgentInputState, AgentRootState, AgentRunState, AgentStepState, AgentTurnState, AgentWaitState } from './state.js'
import { invalidAgent } from './errors.js'
import { referenceKey } from './input-codec.js'
import { initialSubagentState } from '../subagent/state.js'
import type { SubagentProjectionState } from '../subagent/state.js'

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** Internal replay accumulators; exported snapshots copy every mutable record. */
export interface AgentProjectionState {
  readonly subagents: SubagentProjectionState
  spec: CommittedSessionEvent<AgentSpec> | null
  readonly sources: Map<SessionEventId, CommittedSessionEvent>
  readonly runs: Map<SessionEventId, Mutable<AgentRunState>>
  readonly turns: Map<SessionEventId, Mutable<AgentTurnState>>
  readonly steps: Map<SessionEventId, Mutable<AgentStepState>>
  readonly actions: Map<string, CommittedSessionEvent<AgentActionSettled>>
  readonly waits: Map<string, Mutable<AgentWaitState>>
  readonly controls: Map<SessionEventId, Mutable<AgentControlState>>
  readonly commands: Map<SessionEventId, CommittedSessionEvent<AgentCommandAccepted>>
  readonly inputs: Map<string, Mutable<AgentInputState>>
  readonly roots: Map<SessionEventId, Mutable<AgentRootState>>
  readonly lanes: Map<string, number>
  openRun: SessionEventId | null
  openTurn: SessionEventId | null
  openRecovery: SessionEventId | null
  closing: SessionEventId | null
}
export function initialAgentState(): AgentProjectionState {
  return { spec: null, subagents: initialSubagentState(), sources: new Map(), runs: new Map(), turns: new Map(), steps: new Map(), actions: new Map(),
    waits: new Map(), controls: new Map(), commands: new Map(), inputs: new Map(), roots: new Map(), lanes: new Map(),
    openRun: null, openTurn: null, openRecovery: null, closing: null }
}
export function requireEntry<K, V>(map: ReadonlyMap<K, V>, key: K, reason: string): V {
  const value = map.get(key)
  if (value === undefined) invalidAgent(reason)
  return value
}
export function source<T extends JsonValue>(state: AgentProjectionState, id: SessionEventId, definition: DurableEventDefinition<T>): CommittedSessionEvent<T> {
  const event = requireEntry(state.sources, id, 'missing-or-future-source')
  if (event.stored.type !== definition.type || event.stored.payloadVersion !== definition.payloadVersion || event.stored.ignorable === true) invalidAgent('source-kind')
  return { ...event, payload: definition.decode(event.payload) }
}
export function requireSpec(state: AgentProjectionState): CommittedSessionEvent<AgentSpec> {
  if (state.spec === null) invalidAgent('missing-spec')
  return state.spec
}
export function requireOpenRun(state: AgentProjectionState, id: SessionEventId, kind?: 'drive' | 'command' | 'maintenance') {
  const run = requireEntry(state.runs, id, 'missing-run')
  if (state.openRun !== id || run.settled !== null || kind !== undefined && run.started.payload.kind !== kind) invalidAgent('run-not-open')
  return run
}
export function requireOpenTurn(state: AgentProjectionState, id: SessionEventId) {
  const turn = requireEntry(state.turns, id, 'missing-turn')
  if (state.openTurn !== id || turn.settled !== null) invalidAgent('turn-not-open')
  requireOpenRun(state, turn.started.payload.run, 'drive')
  return turn
}
export function stepClosed(state: AgentProjectionState, step: AgentStepState): boolean {
  const decision = step.decided
  return decision !== null && decision.payload.actions.every((_, index) => state.actions.has(referenceKey({ eventId: decision.stored.eventId, index })))
}
export function turnSteps(state: AgentProjectionState, turn: SessionEventId) {
  return [...state.steps.values()].filter(step => step.opened.payload.turn === turn)
}
