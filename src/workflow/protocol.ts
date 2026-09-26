import { array, eventId, exact, record, timestamp } from '../agent/validation.js'
import { actionReference } from '../agent/input-codec.js'
import type { AgentActionReference } from '../agent/contract.js'
import type { JsonObject } from '../foundation/json.js'
import { decodeSendCommand } from '../communication/send-command.js'
import type { MessageSendCommand } from '../communication/send-command.js'
import { createDurableEventDefinition } from '../session/event-catalog.js'
import { formatSessionAddress } from '../session/ids.js'
import type { SessionEventId } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { workflowAssignmentCommittedEvent, workflowDefinitionRecordedEvent } from './definition-events.js'
import { workAssignmentAcceptedEvent, workflowReference, sameWorkflowValue } from './work-binding.js'
import {  artifactPublishedEvent, workProposalRecordedEvent , workReviewRecordedEvent } from './result-events.js'
import { workflowDecisionCommittedEvent } from './coordinator-events.js'
import type { WorkflowDefinition, WorkflowEventRef } from './types.js'
import { invalidHistory } from './errors.js'
import { workInteractionResolvedEvent, workQuestionDeclinedEvent } from './interaction-events.js'
import { declineCommands } from './question-decline.js'
import { questionCommands } from './receive.js'
import { workflowAssignmentStopEvent, workStopSettledEvent, workStopReceivedEvent, workflowStopMessage } from './stop-events.js'
import { inboxAcceptedEvent } from '../communication/session-events.js'
import { workStoppedMessageEvent, stoppedQuestionCommands } from './stopped-message.js'

export type WorkflowProtocolRecorded = {
  readonly assignment: WorkflowEventRef
  readonly source: SessionEventId | { readonly action: AgentActionReference; readonly observedAt: string }
  readonly commands: readonly MessageSendCommand[]
}
function decode(value: import('../foundation/json.js').JsonValue): WorkflowProtocolRecorded & JsonObject {
  const p = record(value); exact(p, ['assignment', 'source', 'commands'])
  let source: WorkflowProtocolRecorded['source']
  if (typeof p.source === 'string') source = eventId(p.source)
  else {
    const value = record(p.source); exact(value, ['action', 'observedAt'])
    source = { action: actionReference(value.action), observedAt: timestamp(value.observedAt) }
  }
  return { assignment: workflowReference(p.assignment), source, commands: array(p.commands, 128).map(decodeSendCommand) }
}
export const workflowProtocolRecordedEvent = createDurableEventDefinition({ type: 'workflow/protocol-recorded', payloadVersion: 1, ignorable: false, decode })
export const workProtocolRecordedEvent = createDurableEventDefinition({ type: 'work/protocol-recorded', payloadVersion: 1, ignorable: false, decode })

/** Derive complete fixed commands from locally committed sources, including all copied content. */
export function workflowSourceCommands(sources: ReadonlyMap<SessionEventId, CommittedSessionEvent>, id: SessionEventId): WorkflowProtocolRecorded & JsonObject {
  const source = sources.get(id)
  if (source === undefined) invalidHistory('protocol-source-missing')
  if (source.stored.type === workInteractionResolvedEvent.type) return questionCommands(sources, id)
  if (source.stored.type === workQuestionDeclinedEvent.type) return declineCommands(sources, id)
  if (source.stored.type === workStoppedMessageEvent.type) return stoppedQuestionCommands(sources, id)
  const ref = { address: formatSessionAddress(source.stored.sessionId), eventId: id }
  let assignment: WorkflowEventRef
  let recipient: import('../session/ids.js').SessionAddress
  let channelId: import('../communication/ids.js').ChannelId
  let type: string
  let payload: JsonObject
  if (source.stored.type === workflowAssignmentCommittedEvent.type) {
    const value = workflowAssignmentCommittedEvent.decode(source.payload)
    const event = sources.get(value.definition)
    if (event?.stored.type !== workflowDefinitionRecordedEvent.type) invalidHistory('protocol-definition-source')
    const recipe = workflowDefinitionRecordedEvent.decode(event.payload).definition as unknown as WorkflowDefinition
    assignment = ref; recipient = value.memberAddress; channelId = value.channelId; type = 'workflow/assignment'
    payload = { definition: { address: recipe.coordinator, eventId: event.stored.eventId }, assignment, recipe, value } as unknown as JsonObject
  } else if (source.stored.type === workAssignmentAcceptedEvent.type || [workProposalRecordedEvent.type, workReviewRecordedEvent.type].includes(source.stored.type)) {
    const accepted = source.stored.type === workAssignmentAcceptedEvent.type ? id : workProposalRecordedEvent.decode(source.payload).accepted
    const event = sources.get(accepted)
    if (event?.stored.type !== workAssignmentAcceptedEvent.type) invalidHistory('protocol-acceptance-source')
    const binding = workAssignmentAcceptedEvent.decode(event.payload)
    assignment = binding.assignment; recipient = assignment.address; channelId = binding.value.channelId
    if (source.stored.type === workAssignmentAcceptedEvent.type) {
      type = 'workflow/assignment-accepted'; payload = { assignment, accepted: ref }
    } else {
      type = binding.value.kind === 'review' ? 'workflow/review' : 'workflow/proposal'
      const value = workProposalRecordedEvent.decode(source.payload)
      payload = { assignment, proposal: ref, value, artifacts: value.artifacts.map(ref => {
        const event = sources.get(ref.eventId)
        if (event?.stored.type !== artifactPublishedEvent.type) invalidHistory('protocol-artifact-source')
        return { ref, value: artifactPublishedEvent.decode(event.payload) }
      }) }
    }
  } else if (source.stored.type === workflowAssignmentStopEvent.type) {
    const value = workflowAssignmentStopEvent.decode(source.payload)
    const original = workflowSourceCommands(sources, value.assignment.eventId).commands[0]!
    if (original.kind !== 'send') invalidHistory('stop-assignment-command')
    assignment = value.assignment; recipient = original.request.recipient; channelId = original.request.channelId
    type = 'workflow/stop'; payload = { assignment, stop: ref, binding: original.payload }
  } else if (source.stored.type === workStopSettledEvent.type) {
    const value = workStopSettledEvent.decode(source.payload)
    const stopped = workStopReceivedEvent.decode(sources.get(value.stop)!.payload)
    const inbox = inboxAcceptedEvent.decode(sources.get(stopped.inbox)!.payload).envelope
    const message = workflowStopMessage.decode(inbox.payload)
    assignment = value.assignment; recipient = assignment.address; channelId = message.binding.value.channelId
    type = 'workflow/stop-acknowledged'; payload = { assignment, stop: message.stop, receipt: ref, value }
  } else if (source.stored.type === workflowDecisionCommittedEvent.type) {
    const value = workflowDecisionCommittedEvent.decode(source.payload)
    const event = sources.get(value.assignment.eventId)
    if (event?.stored.type !== workflowAssignmentCommittedEvent.type) invalidHistory('protocol-assignment-source')
    const work = workflowAssignmentCommittedEvent.decode(event.payload)
    assignment = value.assignment; recipient = work.memberAddress; channelId = work.channelId
    type = 'workflow/decision'; payload = { assignment, decision: id, value }
  } else return invalidHistory('protocol-source-kind')
  return { assignment, source: id, commands: [{ kind: 'send', type, payloadVersion: 1,
    request: { kind: 'root', recipient, channelId }, payload }] }
}

export function validateWorkflowProtocol(sources: ReadonlyMap<SessionEventId, CommittedSessionEvent>, event: CommittedSessionEvent): void {
  const p = decode(event.payload)
  if (event.stored.payloadVersion !== 1 || event.stored.ignorable === true || !sameWorkflowValue(p, event.payload)
    || [...sources.values()].some(item => item.stored.type === event.stored.type && sameWorkflowValue(decode(item.payload).source, p.source))) invalidHistory('protocol-command-source')
  if (typeof p.source !== 'string') {
    if (event.stored.type !== workProtocolRecordedEvent.type) invalidHistory('protocol-action-owner')
    return
  }
  if (!sameWorkflowValue(p, workflowSourceCommands(sources, p.source))) invalidHistory('protocol-command-source')
  const source = sources.get(p.source)!
  const coordinator = [workflowAssignmentCommittedEvent.type, workflowDecisionCommittedEvent.type, workflowAssignmentStopEvent.type].includes(source.stored.type)
  if (event.stored.type !== (coordinator ? workflowProtocolRecordedEvent.type : workProtocolRecordedEvent.type)) invalidHistory('protocol-source-owner')
}
