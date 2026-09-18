import type { AgentSpec } from './contract.js'
import type { AgentInputState, AgentTurnState, AgentSessionSnapshot } from './state.js'
import type { CommunicationFacts } from '../communication/types.js'
import type { SessionEventId } from '../session/ids.js'
import { inputKey } from './input-codec.js'

/** A root retains its claimed peer inputs across user questions and peer continuations. */
export function rootPeerInputs(root: SessionEventId, turns: readonly AgentTurnState[], inputs: readonly AgentInputState[]) {
  const claims = new Set(turns.filter(turn => turn.root === root).map(turn => inputKey(turn.started.payload.input)))
  return inputs.filter(input => input.message !== null && claims.has(inputKey(input.reference)))
}
export function requiresAgentReply(spec: AgentSpec, input: AgentInputState): boolean {
  return input.message !== null && spec.messages.some(kind => kind.type === input.message!.type && kind.payloadVersion === input.message!.payloadVersion && kind.requiresReply)
}

/** Only model actions from this root discharge its peer reply obligation. */
export function hasUnfulfilledAgentReply(root: SessionEventId, state: AgentSessionSnapshot, facts: CommunicationFacts): boolean {
  return rootPeerInputs(root, state.turns, state.inputs).some(input => requiresAgentReply(state.spec!.payload, input) && !state.actions.some(action => {
    const result = action.payload.result
    if (result.kind !== 'outbox') return false
    const step = state.steps.find(step => step.decided?.stored.eventId === action.payload.action.eventId)
    return state.turns.find(turn => turn.started.stored.eventId === step?.opened.payload.turn)?.root === root
      && facts.outbox.some(out => out.acceptedEventId === result.accepted && out.envelope.replyTo === input.message!.messageId)
  }))
}
