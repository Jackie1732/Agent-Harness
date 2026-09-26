import type { SessionHandle } from '../session/session-handle.js'
import type { SessionMailbox } from '../communication/mailbox.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import type { Clock } from '../foundation/clock.js'
import { AgentJournal } from '../agent/journal.js'
import { WorkflowJournal } from './journal.js'
import { workflowProtocolRecordedEvent, workProtocolRecordedEvent, workflowSourceCommands } from './protocol.js'
import { workflowAssignmentCommittedEvent } from './definition-events.js'
import { workflowDecisionCommittedEvent } from './coordinator-events.js'
import { workAssignmentAcceptedEvent } from './work-binding.js'
import {  workProposalRecordedEvent , workReviewRecordedEvent } from './result-events.js'

/** One local command or one keyed Outbox write; actual delivery belongs to the Host delivery lane. */
export function nextWorkflowSend(session: SessionHandle, mailbox: SessionMailbox, clock: Clock,
  role: 'coordinator' | 'member'): (() => Promise<unknown>) | undefined {
  const events = session.snapshot().history.at(-1)!.events.filter(item => item.kind === 'known')
  const sources = new Map(events.map(item => [item.stored.eventId, item]))
  const definition = role === 'coordinator' ? workflowProtocolRecordedEvent : workProtocolRecordedEvent
  const kinds = role === 'coordinator' ? [workflowAssignmentCommittedEvent.type, workflowDecisionCommittedEvent.type]
    : [workAssignmentAcceptedEvent.type, workProposalRecordedEvent.type, workReviewRecordedEvent.type]
  const protocol = events.filter(item => item.stored.type === definition.type)
    .map(item => ({ ...item, payload: definition.decode(item.payload) }))
  const missing = events.find(item => kinds.includes(item.stored.type) && !protocol.some(command => command.payload.source === item.stored.eventId))
  if (missing !== undefined) return () => {
    const value = workflowSourceCommands(sources, missing.stored.eventId)
    return role === 'coordinator' ? new WorkflowJournal(session, clock).append(definition, () => value)
      : new AgentJournal(session, workAssignmentAcceptedEvent.decode(events.find(item => item.stored.type === workAssignmentAcceptedEvent.type)!.payload).recipe.limits.maxCommitConflicts, clock).append(definition, () => value)
  }
  const facts = projectCommunicationFacts(session.snapshot())
  for (const item of protocol) for (const [index, command] of item.payload.commands.entries()) {
    if (facts.outbox.some(outbox => outbox.sendKey?.eventId === item.stored.eventId && outbox.sendKey.index === index)) continue
    return () => command.kind === 'send' ? mailbox.sendOnce({ eventId: item.stored.eventId, index }, command.request, command)
      : mailbox.replyOnce({ eventId: item.stored.eventId, index }, command.inboxMessageId, command)
  }
  return undefined
}
