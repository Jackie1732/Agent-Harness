import {  workProposalRecordedEvent , workReviewRecordedEvent } from '../workflow/result-events.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { SessionMailbox } from '../communication/mailbox.js'
import { projectAgentSession, foldAgentSession } from '../agent/projection.js'
import { workProtocolClassifiedEvent, workflowQuestionMessage, workflowAnswerMessage } from '../workflow/interaction-events.js'
import { classifyWorkMessage } from '../workflow/receive.js'
import { workflowGroupMessage } from '../workflow/group-events.js'
import { AgentJournal } from '../agent/journal.js'
import type { Clock } from '../foundation/clock.js'
import { WorkflowJournal } from '../workflow/journal.js'
import { projectWorkflowSession } from '../workflow/projection.js'
import { workAssignmentAcceptedEvent, decodeWorkAssignmentMessage, sameWorkflowValue } from '../workflow/work-binding.js'
import { workAssignmentSettledEvent } from '../workflow/settlement-events.js'
import { workflowProposalReceivedEvent, workflowReviewReceivedEvent } from '../workflow/coordinator-events.js'
import { workflowAssignmentAcceptedMessage, workflowProposalMessage, workflowDecisionMessage } from '../workflow/messages.js'
import { invalidHistory } from '../workflow/errors.js'
import { workflowStopMessage, workflowStopAcknowledgedMessage, workflowStopAcknowledgedEvent, workStopReceivedEvent, workAssignmentRejectedEvent } from '../workflow/stop-events.js'
import { workStoppedMessageEvent } from '../workflow/stopped-message.js'

/** Adopt one supported Inbox item, then separately acknowledge its durable classification. */
export function nextWorkflowInbox(session: SessionHandle, mailbox: SessionMailbox, clock: Clock,
  role: 'coordinator' | 'member'): (() => Promise<unknown>) | undefined {
  const inbox = mailbox.snapshot().inbox.filter(item => item.status === 'pending' && item.envelope.type.startsWith('workflow/'))
    .sort((a, b) => Number(b.envelope.type === workflowStopMessage.type) - Number(a.envelope.type === workflowStopMessage.type))
  const events = session.snapshot().history.at(-1)!.events.filter(item => item.kind === 'known')
  for (const item of inbox) {
    if (role === 'coordinator') {
      const state = projectWorkflowSession(session.snapshot())
      const journal = new WorkflowJournal(session, clock)
      if (item.envelope.type === workflowStopAcknowledgedMessage.type) {
        if (state.stopReceipts.some(receipt => receipt.payload.inbox === item.acceptedEventId)) return () => mailbox.markProcessed(item.messageId)
        return () => journal.append(workflowStopAcknowledgedEvent, () => ({ inbox: item.acceptedEventId, message: workflowStopAcknowledgedMessage.decode(item.envelope.payload) }))
      }
      if (item.envelope.type === 'workflow/progress') return () => mailbox.markProcessed(item.messageId)
      if (item.envelope.type === workflowAssignmentAcceptedMessage.type) {
        const message = workflowAssignmentAcceptedMessage.decode(item.envelope.payload)
        const work = state.assignments.find(entry => entry.stored.eventId === message.assignment.eventId)
        if (work === undefined || item.envelope.sender !== work.payload.memberAddress || message.accepted.address !== work.payload.memberAddress
          || message.assignment.address !== session.header.address || item.envelope.channelId !== work.payload.channelId) invalidHistory('assignment-ack-source')
        return () => mailbox.markProcessed(item.messageId)
      }
      if (item.envelope.type === workflowProposalMessage.type || item.envelope.type === 'workflow/review') {
        if ([...state.proposals, ...state.reviews].some(entry => entry.payload.inbox === item.acceptedEventId)) return () => mailbox.markProcessed(item.messageId)
        return () => journal.append(item.envelope.type === 'workflow/review' ? workflowReviewReceivedEvent : workflowProposalReceivedEvent, () => ({ definition: state.definition!.stored.eventId,
          inbox: item.acceptedEventId, message: workflowProposalMessage.decode(item.envelope.payload) }))
      }
    } else {
      const state = projectAgentSession(session.snapshot())
      const journal = new AgentJournal(session, state.spec!.payload.limits.maxJournalConflicts, clock)
      if (item.envelope.type === workflowStopMessage.type) {
        if (events.some(event => event.stored.type === workStopReceivedEvent.type && workStopReceivedEvent.decode(event.payload).inbox === item.acceptedEventId)) return () => mailbox.markProcessed(item.messageId)
        const message = workflowStopMessage.decode(item.envelope.payload)
        return () => journal.append(workStopReceivedEvent, current => ({ inbox: item.acceptedEventId, assignment: message.assignment,
          root: current.roots.find(root => root.source.kind === 'workflow' && sameWorkflowValue(root.source.assignment, message.assignment))?.id ?? null }))
      }
      if (['workflow/question', 'workflow/answer', 'workflow/group'].includes(item.envelope.type)) {
        if (events.some(event => event.stored.type === workStoppedMessageEvent.type
          && workStoppedMessageEvent.decode(event.payload).inbox === item.acceptedEventId)) return () => mailbox.markProcessed(item.messageId)
        if (events.some(event => event.stored.type === workProtocolClassifiedEvent.type
          && workProtocolClassifiedEvent.decode(event.payload).inbox === item.acceptedEventId)) return () => mailbox.markProcessed(item.messageId)
        const message = item.envelope.type === 'workflow/group' ? workflowGroupMessage.decode(item.envelope.payload)
          : item.envelope.type === 'workflow/question' ? workflowQuestionMessage.decode(item.envelope.payload) : workflowAnswerMessage.decode(item.envelope.payload)
        if (!state.inputs.some(input => input.work !== undefined && sameWorkflowValue(input.work.assignment, message.targetAssignment))) {
          const stop = events.find(event => event.stored.type === workStopReceivedEvent.type && sameWorkflowValue(workStopReceivedEvent.decode(event.payload).assignment, message.targetAssignment))
          if (stop === undefined) continue
          return () => journal.append(workStoppedMessageEvent, () => ({ inbox: item.acceptedEventId, stop: stop.stored.eventId }))
        }
        return () => journal.append(workProtocolClassifiedEvent, (_state, snapshot) => classifyWorkMessage(foldAgentSession(snapshot), item.acceptedEventId))
      }
      if (item.envelope.type === 'workflow/assignment') {
        if (events.some(event => event.stored.type === workAssignmentRejectedEvent.type && workAssignmentRejectedEvent.decode(event.payload).inbox === item.acceptedEventId)) return () => mailbox.markProcessed(item.messageId)
        if (state.inputs.some(input => input.work?.inbox === item.acceptedEventId)) return () => mailbox.markProcessed(item.messageId)
        const message = decodeWorkAssignmentMessage(item.envelope.payload)
        const stopped = events.find(event => event.stored.type === workStopReceivedEvent.type && sameWorkflowValue(workStopReceivedEvent.decode(event.payload).assignment, message.assignment))
        if (stopped !== undefined) return () => journal.append(workAssignmentRejectedEvent, () => ({ inbox: item.acceptedEventId, stop: stopped.stored.eventId }))
        if (state.openRun !== null || state.roots.some(root => root.outcome === null)) continue
        return () => journal.append(workAssignmentAcceptedEvent, () => workAssignmentAcceptedEvent.decode({ inbox: item.acceptedEventId,
          ...decodeWorkAssignmentMessage(item.envelope.payload) } as unknown as import('../foundation/json.js').JsonObject))
      }
      if (item.envelope.type === workflowDecisionMessage.type) {
        if (events.some(event => event.stored.type === workAssignmentSettledEvent.type
          && workAssignmentSettledEvent.decode(event.payload).inbox === item.acceptedEventId)) return () => mailbox.markProcessed(item.messageId)
        const message = workflowDecisionMessage.decode(item.envelope.payload)
        const accepted = state.inputs.find(input => input.work !== undefined && sameWorkflowValue(input.work.assignment, message.assignment))
        if (accepted === undefined) invalidHistory('decision-before-acceptance')
        const proposal = events.find(event => [workProposalRecordedEvent.type, workReviewRecordedEvent.type].includes(event.stored.type) && workProposalRecordedEvent.decode(event.payload).accepted === accepted.reference.eventId)
        if (proposal === undefined) invalidHistory('decision-before-proposal')
        const outcome = workProposalRecordedEvent.decode(proposal.payload).outcome
        return () => journal.append(workAssignmentSettledEvent, () => ({ assignment: message.assignment,
          accepted: accepted.reference.eventId, inbox: item.acceptedEventId, outcome: outcome === 'completed' ? message.value.outcome === 'accepted' ? 'completed' as const : 'rejected' as const : outcome }))
      }
    }
  }
  return undefined
}
