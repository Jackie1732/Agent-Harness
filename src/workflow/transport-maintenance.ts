import type { SessionHandle } from '../session/session-handle.js'
import type { SessionMailbox } from '../communication/mailbox.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import type { Clock } from '../foundation/clock.js'
import { clockTimestamp } from '../foundation/clock.js'
import { AgentJournal } from '../agent/journal.js'
import { WorkflowJournal } from './journal.js'
import { workflowProtocolRecordedEvent, workProtocolRecordedEvent, workflowSourceCommands } from './protocol.js'
import { workflowAssignmentCommittedEvent } from './definition-events.js'
import { workflowDecisionCommittedEvent } from './coordinator-events.js'
import { workAssignmentAcceptedEvent } from './work-binding.js'
import {  workProposalRecordedEvent , workReviewRecordedEvent } from './result-events.js'
import { workInteractionResolvedEvent, workQuestionDeclinedEvent } from './interaction-events.js'
import { foldAgentSession } from '../agent/projection.js'
import { workInteractionSendReady } from './receive.js'
import { workflowAssignmentStopEvent, workStopSettledEvent } from './stop-events.js'
import { workStoppedMessageEvent } from './stopped-message.js'
import { inboxAcceptedEvent } from '../communication/session-events.js'

/** One local command or one keyed Outbox write; actual delivery belongs to the Host delivery lane. */
export function nextWorkflowSend(session: SessionHandle, mailbox: SessionMailbox, clock: Clock,
  role: 'coordinator' | 'member'): (() => Promise<unknown>) | undefined {
  const events = session.snapshot().history.at(-1)!.events.filter(item => item.kind === 'known')
  const sources = new Map(events.map(item => [item.stored.eventId, item]))
  const definition = role === 'coordinator' ? workflowProtocolRecordedEvent : workProtocolRecordedEvent
  const kinds = role === 'coordinator' ? [workflowAssignmentStopEvent.type, workflowAssignmentCommittedEvent.type, workflowDecisionCommittedEvent.type]
    : [workStopSettledEvent.type, workStoppedMessageEvent.type, workAssignmentAcceptedEvent.type, workProposalRecordedEvent.type, workReviewRecordedEvent.type, workInteractionResolvedEvent.type, workQuestionDeclinedEvent.type]
  const protocol = events.filter(item => item.stored.type === definition.type)
    .map(item => ({ ...item, payload: definition.decode(item.payload) }))
  const canSend = (id: import('../session/ids.js').SessionEventId): boolean => {
    const event = sources.get(id)!
    if (event.stored.type === workStoppedMessageEvent.type) return inboxAcceptedEvent.decode(sources.get(workStoppedMessageEvent.decode(event.payload).inbox)!.payload).envelope.type === 'workflow/question'
    if (event.stored.type === workflowAssignmentCommittedEvent.type && events.some(item => item.stored.type === workflowAssignmentStopEvent.type
      && workflowAssignmentStopEvent.decode(item.payload).assignment.eventId === id)) return false
    if (event.stored.type !== workInteractionResolvedEvent.type) return true
    const resolution = workInteractionResolvedEvent.decode(event.payload)
    return resolution.outcome === 'admitted' && workInteractionSendReady(foldAgentSession(session.snapshot()), resolution.request, clockTimestamp(clock))
  }
  const missing = events.find(item => kinds.includes(item.stored.type) && canSend(item.stored.eventId)
    && !protocol.some(command => command.payload.source === item.stored.eventId))
  if (missing !== undefined) return () => {
    const value = workflowSourceCommands(sources, missing.stored.eventId)
    return role === 'coordinator' ? new WorkflowJournal(session, clock).append(definition, () => value)
      : new AgentJournal(session, foldAgentSession(session.snapshot()).spec!.payload.limits.maxJournalConflicts, clock).append(definition, () => value)
  }
  const facts = projectCommunicationFacts(session.snapshot())
  for (const item of protocol) for (const [index, command] of item.payload.commands.entries()) {
    if (typeof item.payload.source === 'string' && !canSend(item.payload.source)) continue
    if (facts.outbox.some(outbox => outbox.sendKey?.eventId === item.stored.eventId && outbox.sendKey.index === index)) continue
    return () => command.kind === 'send' ? mailbox.sendOnce({ eventId: item.stored.eventId, index }, command.request, command)
      : mailbox.replyOnce({ eventId: item.stored.eventId, index }, command.inboxMessageId, command)
  }
  return undefined
}
