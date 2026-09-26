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
  }

  /** Only an exact authorized local Outbox copy may cross this reserved protocol channel. */
  authorizeReceive(envelope: MessageEnvelope): boolean {
    if (envelope.payload === null || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)) return false
    const body = envelope.payload as { readonly assignment?: { readonly eventId?: SessionEventId } }
    const binding = body.assignment?.eventId === undefined ? undefined : this.#bindings.get(body.assignment.eventId)
    if (binding === undefined) return false
    const sender = envelope.sender === binding.coordinator.header.address ? binding.coordinator : binding.member
    const recipient = sender === binding.coordinator ? binding.member : binding.coordinator
    if (sender.header.address !== envelope.sender || recipient.header.address !== envelope.recipient) return false
    const outgoing = projectCommunicationFacts(sender.snapshot()).outbox.find(item => item.messageId === envelope.messageId)
    return outgoing !== undefined && outgoing.sendKey !== undefined && outgoing.command !== undefined && sameWorkflowValue(outgoing.envelope, envelope)
  }
}

function forbidden(reason: string): never { throw new CommunicationError('MESSAGE_SEND_FORBIDDEN', reason) }
