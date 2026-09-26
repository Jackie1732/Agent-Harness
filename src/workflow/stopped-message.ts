import type { AgentProjectionState } from '../agent/projection-state.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { SessionEventId } from '../session/ids.js'
import { createDurableEventDefinition } from '../session/event-catalog.js'
import { eventId, exact, record } from '../agent/validation.js'
import { inboxAcceptedEvent } from '../communication/session-events.js'
import { source } from '../agent/projection-state.js'
import { workStopReceivedEvent, workflowStopMessage } from './stop-events.js'
import { workflowQuestionMessage, workflowAnswerMessage } from './interaction-events.js'
import { workflowGroupMessage } from './group-events.js'
import { sameWorkflowValue } from './work-binding.js'
import { invalidHistory } from './errors.js'

export const workStoppedMessageEvent = createDurableEventDefinition({ type: 'work/stopped-message', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['inbox', 'stop'])
    return { inbox: eventId(p.inbox), stop: eventId(p.stop) }
  } })

/** A cancelled, unexecuted assignment classifies received collaboration without an Agent input. */
export function applyStoppedWorkMessage(state: AgentProjectionState, event: CommittedSessionEvent): void {
  const p = workStoppedMessageEvent.decode(event.payload), stopped = source(state, p.stop, workStopReceivedEvent).payload
  const binding = workflowStopMessage.decode(source(state, stopped.inbox, inboxAcceptedEvent).payload.envelope.payload).binding
  const incoming = source(state, p.inbox, inboxAcceptedEvent).payload.envelope
  const group = incoming.type === workflowGroupMessage.type
  if (!group && incoming.type !== workflowQuestionMessage.type) invalidHistory('stopped-message-kind')
  const value = group ? workflowGroupMessage.decode(incoming.payload) : workflowQuestionMessage.decode(incoming.payload)
  const peer = binding.recipe.roster.find(item => item.address === incoming.sender)
  if (event.stored.payloadVersion !== 1 || event.stored.ignorable || stopped.root !== null || binding.value.kind !== 'production'
    || incoming.payloadVersion !== 1 || incoming.recipient !== binding.value.memberAddress || peer === undefined
    || !sameWorkflowValue(value.targetAssignment, binding.assignment) || !sameWorkflowValue(value.definition, binding.definition)
    || value.assignment.address !== binding.definition.address || value.interaction.address !== binding.definition.address
    || value.deadline > binding.value.deadline || Buffer.byteLength(value.text) > binding.recipe.limits.maxTextBytes
    || [...state.sources.values()].some(item => item.stored.type === event.stored.type && workStoppedMessageEvent.decode(item.payload).inbox === p.inbox)) invalidHistory('stopped-message-source')
  if ('group' in value) {
    if (value.group.address !== incoming.sender || value.index >= binding.recipe.limits.maxGroupRecipients
      || !binding.recipe.communication.groups.some(item => item.from === peer.memberKey && item.recipients.includes(binding.value.memberKey))) invalidHistory('stopped-group-authority')
  } else if (value.question.address !== incoming.sender || !binding.recipe.communication.ask.some(item => item.from === peer.memberKey && item.to === binding.value.memberKey)) invalidHistory('stopped-question-authority')
}

/** The original incoming question owns exactly one maintenance reply reservation. */
export function stoppedQuestionCommands(sources: ReadonlyMap<SessionEventId, CommittedSessionEvent>, id: SessionEventId) {
  const value = workStoppedMessageEvent.decode(sources.get(id)!.payload)
  const stopped = workStopReceivedEvent.decode(sources.get(value.stop)!.payload)
  const binding = workflowStopMessage.decode(inboxAcceptedEvent.decode(sources.get(stopped.inbox)!.payload).envelope.payload).binding
  const incoming = inboxAcceptedEvent.decode(sources.get(value.inbox)!.payload).envelope
  if (incoming.type !== workflowQuestionMessage.type) invalidHistory('stopped-question-source')
  const question = workflowQuestionMessage.decode(incoming.payload)
  return { assignment: binding.assignment, source: id, commands: [{ kind: 'reply' as const, inboxMessageId: incoming.messageId,
    type: workflowAnswerMessage.type, payloadVersion: 1, payload: { definition: binding.definition, assignment: binding.assignment,
      targetAssignment: question.assignment, interaction: question.interaction, question: question.question,
      questionMessageId: incoming.messageId, outcome: 'unavailable', text: 'work-root-terminal' } }] }
}
