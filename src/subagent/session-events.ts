import { workspaceBaselineRecordedEvent } from './workspace-events.js'
export { workspaceBaselineRecordedEvent } from './workspace-events.js'
import * as lifecycle from './lifecycle-codec.js'
import { createDurableEventDefinition } from '../session/event-catalog.js'
import { decodeChildBound, decodeChildReady, decodeDelegationRequested, decodeSubagentReleaseRecorded, decodeSubagentResourceOpened } from './event-codec.js'
import { decodeSubagentInputDisposed, decodeSubagentMessageClassified, decodeSubagentProtocolRecorded } from './protocol-codec.js'

export const delegationRequestedEvent = createDurableEventDefinition({
  type: 'subagent/delegation-requested', payloadVersion: 1, ignorable: false, decode: decodeDelegationRequested,
})
export const childBoundEvent = createDurableEventDefinition({ type: 'subagent/child-bound', payloadVersion: 1, ignorable: false, decode: decodeChildBound })
export const childReadyEvent = createDurableEventDefinition({ type: 'subagent/child-ready', payloadVersion: 1, ignorable: false, decode: decodeChildReady })
export const subagentResourceOpenedEvent = createDurableEventDefinition({ type: 'subagent/resource-opened', payloadVersion: 1, ignorable: false, decode: decodeSubagentResourceOpened })
export const subagentReleaseRecordedEvent = createDurableEventDefinition({ type: 'subagent/release-recorded', payloadVersion: 1, ignorable: false, decode: decodeSubagentReleaseRecorded })
export const subagentProtocolRecordedEvent = createDurableEventDefinition({ type: 'subagent/protocol-recorded', payloadVersion: 1, ignorable: false, decode: decodeSubagentProtocolRecorded })
export const subagentMessageClassifiedEvent = createDurableEventDefinition({ type: 'subagent/message-classified', payloadVersion: 1, ignorable: false, decode: decodeSubagentMessageClassified })
export const subagentInputDisposedEvent = createDurableEventDefinition({ type: 'subagent/input-disposed', payloadVersion: 1, ignorable: false, decode: decodeSubagentInputDisposed })
export const subagentProvisionSettledEvent = createDurableEventDefinition({ type: 'subagent/provision-settled', payloadVersion: 1, ignorable: false, decode: lifecycle.decodeProvisionSettled })
export const subagentDeliveryFailedEvent = createDurableEventDefinition({ type: 'subagent/delivery-failed', payloadVersion: 1, ignorable: false, decode: lifecycle.decodeDeliveryFailed })
export const subagentControlRequestedEvent = createDurableEventDefinition({ type: 'subagent/control-requested', payloadVersion: 1, ignorable: false, decode: lifecycle.decodeSubagentControlRequested })
export const subagentControlSettledEvent = createDurableEventDefinition({ type: 'subagent/control-settled', payloadVersion: 1, ignorable: false, decode: lifecycle.decodeSubagentControlSettled })
export const subagentSettlementObservedEvent = createDurableEventDefinition({ type: 'subagent/settlement-observed', payloadVersion: 1, ignorable: false, decode: lifecycle.decodeSettlementObserved })
export const subagentRecoveryRequestedEvent = createDurableEventDefinition({ type: 'subagent/recovery-requested', payloadVersion: 1, ignorable: false, decode: lifecycle.decodeRecoveryRequested })
export const subagentRecoverySettledEvent = createDurableEventDefinition({ type: 'subagent/recovery-settled', payloadVersion: 1, ignorable: false, decode: lifecycle.decodeRecoverySettled })
export const subagentSessionEventDefinitions = Object.freeze([
  workspaceBaselineRecordedEvent, subagentProvisionSettledEvent, subagentDeliveryFailedEvent, subagentControlRequestedEvent, subagentControlSettledEvent, subagentSettlementObservedEvent, subagentRecoveryRequestedEvent, subagentRecoverySettledEvent,
  delegationRequestedEvent, childBoundEvent, childReadyEvent, subagentResourceOpenedEvent, subagentReleaseRecordedEvent,
  subagentProtocolRecordedEvent, subagentMessageClassifiedEvent, subagentInputDisposedEvent,
])
