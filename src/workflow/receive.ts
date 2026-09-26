import type { AgentProjectionState } from '../agent/projection-state.js'
import { source } from '../agent/projection-state.js'
import { inboxAcceptedEvent } from '../communication/session-events.js'
import { keyedOutboxAcceptedEvent } from '../communication/keyed-event.js'
import type { SessionEventId } from '../session/ids.js'
import { formatSessionAddress } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { inputKey } from '../agent/input-codec.js'
import { workProtocolClassifiedEvent, workQuestionRequestedEvent, workInteractionResolvedEvent, workflowQuestionMessage, workflowAnswerMessage } from './interaction-events.js'
import { sameWorkflowValue, workAssignmentAcceptedEvent } from './work-binding.js'
import { invalidHistory } from './errors.js'
import { classifyGroupMessage, applyGroupInput } from './group-receive.js'
import { workGroupRequestedEvent } from './group-events.js'

/** Classification uses this Session's binding and Inbox; it does not claim a model input. */
export function classifyWorkMessage(state: AgentProjectionState, inbox: SessionEventId) {
  const event = source(state, inbox, inboxAcceptedEvent)
  const envelope = event.payload.envelope
  if (envelope.type === 'workflow/group') return classifyGroupMessage(state, inbox)
  const kind: 'question' | 'answer' = envelope.type === workflowQuestionMessage.type ? 'question' : 'answer'
  const value = kind === 'question' ? workflowQuestionMessage.decode(envelope.payload) : workflowAnswerMessage.decode(envelope.payload)
  const accepted = [...state.inputs.values()].find(input => input.work !== undefined && sameWorkflowValue(input.work.assignment, value.targetAssignment))
  if (accepted?.work === undefined) invalidHistory('work-message-before-binding')
  const binding = accepted.work
  let deadline: string
  if (envelope.payloadVersion !== 1 || binding.value.kind !== 'production' || !sameWorkflowValue(value.definition, binding.definition)
    || envelope.recipient !== binding.value.memberAddress || value.assignment.address !== binding.definition.address
    || value.interaction.address !== binding.definition.address || Buffer.byteLength(value.text) > binding.recipe.limits.maxTextBytes) invalidHistory('work-message-authority')
  if (kind === 'question') {
    const question = workflowQuestionMessage.decode(envelope.payload)
    deadline = question.deadline
    const peer = binding.recipe.roster.find(member => member.address === envelope.sender)
    if (question.question.address !== envelope.sender || peer === undefined
      || !binding.recipe.communication.ask.some(pair => pair.from === peer.memberKey && pair.to === binding.value.memberKey)
      || question.deadline > binding.value.deadline) invalidHistory('work-question-authority')
  } else {
    const answer = workflowAnswerMessage.decode(envelope.payload)
    const request = state.sources.get(answer.question.eventId)
    const resolved = [...state.sources.values()].find(item => item.stored.type === workInteractionResolvedEvent.type
      && workInteractionResolvedEvent.decode(item.payload).request === answer.question.eventId)
    const admission = resolved === undefined ? undefined : workInteractionResolvedEvent.decode(resolved.payload)
    const outgoing = [...state.sources.values()].find(item => item.stored.type === keyedOutboxAcceptedEvent.type
      && keyedOutboxAcceptedEvent.decode(item.payload).envelope.messageId === answer.questionMessageId)
    if (request?.stored.type !== workQuestionRequestedEvent.type || admission?.outcome !== 'admitted' || outgoing === undefined
      || answer.question.address !== binding.value.memberAddress || !sameWorkflowValue(admission.admission, answer.interaction)
      || !sameWorkflowValue(admission.value.targetAssignment, answer.assignment)) invalidHistory('work-answer-request-source')
    const question = keyedOutboxAcceptedEvent.decode(outgoing.payload).envelope
    deadline = admission.value.deadline
    if (question.type !== workflowQuestionMessage.type || envelope.sender !== question.recipient || envelope.recipient !== question.sender
      || envelope.replyTo !== question.messageId || envelope.causationId !== question.messageId || envelope.correlationId !== question.correlationId
      || envelope.channelId !== question.channelId) invalidHistory('work-answer-correlation')
  }
  const prior = [...state.inputs.values()].some(input => input.workMessage?.kind === kind && sameWorkflowValue(input.workMessage.question, value.question))
  const root = [...state.roots.values()].find(root => root.source.kind === 'workflow' && sameWorkflowValue(root.source.assignment, binding.assignment))
  const late = root !== undefined && (root.outcome !== null || root.stopControl !== null)
    || event.stored.recordedAt >= deadline
    || kind === 'answer' && [...state.waits.values()].some(wait => wait.created.payload.result.kind === 'wait'
      && wait.created.payload.result.descriptor.kind === 'work-answer' && wait.created.payload.result.descriptor.request === value.question.eventId
      && wait.settled !== null)
  return { accepted: accepted.reference.eventId, inbox, kind, classification: prior ? 'duplicate' as const : late ? 'late' as const : 'eligible' as const }
}

export function applyWorkProtocolClassified(state: AgentProjectionState, event: CommittedSessionEvent): void {
  const p = workProtocolClassifiedEvent.decode(event.payload)
  const expected = classifyWorkMessage(state, p.inbox)
  if (!sameWorkflowValue(p, expected) || [...state.sources.values()].some(item => item.stored.type === event.stored.type
    && workProtocolClassifiedEvent.decode(item.payload).inbox === p.inbox)) invalidHistory('work-classification-source')
  if (p.classification !== 'eligible') return
  if (p.kind === 'group') { applyGroupInput(state, event); return }
  const incoming = source(state, p.inbox, inboxAcceptedEvent)
  const message = incoming.payload.envelope
  const value = p.kind === 'question' ? workflowQuestionMessage.decode(message.payload) : workflowAnswerMessage.decode(message.payload)
  const reference = { kind: 'workflow' as const, eventId: event.stored.eventId }
  state.inputs.set(inputKey(reference), { reference, input: null, message, workMessage: { assignment: value.targetAssignment, kind: p.kind, inbox: p.inbox, question: value.question },
    acceptedAt: incoming.stored.recordedAt, sequence: event.stored.sequence, lane: `workflow:${value.targetAssignment.address}`,
    status: 'queued', claimedBy: null, reservedBy: null, everMatched: false, reason: null })
}

/** Collaboration sends require the original action's durable wait checkpoint. */
export function workInteractionSendReady(state: AgentProjectionState, request: SessionEventId, observedAt?: string): boolean {
  const event = state.sources.get(request)!
  const question = event.stored.type === workGroupRequestedEvent.type ? workGroupRequestedEvent.decode(event.payload) : workQuestionRequestedEvent.decode(event.payload)
  const wait = [...state.waits.values()].find(item => sameWorkflowValue(item.reference, question.action))
  const root = state.roots.get(question.root)!
  return root.outcome === null && root.stopControl === null && wait?.settled === null
    && (observedAt === undefined || wait.created.payload.result.kind === 'wait' && observedAt < wait.created.payload.result.descriptor.deadline)
    && state.turns.get(wait.turn)?.settled?.payload.outcome === 'waiting'
}

/** Derive a question send from local CP-Q confirmation and the original model text. */
export function questionCommands(sources: ReadonlyMap<SessionEventId, CommittedSessionEvent>, resolved: SessionEventId) {
  const event = sources.get(resolved)!
  const admission = workInteractionResolvedEvent.decode(event.payload)
  if (admission.outcome !== 'admitted') invalidHistory('question-admission-required')
  const requested = sources.get(admission.request)!
  const request = workQuestionRequestedEvent.decode(requested.payload)
  const accepted = sources.get(request.accepted)!
  const binding = workAssignmentAcceptedEvent.decode(accepted.payload)
  const target = binding.recipe.nodes.find(node => node.nodeKey === request.targetNodeKey)!
  const member = binding.recipe.roster.find(member => member.memberKey === target.executor)!
  return { assignment: binding.assignment, source: resolved, commands: [{ kind: 'send' as const, type: workflowQuestionMessage.type, payloadVersion: 1,
    request: { kind: 'root' as const, recipient: member.address, channelId: binding.value.channelId }, payload: { definition: binding.definition,
      assignment: binding.assignment, targetAssignment: admission.value.targetAssignment, interaction: admission.admission,
      question: { address: formatSessionAddress(requested.stored.sessionId), eventId: admission.request }, deadline: admission.value.deadline, text: request.text } }] }
}
