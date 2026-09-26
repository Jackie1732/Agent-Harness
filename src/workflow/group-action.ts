import type { AgentProjectionState } from '../agent/projection-state.js'
import type { AgentActionReference } from '../agent/contract.js'
import type { AgentActionResult } from '../agent/event-contract.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { SessionEventId } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { formatSessionAddress } from '../session/ids.js'
import { array, choice, exact, integer, text } from '../agent/validation.js'
import { AgentJournal } from '../agent/journal.js'
import { foldAgentSession } from '../agent/projection.js'
import { clockTimestamp } from '../foundation/clock.js'
import type { Clock } from '../foundation/clock.js'
import { workActionSource } from './action-source.js'
import { workGroupRequestedEvent, workGroupResolvedEvent, workflowGroupMessage } from './group-events.js'
import { sameWorkflowValue, workAssignmentAcceptedEvent } from './work-binding.js'
import type { WorkAssignmentAccepted } from './work-binding.js'
import type { WorkflowEventRef } from './types.js'
import type { GroupAdmission } from './group-admission.js'
import { invalidHistory, WorkflowError } from './errors.js'

export interface WorkGroupAuthority {
  admitGroup(request: CommittedSessionEvent<ReturnType<typeof workGroupRequestedEvent.decode>>): Promise<
    { readonly outcome: 'blocked'; readonly reason: string } | { readonly outcome: 'admitted'; readonly admission: WorkflowEventRef; readonly value: GroupAdmission }>
}

/** Freeze the deduplicated roster order before asking for any group quota. */
export function groupIntent(state: AgentProjectionState, action: AgentActionReference, observedAt: string) {
  const { intent, root, binding, accepted, args } = workActionSource(state, action)
  if (intent.route !== 'work-group') invalidHistory('work-group-action')
  if (root.stopControl !== null) throw new WorkflowError('WORKFLOW_ADMISSION_BLOCKED', 'work-root-stopped')
  exact(args, ['targetNodeKeys', 'text', 'completion', 'timeoutMs'])
  const requested = [...new Set(array(args.targetNodeKeys, binding.recipe.limits.maxNodes).map(key => text(key, 128)))].filter(key => key !== binding.value.nodeKey)
  const nodes = requested.map(key => binding.recipe.nodes.find(node => node.nodeKey === key))
  if (nodes.some(node => node === undefined)) throw new WorkflowError('WORKFLOW_ADMISSION_BLOCKED', 'work-group-node-unknown')
  const targetNodeKeys = binding.recipe.roster.flatMap(member => nodes.filter(node => node!.executor === member.memberKey).map(node => node!.nodeKey))
  if (targetNodeKeys.length === 0 || targetNodeKeys.length > binding.recipe.limits.maxGroupRecipients) throw new WorkflowError('WORKFLOW_ADMISSION_BLOCKED', 'work-group-recipients')
  const timeout = integer(args.timeoutMs, 1, Math.min(state.spec!.payload.limits.maxWaitMs, binding.recipe.limits.maxWaitMs))
  return { assignment: binding.assignment, accepted, root: root.id, action, targetNodeKeys,
    text: text(args.text, binding.recipe.limits.maxTextBytes), completion: choice(args.completion, ['all-delivered', 'collect-outcomes']), observedAt,
    deadline: new Date(Math.min(Date.parse(observedAt) + timeout, Date.parse(root.deadline))).toISOString() }
}

export function groupWaitResult(state: AgentProjectionState, resolved: ReturnType<typeof workGroupResolvedEvent.decode>): AgentActionResult {
  if (resolved.outcome === 'blocked') return { kind: 'not-started', reason: resolved.reason }
  const request = workGroupRequestedEvent.decode(state.sources.get(resolved.request)!.payload)
  return { kind: 'wait', descriptor: { kind: 'work-group', request: resolved.request, interaction: resolved.admission,
    root: request.root, observedAt: request.observedAt, deadline: resolved.value.deadline,
    protectedTurns: [...state.turns.values()].filter(turn => turn.root === request.root).map(turn => turn.started.stored.eventId) } }
}

export async function executeWorkGroup(session: SessionHandle, clock: Clock, action: AgentActionReference, authority: WorkGroupAuthority): Promise<AgentActionResult> {
  const journal = new AgentJournal(session, foldAgentSession(session.snapshot()).spec!.payload.limits.maxJournalConflicts, clock)
  const request = await journal.append(workGroupRequestedEvent, (_state, snapshot) => groupIntent(foldAgentSession(snapshot), action, clockTimestamp(clock)))
  const admission = await authority.admitGroup(request)
  const resolved = await journal.append(workGroupResolvedEvent, () => ({ request: request.stored.eventId, ...admission }))
  return groupWaitResult(foldAgentSession(session.snapshot()), resolved.payload)
}

export function validateGroupActionEvent(state: AgentProjectionState, event: CommittedSessionEvent): void {
  if (event.stored.type === workGroupRequestedEvent.type) {
    const request = workGroupRequestedEvent.decode(event.payload)
    if (!sameWorkflowValue(request, groupIntent(state, request.action, request.observedAt))
      || [...state.sources.values()].some(item => item.stored.type === event.stored.type
        && sameWorkflowValue(workGroupRequestedEvent.decode(item.payload).action, request.action))) invalidHistory('work-group-intent-source')
    return
  }
  const resolved = workGroupResolvedEvent.decode(event.payload), source = state.sources.get(resolved.request)
  if (source?.stored.type !== workGroupRequestedEvent.type || [...state.sources.values()].some(item => item.stored.type === event.stored.type
    && workGroupResolvedEvent.decode(item.payload).request === resolved.request)) invalidHistory('work-group-resolution-source')
  const request = workGroupRequestedEvent.decode(source.payload)
  if (resolved.outcome === 'blocked') return
  const binding = workActionSource(state, request.action).binding, value = resolved.value
  if (resolved.admission.address !== binding.definition.address || value.definition !== binding.definition.eventId
    || !sameWorkflowValue(value.assignment, binding.assignment) || value.request.address !== formatSessionAddress(source.stored.sessionId)
    || value.request.eventId !== resolved.request || !sameWorkflowValue(value.targets.map(item => item.nodeKey), request.targetNodeKeys)
    || value.targets.some(item => item.assignment.address !== binding.definition.address)
    || value.deadline > request.deadline || value.deadline <= value.observedAt) invalidHistory('work-group-admission-source')
}

/** Original intent plus confirmed admission determines every indexed command, including full text. */
export function groupCommands(sources: ReadonlyMap<SessionEventId, CommittedSessionEvent>, id: SessionEventId) {
  const event = sources.get(id)!, request = workGroupRequestedEvent.decode(event.payload)
  const resolved = [...sources.values()].find(item => item.stored.type === workGroupResolvedEvent.type && workGroupResolvedEvent.decode(item.payload).request === id)
  const admission = resolved === undefined ? undefined : workGroupResolvedEvent.decode(resolved.payload)
  if (admission?.outcome !== 'admitted') invalidHistory('group-admission-required')
  const binding = workAssignmentAcceptedEvent.decode(sources.get(request.accepted)!.payload)
  return { assignment: binding.assignment, source: id, commands: groupMessageCommands(binding, { ...event, payload: request }, admission.value, admission.admission) }
}

/** Encode recipient-specific envelopes from one frozen group admission. */
export function groupMessageCommands(binding: WorkAssignmentAccepted, event: CommittedSessionEvent<ReturnType<typeof workGroupRequestedEvent.decode>>,
  admission: GroupAdmission, reference: WorkflowEventRef) {
  return admission.targets.map((target, index) => {
    const node = binding.recipe.nodes.find(node => node.nodeKey === target.nodeKey)!
    return { kind: 'send' as const, type: workflowGroupMessage.type, payloadVersion: 1,
      request: { kind: 'root' as const, recipient: binding.recipe.roster.find(member => member.memberKey === node.executor)!.address, channelId: binding.value.channelId },
      payload: { definition: binding.definition, assignment: binding.assignment, targetAssignment: target.assignment, interaction: reference,
        group: { address: formatSessionAddress(event.stored.sessionId), eventId: event.stored.eventId }, index, deadline: admission.deadline, text: event.payload.text } }
  })
}
