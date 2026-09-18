import { createDurableEventDefinition } from '../session/event-catalog.js'
import type { AgentEventPayloads } from './event-contract.js'
import { decodeAgentSpec } from './spec-codec.js'
import { decodeControlRequest, decodeControlSettled } from './control-codec.js'
import { decodeActionSettled, decodeCommandAccepted, decodeInputAccepted, decodeRunSettled, decodeRunStarted,
  decodeStepDecided, decodeStepOpened, decodeTurnSettled, decodeTurnStarted, decodeWaitSettled } from './event-codec.js'

function definition<K extends keyof AgentEventPayloads>(name: K, decode: (value: unknown) => AgentEventPayloads[K]) {
  return createDurableEventDefinition({ type: `agent/${name}`, payloadVersion: 1, ignorable: false, decode })
}
export const agentSpecRecordedEvent = definition('spec-recorded', decodeAgentSpec)
export const agentInputAcceptedEvent = definition('input-accepted', decodeInputAccepted)
export const agentRunStartedEvent = definition('run-started', decodeRunStarted)
export const agentRunSettledEvent = definition('run-settled', decodeRunSettled)
export const agentTurnStartedEvent = definition('turn-started', decodeTurnStarted)
export const agentTurnSettledEvent = definition('turn-settled', decodeTurnSettled)
export const agentStepOpenedEvent = definition('step-opened', decodeStepOpened)
export const agentStepDecidedEvent = definition('step-decided', decodeStepDecided)
export const agentActionSettledEvent = definition('action-settled', decodeActionSettled)
export const agentWaitSettledEvent = definition('wait-settled', decodeWaitSettled)
export const agentCommandAcceptedEvent = definition('command-accepted', decodeCommandAccepted)
export const agentControlRequestedEvent = definition('control-requested', decodeControlRequest)
export const agentControlSettledEvent = definition('control-settled', decodeControlSettled)

/** Required event versions keep data replay independent from execution providers. */
export const agentSessionEventDefinitions = Object.freeze([
  agentSpecRecordedEvent, agentInputAcceptedEvent, agentRunStartedEvent, agentRunSettledEvent,
  agentTurnStartedEvent, agentTurnSettledEvent, agentStepOpenedEvent, agentStepDecidedEvent,
  agentActionSettledEvent, agentWaitSettledEvent, agentCommandAcceptedEvent, agentControlRequestedEvent, agentControlSettledEvent,
])
