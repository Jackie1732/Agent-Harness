import type { AgentProjectionState } from '../agent/projection-state.js'
import { source } from '../agent/projection-state.js'
import type { SessionEventId } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { inboxAcceptedEvent } from '../communication/session-events.js'
import { inputKey } from '../agent/input-codec.js'
import { workflowGroupMessage } from './group-events.js'
import { workProtocolClassifiedEvent } from './interaction-events.js'
import { sameWorkflowValue } from './work-binding.js'
import { invalidHistory } from './errors.js'
import { workStopReceivedEvent } from './stop-events.js'

export function classifyGroupMessage(state: AgentProjectionState, inbox: SessionEventId) {
  const incoming = source(state, inbox, inboxAcceptedEvent), envelope = incoming.payload.envelope
  const value = workflowGroupMessage.decode(envelope.payload)
  const accepted = [...state.inputs.values()].find(input => input.work !== undefined && sameWorkflowValue(input.work.assignment, value.targetAssignment))
  if (accepted?.work === undefined) invalidHistory('work-group-before-binding')
  const binding = accepted.work, sender = binding.recipe.roster.find(member => member.address === envelope.sender)
  if (binding.value.kind !== 'production' || envelope.payloadVersion !== 1 || !sameWorkflowValue(value.definition, binding.definition)
    || envelope.recipient !== binding.value.memberAddress || value.group.address !== envelope.sender || sender === undefined
    || value.assignment.address !== binding.definition.address || value.interaction.address !== binding.definition.address
    || value.deadline > binding.value.deadline || value.index >= binding.recipe.limits.maxGroupRecipients
    || Buffer.byteLength(value.text) > binding.recipe.limits.maxTextBytes
    || !binding.recipe.communication.groups.some(group => group.from === sender.memberKey && group.recipients.includes(binding.value.memberKey))) invalidHistory('work-group-authority')
  const root = [...state.roots.values()].find(root => root.source.kind === 'workflow' && sameWorkflowValue(root.source.assignment, binding.assignment))
  const duplicate = [...state.inputs.values()].some(input => input.workMessage?.kind === 'group' && sameWorkflowValue(input.workMessage.group, value.group))
  const late = incoming.stored.recordedAt >= value.deadline || root !== undefined && (root.outcome !== null || root.stopControl !== null)
    || [...state.sources.values()].some(event => event.stored.type === workStopReceivedEvent.type
      && sameWorkflowValue(workStopReceivedEvent.decode(event.payload).assignment, binding.assignment))
  return { accepted: accepted.reference.eventId, inbox, kind: 'group' as const, classification: duplicate ? 'duplicate' as const : late ? 'late' as const : 'eligible' as const }
}

export function applyGroupInput(state: AgentProjectionState, event: CommittedSessionEvent): void {
  const p = workProtocolClassifiedEvent.decode(event.payload), incoming = source(state, p.inbox, inboxAcceptedEvent)
  const value = workflowGroupMessage.decode(incoming.payload.envelope.payload), reference = { kind: 'workflow' as const, eventId: event.stored.eventId }
  state.inputs.set(inputKey(reference), { reference, input: null, message: incoming.payload.envelope,
    workMessage: { assignment: value.targetAssignment, kind: 'group', inbox: p.inbox, group: value.group },
    acceptedAt: incoming.stored.recordedAt, sequence: event.stored.sequence, lane: `workflow:${value.targetAssignment.address}`,
    status: 'queued', claimedBy: null, reservedBy: null, everMatched: false, reason: null })
}
