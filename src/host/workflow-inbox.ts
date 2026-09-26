import {  workProposalRecordedEvent , workReviewRecordedEvent } from '../workflow/result-events.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { SessionMailbox } from '../communication/mailbox.js'
import { projectAgentSession } from '../agent/projection.js'
import { AgentJournal } from '../agent/journal.js'
import type { Clock } from '../foundation/clock.js'
import { WorkflowJournal } from '../workflow/journal.js'
import { projectWorkflowSession } from '../workflow/projection.js'
import { workAssignmentAcceptedEvent, decodeWorkAssignmentMessage, sameWorkflowValue } from '../workflow/work-binding.js'
import { workAssignmentSettledEvent } from '../workflow/settlement-events.js'
import { workflowProposalReceivedEvent, workflowReviewReceivedEvent } from '../workflow/coordinator-events.js'
import { workflowAssignmentAcceptedMessage, workflowProposalMessage, workflowDecisionMessage } from '../workflow/messages.js'
import { invalidHistory } from '../workflow/errors.js'

/** Adopt one supported Inbox item, then separately acknowledge its durable classification. */
export function nextWorkflowInbox(session: SessionHandle, mailbox: SessionMailbox, clock: Clock,
  role: 'coordinator' | 'member'): (() => Promise<unknown>) | undefined {
  const inbox = mailbox.snapshot().inbox.filter(item => item.status === 'pending' && item.envelope.type.startsWith('workflow/'))
  const events = session.snapshot().history.at(-1)!.events.filter(item => item.kind === 'known')
  for (const item of inbox) {
    if (role === 'coordinator') {
      const state = projectWorkflowSession(session.snapshot())
      const journal = new WorkflowJournal(session, clock)
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
      if (item.envelope.type === 'workflow/assignment') {
        if (state.inputs.some(input => input.work?.inbox === item.acceptedEventId)) return () => mailbox.markProcessed(item.messageId)
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
