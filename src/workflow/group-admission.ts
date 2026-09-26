import type { WorkflowSnapshot } from './projection.js'
import type { WorkflowEventRef } from './types.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { workGroupRequestedEvent } from './group-events.js'
import { workflowInteractionAdmittedEvent } from './interaction-events.js'
import { sameWorkflowValue } from './work-binding.js'
import type { InteractionRejection } from './interactions.js'

export type GroupAdmission = Extract<ReturnType<typeof workflowInteractionAdmittedEvent.decode>, { kind: 'group' }>

/** Group admission atomically consumes the sender's group slot and every target's incoming slot. */
export function checkGroupAdmission(state: Pick<WorkflowSnapshot, 'definition' | 'assignments' | 'decisions' | 'interactions' | 'assignmentStops'>,
  value: GroupAdmission): InteractionRejection | undefined {
  const definition = state.definition!, recipe = definition.payload
  const sender = state.assignments.find(item => item.stored.eventId === value.assignment.eventId)
  const blocked = (reason: string): InteractionRejection => ({ outcome: 'blocked', reason, cycle: [] })
  if (value.definition !== definition.stored.eventId || sender?.payload.kind !== 'production' || value.assignment.address !== recipe.coordinator
    || value.request.address !== sender.payload.memberAddress || [...state.decisions, ...state.assignmentStops].some(item => sameWorkflowValue(item.payload.assignment, value.assignment))) return blocked('work-group-sender-unavailable')
  if (value.targets.length === 0 || value.targets.length > recipe.limits.maxGroupRecipients
    || new Set(value.targets.map(item => item.assignment.eventId)).size !== value.targets.length) return blocked('work-group-recipients')
  if (value.observedAt >= value.deadline || value.deadline > sender.payload.deadline) return blocked('work-group-expired')
  const groups = state.interactions.filter(item => item.admitted.payload.kind === 'group')
  if (groups.filter(item => sameWorkflowValue(item.admitted.payload.assignment, value.assignment)).length >= recipe.limits.maxGroups) return blocked('work-group-quota')
  let priorIndex = -1
  for (const target of value.targets) {
    const work = state.assignments.find(item => item.stored.eventId === target.assignment.eventId)
    if (work?.payload.kind !== 'production' || work.payload.nodeKey !== target.nodeKey || target.assignment.address !== recipe.coordinator
      || sameWorkflowValue(target.assignment, value.assignment) || [...state.decisions, ...state.assignmentStops].some(item => sameWorkflowValue(item.payload.assignment, target.assignment))) return blocked('work-group-peer-unavailable')
    const index = recipe.roster.findIndex(member => member.memberKey === work.payload.memberKey)
    if (index <= priorIndex) return blocked('work-group-roster-order')
    priorIndex = index
    if (!recipe.communication.groups.some(group => group.from === sender.payload.memberKey && group.recipients.includes(work.payload.memberKey))) return blocked('work-group-not-permitted')
    if (value.deadline > work.payload.deadline) return blocked('work-group-expired')
    if (groups.filter(item => item.admitted.payload.kind === 'group' && item.admitted.payload.targets.some(other => sameWorkflowValue(other.assignment, target.assignment))).length
      >= recipe.limits.maxIncomingGroupMessages) return blocked('work-group-incoming-quota')
  }
  if (state.interactions.some(item => sameWorkflowValue(item.admitted.payload.request, value.request))) return blocked('work-group-already-admitted')
  return undefined
}

export function selectGroupAdmission(state: WorkflowSnapshot, request: CommittedSessionEvent<ReturnType<typeof workGroupRequestedEvent.decode>>,
  observedAt: string): GroupAdmission | InteractionRejection {
  const p = request.payload, definition = state.definition!
  const targets: { nodeKey: string; assignment: WorkflowEventRef }[] = []
  let deadline = p.deadline
  for (const nodeKey of p.targetNodeKeys) {
    const work = state.assignments.filter(item => item.payload.kind === 'production' && item.payload.nodeKey === nodeKey).at(-1)
    if (work === undefined) return { outcome: 'blocked', reason: 'work-group-peer-not-assigned', cycle: [] }
    targets.push({ nodeKey, assignment: { address: definition.payload.coordinator, eventId: work.stored.eventId } })
    if (work.payload.deadline < deadline) deadline = work.payload.deadline
  }
  const value: GroupAdmission = { kind: 'group', definition: definition.stored.eventId, assignment: p.assignment,
    request: { address: state.assignments.find(item => item.stored.eventId === p.assignment.eventId)!.payload.memberAddress, eventId: request.stored.eventId },
    targets, observedAt, deadline }
  return checkGroupAdmission(state, value) ?? value
}
