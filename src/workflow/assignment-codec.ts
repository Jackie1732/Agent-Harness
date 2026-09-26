import { decodeAgentBudget } from '../agent/budget.js'
import { AgentError } from '../agent/errors.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { boundedJson, JsonBoundaryError } from '../schema/bounded-json.js'
import { formatSessionAddress, formatSessionEventId, parseSessionAddress, parseSessionEventId } from '../session/ids.js'
import { SessionError } from '../session/errors.js'
import { DEFAULT_WORKFLOW_LIMITS } from './definition.js'
import { invalidHistory } from './errors.js'
import type { WorkflowAssignment, WorkflowEventRef } from './types.js'

function object(value: JsonValue, label: string): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') invalidHistory(`${label}-object`)
  return value as JsonObject
}
function exact(value: JsonObject, fields: readonly string[], label: string): void {
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) invalidHistory(`${label}-fields`)
}
function text(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || !value) invalidHistory(`${label}-text`)
  return value
}
function list(value: JsonValue | undefined, label: string): readonly JsonValue[] {
  if (!Array.isArray(value)) invalidHistory(`${label}-array`)
  return value
}
function reference(value: JsonValue): WorkflowEventRef {
  const item = object(value, 'source'); exact(item, ['address', 'eventId'], 'source')
  const event = parseSessionEventId(text(item.eventId, 'source.eventId'))
  const address = formatSessionAddress(parseSessionAddress(text(item.address, 'source.address')))
  if (formatSessionAddress(event.sessionId) !== address) invalidHistory('source-address')
  return { address,
    eventId: formatSessionEventId(event.sessionId, event.sequence) }
}
function quota(value: JsonValue, label: string): { readonly inbox: number; readonly outbox: number } {
  const item = object(value, label); exact(item, ['inbox', 'outbox'], label)
  if (!Number.isSafeInteger(item.inbox) || (item.inbox as number) < 0
    || !Number.isSafeInteger(item.outbox) || (item.outbox as number) < 0) invalidHistory(`${label}-value`)
  return { inbox: item.inbox as number, outbox: item.outbox as number }
}

/** Decode one bounded CP-W record; replay validates its relation to the frozen definition. */
export function decodeWorkflowAssignment(value: JsonValue): WorkflowAssignment & JsonObject {
  try { return decodeAssignment(value) }
  catch (cause) {
    if (cause instanceof AgentError || cause instanceof JsonBoundaryError || cause instanceof SessionError) invalidHistory('assignment-value')
    throw cause
  }
}

function decodeAssignment(value: JsonValue): WorkflowAssignment & JsonObject {
  const input = object(boundedJson(value, { maxBytes: DEFAULT_WORKFLOW_LIMITS.maxDefinitionBytes,
    maxDepth: DEFAULT_WORKFLOW_LIMITS.maxSchemaDepth + 8, maxNodes: DEFAULT_WORKFLOW_LIMITS.maxSchemaNodes }), 'assignment')
  exact(input, ['definition', 'nodeKey', 'attempt', 'kind', 'memberKey', 'memberAddress', 'inputs', 'sourceAccepted',
    'effectiveAllowance', 'reviewerReservations', 'toolNames', 'nativeActions', 'workspace', 'workspaceBaseline',
    'protocolReserve', 'deadline', 'acceptance'], 'assignment')
  if (input.kind !== 'production' || !Number.isSafeInteger(input.attempt) || (input.attempt as number) < 0) invalidHistory('assignment-kind-attempt')
  const reviewerReservations = list(input.reviewerReservations, 'reviewerReservations').map(value => {
    const item = object(value, 'reviewerReservation'); exact(item, ['memberKey', 'grant'], 'reviewerReservation')
    return { memberKey: text(item.memberKey, 'reviewer.memberKey'), grant: decodeAgentBudget(item.grant) }
  })
  const reserve = object(input.protocolReserve!, 'protocolReserve'); exact(reserve, ['coordinator', 'member'], 'protocolReserve')
  const deadline = text(input.deadline, 'deadline')
  if (!Number.isFinite(Date.parse(deadline)) || new Date(deadline).toISOString() !== deadline) invalidHistory('assignment-deadline')
  const workspaceBaseline = input.workspaceBaseline === null ? null : object(input.workspaceBaseline!, 'workspaceBaseline')
  const definition = parseSessionEventId(text(input.definition, 'definition'))
  return {
    definition: formatSessionEventId(definition.sessionId, definition.sequence),
    nodeKey: text(input.nodeKey, 'nodeKey'), attempt: input.attempt as number, kind: 'production',
    memberKey: text(input.memberKey, 'memberKey'),
    memberAddress: formatSessionAddress(parseSessionAddress(text(input.memberAddress, 'memberAddress'))),
    inputs: object(input.inputs!, 'inputs'), sourceAccepted: list(input.sourceAccepted, 'sourceAccepted').map(reference),
    effectiveAllowance: decodeAgentBudget(input.effectiveAllowance), reviewerReservations,
    toolNames: list(input.toolNames, 'toolNames').map(item => text(item, 'toolName')),
    nativeActions: list(input.nativeActions, 'nativeActions').map(item => text(item, 'nativeAction')),
    workspace: object(input.workspace!, 'workspace') as unknown as WorkflowAssignment['workspace'], workspaceBaseline,
    protocolReserve: { coordinator: quota(reserve.coordinator!, 'coordinator'), member: quota(reserve.member!, 'member') },
    deadline, acceptance: object(input.acceptance!, 'acceptance') as unknown as WorkflowAssignment['acceptance'],
  } as unknown as WorkflowAssignment & JsonObject
}
