import { messageEnvelopeDigest } from '../communication/canonical-json.js'
import { outboxAttemptFailedEvent, outboxAttemptStartedEvent } from '../communication/session-events.js'
import type { MessageEnvelope } from '../communication/types.js'
import type { MessageId } from '../communication/ids.js'
import { readAssembly } from '../context/projection.js'
import type { SessionEventRecord } from '../session/types.js'
import { workGroupResultEvent } from '../workflow/group-events.js'
import { workProtocolClassifiedEvent } from '../workflow/interaction-events.js'
import type { CommunicationMetricFacts, ExperimentCountMetricName, MetricCountFact, MetricsEventRef, MetricsSessionFacts } from './metrics-types.js'

/** Separate sender/receiver copies, transport attempts, model adoption, and explicit protocol causation. */
export function communicationMetricFacts(sessions: readonly MetricsSessionFacts[]): CommunicationMetricFacts {
  const counts: MetricCountFact[] = []
  const messages = new Map<MessageId, { readonly envelope: MessageEnvelope; readonly digest: string; readonly refs: MetricsEventRef[]; conflict: boolean }>()
  for (const session of sessions) {
    const { snapshot, events, communication, agent } = session
    const byId = new Map(events.map(event => [event.stored.eventId, event]))
    const ref = (event: SessionEventRecord): MetricsEventRef => ({ address: snapshot.address, eventId: event.stored.eventId })
    const add = (name: ExperimentCountMetricName, selected: readonly SessionEventRecord[], value = selected.length) => counts.push({ name, value, refs: selected.map(ref) })
    const addMessage = (envelope: MessageEnvelope, event: SessionEventRecord) => {
      const digest = messageEnvelopeDigest(envelope), previous = messages.get(envelope.messageId)
      if (previous === undefined) messages.set(envelope.messageId, { envelope, digest, refs: [ref(event)], conflict: false })
      else { previous.refs.push(ref(event)); previous.conflict ||= previous.digest !== digest }
    }
    add('communication.outboxAccepted', communication.outbox.map(message => byId.get(message.acceptedEventId)!))
    add('communication.inboxAccepted', communication.inbox.map(message => byId.get(message.acceptedEventId)!))
    add('communication.delivered', communication.outbox.filter(message => message.status === 'delivered').map(message => byId.get(message.terminalEventId)!))
    add('communication.inboxProcessed', communication.inbox.filter(message => message.status === 'processed').map(message => byId.get(message.terminalEventId!)!))
    add('communication.outboxAbandoned', communication.outbox.filter(message => message.status === 'abandoned').map(message => byId.get(message.terminalEventId)!))
    add('communication.inboxAbandoned', communication.inbox.filter(message => message.status === 'abandoned').map(message => byId.get(message.terminalEventId!)!))
    for (const message of [...communication.outbox, ...communication.inbox]) addMessage(message.envelope, byId.get(message.acceptedEventId)!)
    add('communication.questionsAccepted', communication.inbox.filter(message => ['workflow/question', 'subagent/question'].includes(message.envelope.type)).map(message => byId.get(message.acceptedEventId)!))
    add('communication.answersAccepted', communication.inbox.filter(message => ['workflow/answer', 'subagent/answer'].includes(message.envelope.type)).map(message => byId.get(message.acceptedEventId)!))
    add('work.groupUnicasts', communication.outbox.filter(message => message.envelope.type === 'workflow/group').map(message => byId.get(message.acceptedEventId)!))
    if (agent !== null) {
      add('communication.peerInputsClaimed', agent.inputs.filter(input => input.claimedBy !== null
        && (input.message !== null || input.protocol !== undefined || input.work !== undefined || input.workMessage !== undefined))
        .map(input => byId.get(input.reference.eventId)!))
    }
    const inboxIds = new Set(communication.inbox.map(message => message.acceptedEventId))
    for (const event of events) {
      if (event.kind !== 'known') continue
      switch (event.stored.type) {
        case 'communication/outbox-attempt-started': {
          const payload = outboxAttemptStartedEvent.decode(event.payload)
          add('communication.attemptStarted', [event])
          if (payload.attempt > 1) add('communication.retries', [event])
          break
        }
        case 'communication/outbox-attempt-failed': {
          const payload = outboxAttemptFailedEvent.decode(event.payload)
          add(`communication.attemptFailed.${payload.code}`, [event])
          break
        }
        case 'context/assembly-committed': {
          const assembly = readAssembly(snapshot, event.stored.eventId)
          if (assembly.adoption.kind !== 'adopted') break
          const adoptedIds = new Set(assembly.committed.payload.selected.flatMap(unit => unit.sourceEventIds.filter(id => inboxIds.has(id))))
          for (const inbox of adoptedIds) add('communication.modelMessageAdoptions', [byId.get(inbox)!, event, byId.get(assembly.adoption.preparedEventId)!], 1)
          break
        }
        case 'work/group-requested': add('work.groups', [event]); break
        case 'work/question-declined': add('work.questionsDeclined', [event]); break
        case 'work/protocol-classified': {
          if (workProtocolClassifiedEvent.decode(event.payload).classification === 'duplicate') add('work.businessDuplicates', [event])
          break
        }
        case 'work/group-result': {
          const payload = workGroupResultEvent.decode(event.payload)
          const names = { delivered: 'work.groupDelivered', rejected: 'work.groupRejected', abandoned: 'work.groupAbandoned', 'outcome-unknown': 'work.groupOutcomeUnknown' } as const
          for (const [status, name] of Object.entries(names)) add(name, [event], payload.recipients.filter(recipient => recipient.status === status).length)
          break
        }
      }
    }
  }
  const depths = new Map<MessageId, number | null>(), reasons = new Set<string>()
  for (const [id, message] of messages) if (message.conflict) { depths.set(id, null); reasons.add('message-content-conflict') }
  for (const id of messages.keys()) {
    if (depths.has(id)) continue
    const chain: MessageId[] = [], visited = new Set<MessageId>()
    let cursor: MessageId | undefined = id, base: number | null = null
    while (cursor !== undefined) {
      if (depths.has(cursor)) { base = depths.get(cursor)!; break }
      if (visited.has(cursor)) { reasons.add('causation-cycle'); break }
      const message = messages.get(cursor)
      if (message === undefined) { reasons.add('missing-causation-parent'); break }
      visited.add(cursor); chain.push(cursor)
      if (message.envelope.causationId === undefined) { base = -1; break }
      cursor = message.envelope.causationId
    }
    for (const member of chain.reverse()) { base = base === null ? null : base + 1; depths.set(member, base) }
  }
  const knownDepths = [...depths.values()].filter((depth): depth is number => depth !== null)
  return { counts, causation: { maxDepth: knownDepths.reduce((maximum, depth) => Math.max(maximum, depth), 0),
    uniqueMessages: messages.size, resolvedMessages: knownDepths.length, reasons: [...reasons].sort(), refs: [...messages.values()].flatMap(message => message.refs) } }
}
