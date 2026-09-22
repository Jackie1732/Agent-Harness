import { effectiveResourceRelease } from './resource-evidence.js'
import { projectAgentSession, foldAgentSession } from '../agent/projection.js'
import type { AgentJournal } from '../agent/journal.js'
import { AgentError } from '../agent/errors.js'
import type { Clock } from '../foundation/clock.js'
import { clockTimestamp } from '../foundation/clock.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { SessionMailbox } from '../communication/mailbox.js'
import type { CommunicationService } from '../communication/service.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import { equal, record } from '../agent/validation.js'
import type { AcceptedDelegation } from './admission.js'
import { subagentMessageKind } from './messages.js'
import * as events from './session-events.js'
import { SubagentError } from './errors.js'
import { childResultPayload } from './result.js'

export type ProtocolAction = () => Promise<unknown>

/** Classify each Inbox once, then confirm transport without consuming its independent business input. */
export function classificationAction(accepted: AcceptedDelegation, session: SessionHandle, journal: AgentJournal, mailbox: SessionMailbox): ProtocolAction | undefined {
  const state = projectAgentSession(session.snapshot())
  const facts = projectCommunicationFacts(session.snapshot())
  const id = { delegation: accepted.event.stored.eventId, parentAddress: accepted.event.payload.parentAddress, childAddress: accepted.event.payload.childAddress }
  for (const incoming of facts.inbox.filter(item => item.status === 'pending' && subagentMessageKind(item.envelope.type) !== null)) {
    const kind = subagentMessageKind(incoming.envelope.type)!
    const classified = state.subagents.classifications.find(item => item.payload.inbox === incoming.acceptedEventId)
    if (classified !== undefined) return () => mailbox.markProcessed(incoming.messageId)
    if (incoming.envelope.payload === null || typeof incoming.envelope.payload !== 'object' || Array.isArray(incoming.envelope.payload)
      || record(incoming.envelope.payload).delegation !== id.delegation) continue
    if (state.spec !== null && kind !== 'progress' && state.inputs.filter(input => input.protocol !== undefined
      && ['queued', 'reserved', 'claimed', 'review-required'].includes(input.status)).length >= state.spec.payload.limits.maxPendingInputs) continue
    return async () => {
      const payload = { ...id, inbox: incoming.acceptedEventId, kind, classification: kind === 'progress' ? 'progress-only' as const : 'eligible' as const, reasonCode: 'protocol-source-validated' }
      try { await journal.append(events.subagentMessageClassifiedEvent, () => payload) }
      catch (cause) {
        if (journal.faulted || !(cause instanceof SubagentError || cause instanceof AgentError && cause.code === 'AGENT_STATE_INVALID')) throw cause
        await journal.append(events.subagentMessageClassifiedEvent, () => ({ ...payload, classification: 'rejected' as const, reasonCode: 'protocol-source-rejected' }))
      }
    }
  }
  const request = accepted.event.payload
  const root = state.roots.find(item => item.id === request.parentRoot)
  const childRoot = state.subagents.bound !== null ? state.roots[0] : undefined
  const stopped = session.header.address === request.parentAddress ? root?.outcome != null || root?.stopControl != null
    : childRoot?.outcome != null || childRoot?.stopControl != null || state.subagents.controls.length > 0
  if (stopped) {
    const input = state.inputs.find(item => item.protocol?.delegation === id.delegation && item.status === 'queued')
    if (input !== undefined) return () => journal.append(events.subagentInputDisposedEvent, () => ({ ...id, input: input.reference.eventId,
      disposition: 'not-adopted' as const, reasonCode: 'root-stopped-before-adoption' }))
  }
  return undefined
}

export function taskProtocolAction(accepted: AcceptedDelegation, clock: Clock): ProtocolAction | undefined {
  const state = projectAgentSession(accepted.parent.snapshot())
  const cp = accepted.event
  if (!state.subagents.provisions.some(item => item.payload.delegation === cp.stored.eventId && item.payload.outcome === 'installed')
    || state.subagents.protocol.some(item => item.payload.delegation === cp.stored.eventId && item.payload.kind === 'task')) return undefined
  const root = state.roots.find(item => item.id === cp.payload.parentRoot)
  if (root?.outcome !== null || root.stopControl !== null || clockTimestamp(clock) >= cp.payload.deadline) return undefined
  return () => accepted.journal.append(events.subagentProtocolRecordedEvent, () => ({ delegation: cp.stored.eventId,
    parentAddress: cp.payload.parentAddress, childAddress: cp.payload.childAddress, kind: 'task' as const, ordinal: 1,
    command: { kind: 'send' as const, request: { kind: 'root' as const, recipient: cp.payload.childAddress, channelId: cp.payload.channelId },
      type: 'subagent/task', payloadVersion: 1, payload: { delegation: cp.stored.eventId, parentRoot: cp.payload.parentRoot, childSessionId: cp.payload.childSessionId,
        task: cp.payload.request.task, materials: cp.payload.request.materials, grant: cp.payload.grant, workspace: cp.payload.effectivePlan.workspace, deadline: cp.payload.deadline } },
    source: { kind: 'delegation' as const, requested: cp.stored.eventId }, observedAt: clockTimestamp(clock) }))
}

export function resultProtocolAction(accepted: AcceptedDelegation, session: SessionHandle, journal: AgentJournal, clock: Clock): ProtocolAction | undefined {
  const state = projectAgentSession(session.snapshot())
  if (state.roots[0]?.outcome == null || state.openTurn !== null || state.subagents.protocol.some(item => item.payload.kind === 'result')
    || !state.subagents.resources.filter(item => item.opened.payload.component === 'execution').some(item => effectiveResourceRelease(item, state.subagents.recoveries) !== null)) return undefined
  const id = { delegation: accepted.event.stored.eventId, parentAddress: accepted.event.payload.parentAddress, childAddress: accepted.event.payload.childAddress }
  const task = state.inputs.find(item => item.protocol?.kind === 'task')?.message
  if (task == null) throw new SubagentError('SUBAGENT_STATE_INVALID', 'missing-result-task')
  return () => journal.append(events.subagentProtocolRecordedEvent, (_, snapshot) => {
    const payload = childResultPayload(foldAgentSession(snapshot), id)
    return { ...id, kind: 'result' as const, ordinal: 1, command: { kind: 'reply' as const, inboxMessageId: task.messageId, type: 'subagent/result', payloadVersion: 1, payload },
      source: { kind: 'terminal' as const, turn: payload.source.turn, release: payload.executionRelease.eventId }, observedAt: clockTimestamp(clock) }
  })
}

/** Retry the original raw intent using its original Outbox key, after the owning wait checkpoint. */
export function protocolSendAction(accepted: AcceptedDelegation, session: SessionHandle, mailbox: SessionMailbox, service: CommunicationService): ProtocolAction | undefined {
  const state = projectAgentSession(session.snapshot())
  const facts = projectCommunicationFacts(session.snapshot())
  for (const intent of state.subagents.protocol.filter(item => item.payload.delegation === accepted.event.stored.eventId)) {
    if (state.subagents.failures.some(item => item.payload.protocol === intent.stored.eventId)) continue
    const key = { eventId: intent.stored.eventId, index: 0 }
    if (facts.outbox.some(item => item.sendKey !== undefined && equal(item.sendKey, key))) continue
    const source = intent.payload.source
    if (source.kind === 'action' && intent.payload.kind !== 'progress') {
      const step = state.steps.find(item => item.decided?.stored.eventId === source.action.eventId)
      if (state.turns.find(item => item.started.stored.eventId === step?.opened.payload.turn)?.settled?.payload.outcome !== 'waiting') continue
    }
    return () => service.sendDelegationOnce(mailbox, accepted.lease, key, intent.payload.command)
  }
  return undefined
}
