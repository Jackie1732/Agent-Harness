import type { JsonObject, JsonValue } from '../foundation/json.js'
import { createDurableEventDefinition } from '../session/event-catalog.js'
import { parseSessionEventId } from '../session/ids.js'
import type { SessionEventId } from '../session/ids.js'
import { decodeWorkflowDefinition } from './definition.js'
import { invalidHistory } from './errors.js'
import type { WorkflowDefinition } from './types.js'

/** The complete immutable run definition, owned by the coordinator Session. */
export interface WorkflowDefinitionRecorded extends JsonObject {
  readonly definition: JsonObject
}

function decodeDefinitionRecorded(value: JsonValue): WorkflowDefinitionRecorded {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 1 || !Object.hasOwn(value, 'definition')) invalidHistory('definition-fields')
  const definition = decodeWorkflowDefinition((value as JsonObject).definition) as WorkflowDefinition
  return { definition: definition as unknown as JsonObject }
}

export const workflowDefinitionRecordedEvent = createDurableEventDefinition<WorkflowDefinitionRecorded>({
  type: 'workflow/definition-recorded', payloadVersion: 1, ignorable: false, decode: decodeDefinitionRecorded,
})

/** Terminal dependency or guard decision for one node in a frozen definition. */
export interface WorkflowNodeResolved extends JsonObject {
  readonly definition: SessionEventId
  readonly nodeKey: string
  readonly outcome: 'skipped' | 'failed'
  readonly reason: string
}

function decodeNodeResolved(value: JsonValue): WorkflowNodeResolved {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidHistory('node-resolution-object')
  const input = value as JsonObject
  if (Object.keys(input).length !== 4 || !Object.hasOwn(input, 'definition') || !Object.hasOwn(input, 'nodeKey')
    || !Object.hasOwn(input, 'outcome') || !Object.hasOwn(input, 'reason')) invalidHistory('node-resolution-fields')
  if (typeof input.definition !== 'string' || typeof input.nodeKey !== 'string' || typeof input.reason !== 'string'
    || !input.nodeKey || !input.reason || (input.outcome !== 'skipped' && input.outcome !== 'failed')) {
    invalidHistory('node-resolution-value')
  }
  parseSessionEventId(input.definition)
  return { definition: input.definition as SessionEventId, nodeKey: input.nodeKey,
    outcome: input.outcome, reason: input.reason }
}

export const workflowNodeResolvedEvent = createDurableEventDefinition<WorkflowNodeResolved>({
  type: 'workflow/node-resolved', payloadVersion: 1, ignorable: false, decode: decodeNodeResolved,
})

export const workflowSessionEventDefinitions = Object.freeze([workflowDefinitionRecordedEvent, workflowNodeResolvedEvent])
