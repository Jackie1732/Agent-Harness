import type { AgentInputReference } from '../agent/contract.js'
import type { SessionEventId } from '../session/ids.js'
import type { ContextAssembly } from './contract.js'

export type AgentContextConsumer = {
  readonly spec: SessionEventId
  readonly run: SessionEventId
  readonly turn: SessionEventId
  readonly step: SessionEventId
}

/** Explicit claim and closed causal chain are independently rebuilt from the pinned cut. */
export type AgentContextAssembly = ContextAssembly & {
  readonly consumer: AgentContextConsumer
  readonly claimedInput: AgentInputReference
  readonly requiredTurns: readonly SessionEventId[]
  readonly historyRoots: readonly SessionEventId[]
  readonly deferredInputs: readonly AgentInputReference[]
}
