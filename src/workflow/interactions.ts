import type { CommittedSessionEvent } from '../session/types.js'
import type { WorkflowSnapshot } from './projection.js'
import { workflowInteractionAdmittedEvent, workQuestionRequestedEvent } from './interaction-events.js'
import { sameWorkflowValue } from './work-binding.js'
import type { WorkflowEventRef } from './types.js'

export type InteractionAdmission = Extract<ReturnType<typeof workflowInteractionAdmittedEvent.decode>, { kind: 'question' }>
export type InteractionRejection = { readonly outcome: 'blocked'; readonly reason: string; readonly cycle: readonly WorkflowEventRef[] }

/** All active question edges and both quota debits are evaluated against the same coordinator prefix. */
export function checkWorkflowInteraction(state: Pick<WorkflowSnapshot, 'definition' | 'assignments' | 'decisions' | 'interactions' | 'assignmentStops'>,
  value: InteractionAdmission): InteractionRejection | undefined {
  const definition = state.definition!
  const sender = state.assignments.find(item => item.stored.eventId === value.assignment.eventId)
  const target = state.assignments.find(item => item.stored.eventId === value.targetAssignment.eventId)
  const blocked = (reason: string, cycle: readonly WorkflowEventRef[] = []): InteractionRejection => ({ outcome: 'blocked', reason, cycle })
  if (value.definition !== definition.stored.eventId || sender?.payload.kind !== 'production' || target?.payload.kind !== 'production'
    || value.assignment.address !== definition.payload.coordinator || value.targetAssignment.address !== definition.payload.coordinator
    || value.request.address !== sender.payload.memberAddress || sameWorkflowValue(value.assignment, value.targetAssignment)
    || [...state.decisions, ...state.assignmentStops].some(item => [value.assignment.eventId, value.targetAssignment.eventId].includes(item.payload.assignment.eventId))) return blocked('work-peer-unavailable')
  if (!definition.payload.communication.ask.some(pair => pair.from === sender.payload.memberKey && pair.to === target.payload.memberKey)) return blocked('work-question-not-permitted')
  if (value.observedAt >= value.deadline || value.deadline > sender.payload.deadline || value.deadline > target.payload.deadline) return blocked('work-question-expired')
  const questions = state.interactions.filter(item => item.admitted.payload.kind === 'question')
  const outgoing = questions.filter(item => sameWorkflowValue(item.admitted.payload.assignment, value.assignment))
  const incoming = questions.filter(item => item.admitted.payload.kind === 'question' && sameWorkflowValue(item.admitted.payload.targetAssignment, value.targetAssignment))
  if (outgoing.length >= definition.payload.limits.maxQuestions || incoming.length >= definition.payload.limits.maxIncomingQuestions) return blocked('work-question-quota')
  if (state.interactions.some(item => sameWorkflowValue(item.admitted.payload.request, value.request))) return blocked('work-question-already-admitted')
  const active = state.interactions.filter(item => item.settled === null).map(item => item.admitted.payload).filter(item => item.kind === 'question')
  const visited = new Set<string>()
  const visit = (node: WorkflowEventRef, path: readonly WorkflowEventRef[]): readonly WorkflowEventRef[] | undefined => {
    if (sameWorkflowValue(node, value.assignment)) return path
    if (visited.has(node.eventId)) return undefined
    visited.add(node.eventId)
    for (const edge of active.filter(item => sameWorkflowValue(item.assignment, node))) {
      if (path.some(prior => sameWorkflowValue(prior, edge.targetAssignment))) continue
      const found = visit(edge.targetAssignment, [...path, edge.targetAssignment])
      if (found !== undefined) return found
    }
    return undefined
  }
  const path = visit(value.targetAssignment, [value.targetAssignment])
  return path === undefined ? undefined : blocked('work-wait-cycle', [value.assignment, ...path])
}

export function selectQuestionAdmission(state: WorkflowSnapshot, request: CommittedSessionEvent<ReturnType<typeof workQuestionRequestedEvent.decode>>,
  observedAt: string): InteractionAdmission | InteractionRejection {
  const p = request.payload
  const target = state.assignments.filter(item => item.payload.kind === 'production' && item.payload.nodeKey === p.targetNodeKey).at(-1)
  if (target === undefined) return { outcome: 'blocked', reason: 'work-peer-not-assigned', cycle: [] }
  const value: InteractionAdmission = { kind: 'question', definition: state.definition!.stored.eventId, assignment: p.assignment,
    request: { address: state.assignments.find(item => item.stored.eventId === p.assignment.eventId)!.payload.memberAddress, eventId: request.stored.eventId },
    targetAssignment: { address: state.definition!.payload.coordinator, eventId: target.stored.eventId }, observedAt,
    deadline: p.deadline < target.payload.deadline ? p.deadline : target.payload.deadline }
  return checkWorkflowInteraction(state, value) ?? value
}
