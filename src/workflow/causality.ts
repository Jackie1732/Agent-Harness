import type { SessionSnapshot, CommittedSessionEvent } from '../session/types.js'
import type { SessionEventId } from '../session/ids.js'
import { sessionLogPosition } from '../session/ids.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import { projectWorkflowSession } from './projection.js'
import { sameWorkflowValue, workAssignmentAcceptedEvent } from './work-binding.js'
import { workflowAssignmentCommittedEvent, workflowDefinitionRecordedEvent } from './definition-events.js'
import { workGroupResolvedEvent, workGroupRequestedEvent } from './group-events.js'
import { workInteractionResolvedEvent, workflowInteractionAdmittedEvent, workQuestionRequestedEvent } from './interaction-events.js'
import { workProtocolRecordedEvent, workflowProtocolRecordedEvent } from './protocol.js'
import { groupCommands } from './group-action.js'
import { workProposalRecordedEvent, workReviewRecordedEvent, artifactPublishedEvent } from './result-events.js'
import type { WorkflowEventRef } from './types.js'
import { invalidHistory } from './errors.js'
import { foldAgentSession } from '../agent/projection.js'
import { workInteractionSettlement } from './interaction-settlement.js'

/** Managed logs may lead acknowledgements, but cannot contain a receiver or copied source ahead of its producer. */
export function validateWorkflowCausality(snapshots: readonly SessionSnapshot[]): void {
  const sessions = new Map(snapshots.map(snapshot => [snapshot.header.address, snapshot]))
  const messages = new Map(snapshots.map(snapshot => {
    const facts = projectCommunicationFacts(snapshot)
    return [snapshot.header.address, { facts, inbox: new Map(facts.inbox.map(item => [item.envelope.messageId, item])),
      outbox: new Map(facts.outbox.map(item => [item.envelope.messageId, item])) }] as const
  }))
  const sources = new Map<SessionEventId, CommittedSessionEvent>()
  for (const snapshot of snapshots) for (const event of snapshot.history.at(-1)!.events) {
    if (event.kind === 'known') sources.set(event.stored.eventId, event)
  }
  const reference = (ref: WorkflowEventRef, types?: readonly string[]) => {
    const event = sources.get(ref.eventId)
    if (event === undefined || sessions.get(ref.address)?.header.sessionId !== event.stored.sessionId
      || types !== undefined && !types.includes(event.stored.type)) invalidHistory('workflow-causal-source-missing')
    return event
  }
  for (const snapshot of snapshots) {
    const events = snapshot.history.at(-1)!.events.filter(item => item.kind === 'known')
    const local = new Map(events.map(item => [item.stored.eventId, item]))
    for (const event of events) {
      if (event.stored.type === workAssignmentAcceptedEvent.type) {
        const p = workAssignmentAcceptedEvent.decode(event.payload)
        if (!sameWorkflowValue(reference(p.assignment, [workflowAssignmentCommittedEvent.type]).payload, p.value)
          || !sameWorkflowValue(workflowDefinitionRecordedEvent.decode(reference(p.definition, [workflowDefinitionRecordedEvent.type]).payload).definition, p.recipe)) invalidHistory('workflow-causal-assignment-copy')
      } else if ([workInteractionResolvedEvent.type, workGroupResolvedEvent.type].includes(event.stored.type)) {
        const p = (event.stored.type === workInteractionResolvedEvent.type ? workInteractionResolvedEvent : workGroupResolvedEvent).decode(event.payload)
        if (p.outcome === 'admitted' && !sameWorkflowValue(reference(p.admission, [workflowInteractionAdmittedEvent.type]).payload, p.value)) invalidHistory('workflow-causal-admission-copy')
      }
    }
    if (events.some(event => event.stored.type === workflowDefinitionRecordedEvent.type)) {
      const state = projectWorkflowSession(snapshot)
      for (const interaction of state.interactions) {
        const admitted = interaction.admitted.payload
        const request = reference(admitted.request, [admitted.kind === 'question' ? workQuestionRequestedEvent.type : workGroupRequestedEvent.type])
        const p = (admitted.kind === 'question' ? workQuestionRequestedEvent : workGroupRequestedEvent).decode(request.payload)
        const targets = admitted.kind === 'question' ? [admitted.targetAssignment] : admitted.targets.map(item => item.assignment)
        const targetWork = targets.map(target => state.assignments.find(item => item.stored.eventId === target.eventId)!)
        const deadline = [p.deadline, ...targetWork.map(item => item.payload.deadline)].sort()[0]
        const nodes = 'targetNodeKey' in p ? [p.targetNodeKey] : p.targetNodeKeys
        if (!sameWorkflowValue(p.assignment, admitted.assignment) || admitted.deadline !== deadline
          || !sameWorkflowValue(nodes, targetWork.map(item => item.payload.nodeKey))) invalidHistory('workflow-causal-interaction-source')
        if (interaction.settled !== null) {
          const settled = interaction.settled.payload, source = reference(settled.source)
          if (settled.source.address !== admitted.request.address) invalidHistory('workflow-causal-interaction-settlement')
          const peer = sessions.get(settled.source.address)!, history = peer.history.at(-1)!
          const through = sessionLogPosition(source.stored.sequence)
          const prefix: SessionSnapshot = { ...peer, localPosition: through, lifecycle: 'active', history: [...peer.history.slice(0, -1),
            { ...history, through, localLifecycle: 'active', events: history.events.filter(item => item.stored.sequence <= source.stored.sequence) }] }
          const expected = workInteractionSettlement(foldAgentSession(prefix), interaction)
          if (expected === undefined || !sameWorkflowValue(expected, settled)) invalidHistory('workflow-causal-interaction-settlement')
        }
      }
      for (const proposal of [...state.proposals, ...state.reviews]) {
        const p = proposal.payload.message
        if (!sameWorkflowValue(reference(p.proposal, [workProposalRecordedEvent.type, workReviewRecordedEvent.type]).payload, p.value)) invalidHistory('workflow-causal-proposal-copy')
        for (const artifact of p.artifacts) if (!sameWorkflowValue(reference(artifact.ref, [artifactPublishedEvent.type]).payload, artifact.value)) invalidHistory('workflow-causal-artifact-copy')
      }
    }
    const { facts } = messages.get(snapshot.header.address)!
    for (const outgoing of facts.outbox.filter(item => item.envelope.type.startsWith('workflow/'))) {
      const source = outgoing.sendKey === undefined ? undefined : local.get(outgoing.sendKey.eventId)
      if (source === undefined || ![workProtocolRecordedEvent.type, workflowProtocolRecordedEvent.type, workGroupRequestedEvent.type].includes(source.stored.type)) invalidHistory('workflow-causal-send-source')
      const protocol = source.stored.type === workGroupRequestedEvent.type ? groupCommands(local, source.stored.eventId) : workProtocolRecordedEvent.decode(source.payload)
      const command = protocol.commands[outgoing.sendKey!.index]
      if (command === undefined || outgoing.command === undefined || !sameWorkflowValue(command, outgoing.command)) invalidHistory('workflow-causal-send-command')
      if (outgoing.status === 'delivered') {
        const received = messages.get(outgoing.envelope.recipient)?.inbox.get(outgoing.envelope.messageId)
        if (received === undefined || !sameWorkflowValue(received.envelope, outgoing.envelope)) invalidHistory('workflow-delivery-without-inbox')
      }
    }
    for (const incoming of facts.inbox.filter(item => item.envelope.type.startsWith('workflow/'))) {
      const outgoing = messages.get(incoming.envelope.sender)?.outbox.get(incoming.envelope.messageId)
      if (outgoing === undefined || outgoing.attemptCount === 0 || !sameWorkflowValue(outgoing.envelope, incoming.envelope)) invalidHistory('workflow-inbox-without-emission')
    }
  }
}
