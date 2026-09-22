import { inputKey } from '../agent/input-codec.js'
import type { AgentProjectionState } from '../agent/projection-state.js'
import { requireEntry, requireSpec } from '../agent/projection-state.js'
import { equal, record } from '../agent/validation.js'
import { inboxAcceptedEvent } from '../communication/session-events.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { MessageEnvelope } from '../communication/types.js'
import type { SubagentInputDisposed, SubagentMessageClassified } from './event-contract.js'
import { decodeSubagentMessage } from './messages.js'
import { requireDelegationBinding } from './state.js'
import { SubagentError } from './errors.js'

/** First classification separates Inbox receipt completion from the later Agent claim. */
export function applySubagentClassification(state: AgentProjectionState, event: CommittedSessionEvent<SubagentMessageClassified>): void {
  const p = event.payload
  const request = requireDelegationBinding(state.subagents, p)
  const spec = requireSpec(state).payload
  if (spec.protocolVersion !== 2) invalid('classification-spec')
  const inbox = requireEntry(state.sources, p.inbox, 'missing-protocol-inbox')
  if (inbox.stored.type !== inboxAcceptedEvent.type || inbox.stored.payloadVersion !== 1
    || [...state.subagents.classifications.values()].some(item => item.payload.inbox === p.inbox)) invalid('classification-inbox-source')
  const envelope = inboxAcceptedEvent.decode(inbox.payload).envelope
  if (envelope.type !== `subagent/${p.kind}` || envelope.payloadVersion !== 1) invalid('classification-message-kind')
  if (p.classification !== 'rejected') {
    const body = decodeSubagentMessage(p.kind, envelope.payload)
    const toChild = p.kind === 'task' || p.kind === 'answer'
    if (body.delegation !== p.delegation || body.parentRoot !== request.parentRoot || body.childSessionId !== request.childSessionId
      || envelope.sender !== (toChild ? p.parentAddress : p.childAddress) || envelope.recipient !== (toChild ? p.childAddress : p.parentAddress)
      || envelope.channelId !== request.channelId || spec.subagents.role !== (toChild ? 'child' : 'parent')) invalid('classification-identity')
    if ((p.kind === 'progress') !== (p.classification === 'progress-only')) invalid('classification-effect')
    const prior = [...state.subagents.classifications.values()].filter(item => item.payload.delegation === p.delegation && item.payload.classification !== 'rejected')
    if (p.kind === 'task') {
      const task = decodeSubagentMessage('task', body)
      if (prior.some(item => item.payload.kind === 'task') || state.subagents.ready === null || state.roots.size !== 0
        || envelope.replyTo !== undefined || envelope.causationId !== undefined || envelope.correlationId !== envelope.messageId
        || !equal([task.task, task.materials, task.grant, task.workspace, task.deadline],
          [request.request.task, request.request.materials, request.grant, request.effectivePlan.workspace, request.deadline])) invalid('task-classification')
    } else {
      const task = protocolTask(state, toChild, p.delegation)
      if (task === undefined || envelope.correlationId !== task.messageId) invalid('protocol-correlation')
      if (p.kind === 'answer') {
        const answer = decodeSubagentMessage('answer', body)
        const outgoing = [...state.sources.values()].find(item => item.stored.type === 'communication/outbox-accepted'
          && record(record(item.payload).envelope).messageId === answer.questionMessageId)
        if (outgoing === undefined || record(record(outgoing.payload).envelope).type !== 'subagent/question'
          || envelope.replyTo !== answer.questionMessageId || envelope.causationId !== answer.questionMessageId
          || prior.some(item => item.payload.kind === 'answer' && record(record(requireEntry(state.sources, item.payload.inbox, 'previous-answer').payload).envelope).replyTo === answer.questionMessageId)) invalid('answer-causation')
      } else if (p.kind === 'progress') {
        const progress = decodeSubagentMessage('progress', body)
        if (envelope.replyTo !== undefined || envelope.causationId !== task.messageId
          || progress.ordinal !== prior.filter(item => item.payload.kind === 'progress').length + 1
          || progress.ordinal > request.effectivePlan.template.maxProgress) invalid('progress-causation')
      } else {
        if (envelope.replyTo !== task.messageId || envelope.causationId !== task.messageId) invalid('task-reply-causation')
        if (p.kind === 'result' && prior.some(item => item.payload.kind === 'result')) invalid('duplicate-result')
        if (p.kind === 'question') {
          const question = decodeSubagentMessage('question', body)
          if (question.ordinal !== prior.filter(item => item.payload.kind === 'question').length + 1
            || question.ordinal > request.effectivePlan.template.maxQuestions || prior.some(item => item.payload.kind === 'result')) invalid('question-ordinal')
        }
      }
    }
    if (Buffer.byteLength(JSON.stringify(envelope.payload)) > request.effectivePlan.template.limits.maxResultBytes && p.kind !== 'task') invalid('protocol-message-bytes')
  }
  state.subagents.classifications.set(event.stored.eventId, event)
  if (p.classification !== 'eligible') return
  const pending = [...state.inputs.values()].filter(input => input.reference.kind === 'subagent' && ['queued', 'reserved', 'claimed', 'review-required'].includes(input.status))
  if (pending.length >= spec.limits.maxPendingInputs) invalid('protocol-input-capacity')
  const reference = { kind: 'subagent' as const, eventId: event.stored.eventId }
  state.inputs.set(inputKey(reference), { reference, protocol: { delegation: p.delegation, kind: p.kind, inbox: p.inbox },
    input: null, message: envelope, acceptedAt: inbox.stored.recordedAt, sequence: inbox.stored.sequence,
    lane: `subagent:${p.delegation}`, status: 'queued', claimedBy: null, reservedBy: null, everMatched: false, reason: null })
}

function protocolTask(state: AgentProjectionState, child: boolean, delegation: import('../session/ids.js').SessionEventId): MessageEnvelope | undefined {
  const type = child ? 'communication/inbox-accepted' : 'communication/outbox-accepted'
  const event = [...state.sources.values()].find(item => item.stored.type === type && record(record(item.payload).envelope).type === 'subagent/task' && record(record(record(item.payload).envelope).payload).delegation === delegation)
  return event === undefined ? undefined : record(event.payload).envelope as MessageEnvelope
}

export function applySubagentInputDisposed(state: AgentProjectionState, event: CommittedSessionEvent<SubagentInputDisposed>): void {
  const p = event.payload; requireDelegationBinding(state.subagents, p)
  const input = requireEntry(state.inputs, inputKey({ kind: 'subagent', eventId: p.input }), 'missing-protocol-input')
  if (input.protocol?.delegation !== p.delegation || !['queued', 'review-required'].includes(input.status)
    || input.reservedBy !== null || input.claimedBy !== null) invalid('protocol-input-owned')
  input.status = p.disposition; input.reason = p.reasonCode
}
function invalid(reason: string): never { throw new SubagentError('SUBAGENT_STATE_INVALID', reason) }
