import { workflowControlEventDefinitions } from './control-events.js'
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
  workflowProtocolRecordedEvent, workProtocolRecordedEvent, ...workflowControlEventDefinitions, workAssignmentSettledEvent])
