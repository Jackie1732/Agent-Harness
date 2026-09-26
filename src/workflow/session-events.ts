import { workflowControlEventDefinitions } from './control-events.js'
import { workflowRetryExpiredEvent } from './retry.js'
import { workflowStopEventDefinitions } from './stop-events.js'
import { workStoppedMessageEvent } from './stopped-message.js'
import { workGroupEventDefinitions } from './group-events.js'
import { workInputUnadoptedEvent } from './input-disposition.js'
import { workInteractionEventDefinitions, workflowInteractionAdmittedEvent, workflowInteractionSettledEvent } from './interaction-events.js'
import { workAssignmentSettledEvent } from './settlement-events.js'
import { workflowDefinitionRecordedEvent, workflowNodeResolvedEvent, workflowAssignmentCommittedEvent } from './definition-events.js'
import { workAssignmentAcceptedEvent } from './work-binding.js'
import { workResultEventDefinitions } from './result-events.js'
import { workflowCoordinatorEventDefinitions } from './coordinator-events.js'
import { workflowProtocolRecordedEvent, workProtocolRecordedEvent } from './protocol.js'
export { workflowDefinitionRecordedEvent, workflowNodeResolvedEvent, workflowAssignmentCommittedEvent } from './definition-events.js'
export type { WorkflowDefinitionRecorded, WorkflowNodeResolved } from './definition-events.js'

export const workflowSessionEventDefinitions = Object.freeze([workflowDefinitionRecordedEvent, workflowNodeResolvedEvent,
  workflowAssignmentCommittedEvent, workAssignmentAcceptedEvent, ...workResultEventDefinitions, ...workflowCoordinatorEventDefinitions,
  workflowProtocolRecordedEvent, workProtocolRecordedEvent, ...workflowControlEventDefinitions, ...workflowStopEventDefinitions, workflowRetryExpiredEvent, workAssignmentSettledEvent,
  ...workInteractionEventDefinitions, ...workGroupEventDefinitions, workInputUnadoptedEvent, workStoppedMessageEvent, workflowInteractionAdmittedEvent, workflowInteractionSettledEvent])
