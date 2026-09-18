import type { AgentControlState, AgentInputState } from './state.js'
import { inputKey } from './input-codec.js'

/** Version 2 abandonment reserves disposition; version 1 history may contain a later claim. */
export function hasPendingAgentAbandon(controls: Iterable<AgentControlState>, input: AgentInputState, minimumVersion = 1): boolean {
  return [...controls].some(control => control.settled === null && control.supersededBy === null
    && control.requested.stored.payloadVersion >= minimumVersion && control.requested.payload.kind === 'abandon-input'
    && inputKey(control.requested.payload.input) === inputKey(input.reference))
}

/** A historical claim after a v1 request wins; recovery records a no-op without rewriting its disposition. */
export function legacyAbandonLostClaim(control: AgentControlState, input: AgentInputState, claimSequence: number | undefined): boolean {
  return control.requested.stored.payloadVersion === 1 && input.claimedBy !== null
    && claimSequence !== undefined && claimSequence > control.requested.stored.sequence
}
