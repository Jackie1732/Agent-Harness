import type { HostSlot, HostProtocolSlot } from './runtime-types.js'
import type { Clock } from '../foundation/clock.js'
import { clockTimestamp } from '../foundation/clock.js'
import { projectWorkflowSession } from '../workflow/projection.js'
import type { WorkflowSnapshot } from '../workflow/projection.js'
import { projectAgentSession } from '../agent/projection.js'
import { AgentJournal } from '../agent/journal.js'
import { WorkflowJournal } from '../workflow/journal.js'
import { workflowAssignmentClosed } from '../workflow/closure.js'
import { finalWorkflowFailure } from '../workflow/coordinator-stop.js'
import { workflowStoppedEvent, workflowAssignmentStopEvent, workStopReceivedEvent, workStopSettledEvent, workflowTerminalEvent, workflowClosedEvent } from '../workflow/stop-events.js'
import { workExecutionReleasedEvent } from '../workflow/result-events.js'
import type { SessionEventId } from '../session/ids.js'
import { CommunicationError } from '../communication/errors.js'
import { workflowRetryExpiredEvent } from '../workflow/retry.js'

export type NotifyWorkStop = (memberKey: string, root: SessionEventId) => void

/** Notify only roots owned by this coordinator, before awaiting durable control confirmation. */
export function notifyWorkflowStop(coordinator: HostProtocolSlot, members: readonly HostSlot[], notifyChildren: NotifyWorkStop): void {
  const state = projectWorkflowSession(coordinator.session.snapshot())
  for (const work of state.assignments) {
    if (state.decisions.some(item => item.payload.assignment.eventId === work.stored.eventId && item.payload.outcome === 'accepted')) continue
    const member = members.find(slot => slot.session.header.address === work.payload.memberAddress)
    if (member === undefined) continue
    const root = projectAgentSession(member.session.snapshot()).roots.find(root => root.source.kind === 'workflow' && root.source.assignment.eventId === work.stored.eventId)
    if (root?.outcome == null && root !== undefined) { member.agent.notifyStop(root.id); notifyChildren(member.member.agentKey, root.id) }
  }
}

/** Record run stop, assignment stop, or final closure one transition at a time. */
export function nextWorkflowStop(coordinator: HostProtocolSlot, members: readonly HostSlot[], clock: Clock, notifyChildren: NotifyWorkStop,
  retired: ReadonlySet<string>, state: WorkflowSnapshot): (() => Promise<unknown>) | undefined {
  const definition = state.definition!
  const journal = new WorkflowJournal(coordinator.session, clock), observedAt = clockTimestamp(clock)
  if (state.terminal !== null) {
    if (state.closed !== null || state.controls.some(item => item.settled === null)
      || state.assignments.some(work => !retired.has(work.stored.eventId))) return undefined
    if (state.assignments.every(work => {
      const member = members.find(slot => slot.session.header.address === work.payload.memberAddress)
      return member !== undefined && workflowAssignmentClosed(coordinator.session, member.session, work.stored.eventId, members.map(slot => slot.session))
    })) return () => journal.append(workflowClosedEvent, () => ({ terminal: state.terminal!.stored.eventId, observedAt }))
    return undefined
  }
  const expired = state.stop === null ? state.retries.find(item => item.request === null && item.expired === null && item.consumed === null && observedAt >= item.deadline) : undefined
  if (expired !== undefined) return () => journal.append(workflowRetryExpiredEvent,
    () => ({ assignment: expired.assignment, failure: expired.failure, observedAt }))
  const pendingTask = coordinator.mailbox.snapshot().outbox.find(item => item.status === 'pending' && item.envelope.type === 'workflow/assignment'
    && state.assignmentStops.some(stop => stop.payload.assignment.eventId === (item.envelope.payload as { assignment: { eventId: string } }).assignment.eventId))
  if (pendingTask !== undefined) return async () => {
    try { await coordinator.mailbox.abandonOutgoing(pendingTask.messageId, 'caller-requested') }
    catch (cause) {
      if (!(cause instanceof CommunicationError && cause.code === 'MESSAGE_STATE_INVALID'
        && coordinator.mailbox.snapshot().outbox.find(item => item.messageId === pendingTask.messageId)?.status !== 'pending')) throw cause
    }
  }
  if (state.stop === null) {
    const cancel = state.controls.find(item => item.requested.payload.kind === 'cancel' && item.settled?.payload.outcome !== 'no-op')
    const complete = definition.payload.requiredOutputs.every(key => state.upstream.some(item => item.nodeKey === key && item.state.kind === 'accepted'))
      && definition.payload.nodes.every(node => state.upstream.some(item => item.nodeKey === node.nodeKey && ['accepted', 'skipped'].includes(item.state.kind)))
    if (complete && cancel === undefined) return () => journal.append(workflowTerminalEvent,
      () => ({ definition: definition.stored.eventId, outcome: 'completed' as const, observedAt }))
    const failure = finalWorkflowFailure(state, coordinator.session.snapshot().history.at(-1)!.events.filter(item => item.kind === 'known'))
    const reason = cancel !== undefined ? 'cancelled' : observedAt >= definition.payload.deadline ? 'deadline-exceeded' : failure !== undefined ? 'node-failed' : undefined
    if (reason !== undefined) return async () => {
      notifyWorkflowStop(coordinator, members, notifyChildren)
      return journal.append(workflowStoppedEvent, () => ({ definition: definition.stored.eventId, reason,
        source: cancel?.requested.stored.eventId ?? (reason === 'node-failed' ? failure!.stored.eventId : null), observedAt }))
    }
  }
  for (const work of state.assignments) {
    if (state.assignmentStops.some(item => item.payload.assignment.eventId === work.stored.eventId)) continue
    const decision = state.decisions.find(item => item.payload.assignment.eventId === work.stored.eventId)
    if (decision?.payload.outcome === 'accepted') continue
    const production = work.payload.kind === 'review' ? work.payload.reviewOf.assignment.eventId : undefined
    const rejected = state.decisions.find(item => item.payload.assignment.eventId === production && item.payload.outcome === 'rejected')
    const source = state.stop?.stored.eventId ?? rejected?.stored.eventId ?? (observedAt >= work.payload.deadline ? work.stored.eventId : undefined)
    if (source === undefined) continue
    const member = members.find(slot => slot.session.header.address === work.payload.memberAddress)
    if (member === undefined || workflowAssignmentClosed(coordinator.session, member.session, work.stored.eventId, members.map(slot => slot.session))) continue
    return () => journal.append(workflowAssignmentStopEvent,
      () => ({ assignment: { address: coordinator.session.header.address, eventId: work.stored.eventId }, source }))
  }
  if (state.stop !== null) return () => journal.append(workflowTerminalEvent, () => ({ definition: definition.stored.eventId,
    outcome: state.stop!.payload.reason === 'cancelled' ? 'cancelled' as const : 'failed' as const, observedAt }))
  return undefined
}

/** Receiver cancellation is durable before touching its root; the ack waits for actual execution release. */
export function nextWorkStop(member: HostSlot, clock: Clock, notifyChildren: NotifyWorkStop): (() => Promise<unknown>) | undefined {
  const events = member.session.snapshot().history.at(-1)!.events.filter(item => item.kind === 'known')
  const stops = events.filter(item => item.stored.type === workStopReceivedEvent.type)
  if (stops.length === 0) return undefined
  const state = projectAgentSession(member.session.snapshot())
  for (const stopped of stops) {
    if (events.some(item => item.stored.type === workStopSettledEvent.type && workStopSettledEvent.decode(item.payload).stop === stopped.stored.eventId)) continue
    const p = workStopReceivedEvent.decode(stopped.payload), root = p.root === null ? undefined : state.roots.find(root => root.id === p.root)!
    if (root !== undefined && root.outcome === null) {
      if (root.stopControl !== null) continue
      return () => { notifyChildren(member.member.agentKey, root.id); return member.agent.cancel(root.id, 'workflow-stopped') }
    }
    const released = events.find(item => item.stored.type === workExecutionReleasedEvent.type && workExecutionReleasedEvent.decode(item.payload).root === p.root)
    if (root !== undefined && released === undefined) continue
    const outcome = root === undefined ? 'unexecuted' : workExecutionReleasedEvent.decode(released!.payload).outcome === 'unknown' || root.outcome === 'result-unknown'
      ? 'result-unknown' : root.outcome === 'completed' ? 'completed' : root.outcome === 'cancelled' ? 'cancelled' : 'failed'
    return () => new AgentJournal(member.session, state.spec!.payload.limits.maxJournalConflicts, clock).append(workStopSettledEvent,
      () => ({ stop: stopped.stored.eventId, assignment: p.assignment, root: p.root, executionRelease: released?.stored.eventId ?? null, outcome }))
  }
  return undefined
}
