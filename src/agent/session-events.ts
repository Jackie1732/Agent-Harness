import { invalidAgent } from './errors.js'
import { createDurableEventDefinition } from '../session/event-catalog.js'
import type { AgentEventPayloads, AgentMaintenanceRunSettled, AgentMaintenanceRunStarted } from './event-contract.js'
import { decodeAgentSpec, decodeSubagentAgentSpec } from './spec-codec.js'
import { decodeControlRequest, decodeControlSettled } from './control-codec.js'
import { decodeActionSettled, decodeCommandAccepted, decodeInputAccepted, decodeMaintenanceRunSettled, decodeMaintenanceRunStarted, decodeRunSettled, decodeRunStarted,
  decodeStepDecided, decodeStepOpened, decodeTurnSettled, decodeTurnStarted, decodeWaitSettled } from './event-codec.js'

function definition<K extends keyof AgentEventPayloads>(name: K, decode: (value: unknown) => AgentEventPayloads[K]) {
  return createDurableEventDefinition({ type: `agent/${name}`, payloadVersion: 1, ignorable: false, decode })
}
export const agentSpecRecordedEvent = definition('spec-recorded', decodeAgentSpec)
export const subagentAgentSpecRecordedEvent = createDurableEventDefinition({
  type: 'agent/spec-recorded', payloadVersion: 2, ignorable: false, decode: decodeSubagentAgentSpec,
})
export const agentInputAcceptedEvent = definition('input-accepted', decodeInputAccepted)
export const agentRunStartedEvent = definition('run-started', decodeRunStarted)
export const agentRunSettledEvent = definition('run-settled', decodeRunSettled)
/** Maintenance owns management writes without admitting Turns, commands, Models or Tools. */
export const agentMaintenanceRunStartedEvent = createDurableEventDefinition<AgentMaintenanceRunStarted>({
  type: 'agent/run-started', payloadVersion: 2, ignorable: false, decode: decodeMaintenanceRunStarted,
})
export const agentMaintenanceRunSettledEvent = createDurableEventDefinition<AgentMaintenanceRunSettled>({
  type: 'agent/run-settled', payloadVersion: 2, ignorable: false, decode: decodeMaintenanceRunSettled,
})
export const agentTurnStartedEvent = definition('turn-started', decodeTurnStarted)
export const subagentTurnStartedEvent = createDurableEventDefinition({ type: 'agent/turn-started', payloadVersion: 2, ignorable: false, decode: value => decodeTurnStarted(value, 2) })
export const subagentTurnSettledEvent = createDurableEventDefinition({ type: 'agent/turn-settled', payloadVersion: 2, ignorable: false, decode: decodeTurnSettled })
export const subagentStepDecidedEvent = createDurableEventDefinition({ type: 'agent/step-decided', payloadVersion: 2, ignorable: false, decode: value => decodeStepDecided(value, 2) })
export const agentTurnSettledEvent = definition('turn-settled', decodeTurnSettled)
export const agentStepOpenedEvent = definition('step-opened', decodeStepOpened)
export const agentStepDecidedEvent = definition('step-decided', decodeStepDecided)
export const agentActionSettledEvent = definition('action-settled', decodeActionSettled)
export const agentWaitSettledEvent = definition('wait-settled', decodeWaitSettled)
export const subagentActionSettledEvent = createDurableEventDefinition({ type: 'agent/action-settled', payloadVersion: 2, ignorable: false, decode: value => decodeActionSettled(value, 2) })
export const subagentWaitSettledEvent = createDurableEventDefinition({ type: 'agent/wait-settled', payloadVersion: 2, ignorable: false, decode: value => decodeWaitSettled(value, 2) })
export const agentCommandAcceptedEvent = definition('command-accepted', decodeCommandAccepted)
export const agentControlRequestedEvent = definition('control-requested', decodeControlRequest)
export const agentControlSettledEvent = definition('control-settled', decodeControlSettled)

/** Version 2 acquires input disposition before a driver can claim it. */
export const agentInputAbandonRequestedEvent = createDurableEventDefinition({ type: 'agent/control-requested', payloadVersion: 2, ignorable: false,
  decode: (value: unknown) => { const request = decodeControlRequest(value); if (request.kind !== 'abandon-input') invalidAgent('abandon-request-version'); return request } })
/** Version 3 keeps abandonment ownership and admits classified subagent inputs. */
export const subagentInputAbandonRequestedEvent = createDurableEventDefinition({ type: 'agent/control-requested', payloadVersion: 3, ignorable: false,
  decode: (value: unknown) => { const request = decodeControlRequest(value, 2); if (request.kind !== 'abandon-input') invalidAgent('abandon-request-version'); return request } })
/** Explicit compatibility settlement for a version 1 abandonment that lost to a claim. */
export const agentLegacyAbandonSettledEvent = createDurableEventDefinition({ type: 'agent/control-settled', payloadVersion: 2, ignorable: false,
  decode: (value: unknown) => { const result = decodeControlSettled(value); if (result.outcome !== 'no-op') invalidAgent('legacy-abandon-outcome'); return result } })

/** Required event versions keep data replay independent from execution providers. */
export const legacyAgentSessionEventDefinitions = Object.freeze([
  agentSpecRecordedEvent, agentInputAcceptedEvent, agentRunStartedEvent, agentRunSettledEvent,
  agentMaintenanceRunStartedEvent, agentMaintenanceRunSettledEvent,
  agentTurnStartedEvent, agentTurnSettledEvent, agentStepOpenedEvent, agentStepDecidedEvent,
  agentActionSettledEvent, agentWaitSettledEvent, agentCommandAcceptedEvent, agentControlRequestedEvent, agentControlSettledEvent, agentInputAbandonRequestedEvent, agentLegacyAbandonSettledEvent,
])
export const agentSessionEventDefinitions = Object.freeze([...legacyAgentSessionEventDefinitions, subagentAgentSpecRecordedEvent,
  subagentTurnStartedEvent, subagentTurnSettledEvent, subagentStepDecidedEvent, subagentActionSettledEvent, subagentWaitSettledEvent, subagentInputAbandonRequestedEvent])

/** Each persistent Spec selects its execution vocabulary once; maintenance keeps its original v2 events. */
export function agentExecutionEvents(version: 1 | 2) {
  return version === 1 ? {
    turnStarted: agentTurnStartedEvent, turnSettled: agentTurnSettledEvent, stepDecided: agentStepDecidedEvent,
    actionSettled: agentActionSettledEvent, waitSettled: agentWaitSettledEvent, abandonRequested: agentInputAbandonRequestedEvent,
  } : {
    turnStarted: subagentTurnStartedEvent, turnSettled: subagentTurnSettledEvent, stepDecided: subagentStepDecidedEvent,
    actionSettled: subagentActionSettledEvent, waitSettled: subagentWaitSettledEvent, abandonRequested: subagentInputAbandonRequestedEvent,
  }
}
