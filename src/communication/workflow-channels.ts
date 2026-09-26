import { projectAgentSession } from '../agent/projection.js'
import { projectWorkflowSession } from '../workflow/projection.js'
import { sameWorkflowValue } from '../workflow/work-binding.js'
import { validateWorkflowProtocol, workflowProtocolRecordedEvent, workProtocolRecordedEvent } from '../workflow/protocol.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { SessionEventId } from '../session/ids.js'
import { CommunicationError } from './errors.js'
import { projectCommunicationFacts } from './projection.js'
import type { MessageSendCommand, MessageSendKey } from './send-command.js'
import type { MessageEnvelope } from './types.js'
import { workflowQuestionMessage, workflowAnswerMessage } from '../workflow/interaction-events.js'
import { workQuestionSendReady } from '../workflow/receive.js'
import { foldAgentSession } from '../agent/projection.js'

/** Binds local protocol writers to a committed assignment; no Peer receives these handles. */
export class WorkflowChannels {
  readonly #bindings = new Map<SessionEventId, { coordinator: SessionHandle; member: SessionHandle }>()

  bind(coordinator: SessionHandle, assignment: SessionEventId, member: SessionHandle): void {
    const work = projectWorkflowSession(coordinator.snapshot()).assignments.find(item => item.stored.eventId === assignment)
    if (work?.payload.memberAddress !== member.header.address) forbidden('workflow-channel-assignment')
    const prior = this.#bindings.get(assignment)
    if (prior !== undefined && (prior.coordinator !== coordinator || prior.member !== member)) forbidden('workflow-channel-conflict')
    this.#bindings.set(assignment, { coordinator, member })
  }

  /** Called inside the same gate as capacity checks and Outbox acceptance. */
  assertSend(handle: SessionHandle, key: MessageSendKey, command: MessageSendCommand): void {
    const events = handle.snapshot().history.at(-1)!.events.filter(item => item.kind === 'known')
    const event = events.find(item => item.stored.eventId === key.eventId)
    if (event === undefined || event.stored.payloadVersion !== 1
      || ![workflowProtocolRecordedEvent.type, workProtocolRecordedEvent.type].includes(event.stored.type)) forbidden('workflow-send-source')
    const protocol = workflowProtocolRecordedEvent.decode(event.payload)
    const binding = this.#bindings.get(protocol.assignment.eventId)
    if (binding === undefined || handle !== binding.coordinator && handle !== binding.member
      || protocol.assignment.address !== binding.coordinator.header.address
      || !sameWorkflowValue(protocol.commands[key.index], command)) forbidden('workflow-send-authority')
    if (handle === binding.coordinator) projectWorkflowSession(handle.snapshot())
    else projectAgentSession(handle.snapshot())
    validateWorkflowProtocol(new Map(events.filter(item => item.stored.sequence < event.stored.sequence)
      .map(item => [item.stored.eventId, item])), event)
    if (command.type === workflowQuestionMessage.type) {
      const question = workflowQuestionMessage.decode(command.payload)
      if (!workQuestionSendReady(foldAgentSession(handle.snapshot()), question.question.eventId)) forbidden('work-question-before-wait-checkpoint')
      const admitted = projectWorkflowSession(binding.coordinator.snapshot()).interactions.find(item => item.admitted.stored.eventId === question.interaction.eventId)
      if (admitted === undefined || admitted.settled !== null || !sameWorkflowValue(admitted.admitted.payload.assignment, question.assignment)
        || !sameWorkflowValue(admitted.admitted.payload.targetAssignment, question.targetAssignment)
        || !sameWorkflowValue(admitted.admitted.payload.request, question.question)) forbidden('work-question-without-admission')
    }
  }

  /** Only an exact authorized local Outbox copy may cross this reserved protocol channel. */
  authorizeReceive(envelope: MessageEnvelope): boolean {
    if (envelope.payload === null || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) return false
    const body = envelope.payload as { readonly assignment?: { readonly eventId?: SessionEventId }; readonly targetAssignment?: { readonly eventId?: SessionEventId } }
    const binding = body.assignment?.eventId === undefined ? undefined : this.#bindings.get(body.assignment.eventId)
    if (binding === undefined) return false
    const sender = envelope.sender === binding.coordinator.header.address ? binding.coordinator : binding.member
    const peer = body.targetAssignment?.eventId === undefined ? undefined : this.#bindings.get(body.targetAssignment.eventId)
    if (peer !== undefined && peer.coordinator !== binding.coordinator) return false
    const recipient = sender === binding.coordinator ? binding.member : peer?.member ?? binding.coordinator
    if (peer !== undefined && ![workflowQuestionMessage.type, workflowAnswerMessage.type].includes(envelope.type)) return false
    if (sender.header.address !== envelope.sender || recipient.header.address !== envelope.recipient) return false
    const outgoing = projectCommunicationFacts(sender.snapshot()).outbox.find(item => item.messageId === envelope.messageId)
    return outgoing !== undefined && outgoing.sendKey !== undefined && outgoing.command !== undefined && sameWorkflowValue(outgoing.envelope, envelope)
  }
}

function forbidden(reason: string): never { throw new CommunicationError('MESSAGE_SEND_FORBIDDEN', reason) }
