import type { SessionHandle } from '../session/session-handle.js'
import type { Clock } from '../foundation/clock.js'
import { clockTimestamp } from '../foundation/clock.js'
import { formatSessionEventId, sessionSequence } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { HostSlot } from './runtime-types.js'
import { foldAgentSession, projectAgentSession } from '../agent/projection.js'
import { WorkflowJournal } from '../workflow/journal.js'
import { projectWorkflowSession } from '../workflow/projection.js'
import { selectQuestionAdmission } from '../workflow/interactions.js'
import type { WorkInteractionAuthority } from '../workflow/question-action.js'
import { workQuestionRequestedEvent, workflowInteractionAdmittedEvent, workflowInteractionSettledEvent, workflowQuestionMessage } from '../workflow/interaction-events.js'
import { sameWorkflowValue } from '../workflow/work-binding.js'
import { assertWorkflowMessageFits } from '../workflow/message-budget.js'
import { invalidHistory } from '../workflow/errors.js'
import { CommunicationError } from '../communication/errors.js'
import { workInteractionSettlement } from '../workflow/interaction-settlement.js'

/** Called under HostWorkflows' admission gate; coordinator records receive identities and quotas, not peer text. */
export async function admitWorkQuestion(coordinator: SessionHandle, slots: readonly HostSlot[], clock: Clock,
  request: CommittedSessionEvent<ReturnType<typeof workQuestionRequestedEvent.decode>>): ReturnType<WorkInteractionAuthority['admit']> {
  const state = projectWorkflowSession(coordinator.snapshot())
  const chosen = selectQuestionAdmission(state, request, clockTimestamp(clock))
  if ('outcome' in chosen) return chosen
  const sender = slots.find(slot => slot.session.header.address === chosen.request.address)!
  const source = foldAgentSession(sender.session.snapshot())
  const saved = source.sources.get(request.stored.eventId)
  const root = source.roots.get(request.payload.root)
  if (saved === undefined || !sameWorkflowValue(saved.payload, request.payload)) invalidHistory('question-request-source')
  if (root?.outcome !== null || root.stopControl !== null) return { outcome: 'blocked', reason: 'work-question-root-stopped', cycle: [] }
  const work = state.assignments.find(item => item.stored.eventId === chosen.targetAssignment.eventId)!
  const target = slots.find(slot => slot.session.header.address === work.payload.memberAddress)!
  const targetRoot = projectAgentSession(target.session.snapshot()).roots.find(root => root.source.kind === 'workflow' && sameWorkflowValue(root.source.assignment, chosen.targetAssignment))
  if (targetRoot !== undefined && (targetRoot.outcome !== null || targetRoot.stopControl !== null)) return { outcome: 'blocked', reason: 'work-peer-terminal', cycle: [] }
  const own = state.assignments.find(item => item.stored.eventId === chosen.assignment.eventId)!
  assertWorkflowMessageFits(sender.session.header.sessionId, { kind: 'send', type: workflowQuestionMessage.type, payloadVersion: 1,
    request: { kind: 'root', recipient: target.session.header.address, channelId: own.payload.channelId },
    payload: { definition: { address: coordinator.header.address, eventId: state.definition!.stored.eventId }, assignment: chosen.assignment,
      targetAssignment: chosen.targetAssignment, question: chosen.request, deadline: chosen.deadline, text: request.payload.text,
      interaction: { address: coordinator.header.address, eventId: formatSessionEventId(coordinator.header.sessionId, sessionSequence(Number.MAX_SAFE_INTEGER)) } } },
  { maxMessageBytes: own.payload.protocolLimits.maxMessageBytes, maxRecordBytes: Math.min(sender.session.maxRecordBytes, target.session.maxRecordBytes) })
  const committed = await new WorkflowJournal(coordinator, clock).append(workflowInteractionAdmittedEvent, () => chosen)
  if (committed.payload.kind !== 'question') invalidHistory('question-admission-kind')
  return { outcome: 'admitted', admission: { address: coordinator.header.address, eventId: committed.stored.eventId }, value: committed.payload }
}

/** Edges remain occupied until the originating wait or root has a durable settlement. */
export function nextWorkInteractionSettlement(coordinator: SessionHandle, slots: readonly HostSlot[], clock: Clock): (() => Promise<unknown>) | undefined {
  const state = projectWorkflowSession(coordinator.snapshot())
  for (const interaction of state.interactions) {
    if (interaction.settled !== null) continue
    const request = interaction.admitted.payload.request
    const sender = slots.find(slot => slot.session.header.address === request.address)!
    if (sender.mailbox.status !== 'open') continue
    const source = foldAgentSession(sender.session.snapshot())
    const settlement = workInteractionSettlement(source, interaction)
    if (settlement === undefined) continue
    const pending = sender.mailbox.snapshot().outbox.find(item => item.status === 'pending' && item.envelope.type === workflowQuestionMessage.type
      && workflowQuestionMessage.decode(item.envelope.payload).question.eventId === request.eventId)
    if (pending !== undefined) return async () => {
      try { await sender.mailbox.abandonOutgoing(pending.messageId, 'caller-requested') }
      catch (cause) {
        const current = sender.mailbox.snapshot().outbox.find(item => item.messageId === pending.messageId)
        if (!(cause instanceof CommunicationError && cause.code === 'MESSAGE_STATE_INVALID' && current?.status !== 'pending')) throw cause
      }
    }
    return () => new WorkflowJournal(coordinator, clock).append(workflowInteractionSettledEvent, () => settlement)
  }
  return undefined
}
