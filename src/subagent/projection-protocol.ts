import { originalAgentActionArguments } from '../agent/model-source.js'
import { referenceKey } from '../agent/input-codec.js'
import type { AgentProjectionState } from '../agent/projection-state.js'
import { equal, exact, integer, record, text } from '../agent/validation.js'
import { inboxAcceptedEvent } from '../communication/session-events.js'
import { formatSessionAddress } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { SubagentProtocolRecorded } from './event-contract.js'
import { decodeSubagentMessage } from './messages.js'
import { requireDelegationBinding } from './state.js'
import { childResultPayload } from './result.js'
import { SubagentError } from './errors.js'

/** Each outgoing message has one bounded, independently checkable local source. */
export function applySubagentProtocol(state: AgentProjectionState, event: CommittedSessionEvent<SubagentProtocolRecorded>): void {
  const p = event.payload; const request = requireDelegationBinding(state.subagents, p)
  const parent = p.kind === 'task' || p.kind === 'answer'
  if (formatSessionAddress(event.stored.sessionId) !== (parent ? p.parentAddress : p.childAddress)) invalid('protocol-writer')
  const previous = [...state.subagents.protocol.values()].filter(item => item.payload.delegation === p.delegation && item.payload.kind === p.kind)
  const maximum = p.kind === 'progress' ? request.effectivePlan.template.maxProgress
    : p.kind === 'question' || p.kind === 'answer' ? request.effectivePlan.template.maxQuestions : 1
  if (p.ordinal !== previous.length + 1 || p.ordinal > maximum) invalid('protocol-quota')
  const body = decodeSubagentMessage(p.kind, p.command.payload)
  if (body.parentRoot !== request.parentRoot || body.childSessionId !== request.childSessionId) invalid('protocol-body-identity')
  const source = p.source
  if (p.kind === 'task') {
    if (source.kind !== 'delegation' || source.requested !== p.delegation || p.command.kind !== 'send'
      || !equal(p.command.request, { kind: 'root', recipient: p.childAddress, channelId: request.channelId })) invalid('task-send-source')
    if (state.subagents.provisions.get(p.delegation)?.payload.outcome !== 'installed') invalid('task-before-provision')
    const turn = [...state.turns.values()].filter(item => item.root === request.parentRoot).at(-1)
    const root = state.roots.get(request.parentRoot)
    if (turn?.settled?.payload.outcome !== 'waiting' || root?.outcome !== null || root.stopControl !== null
      || p.observedAt >= request.deadline) invalid('task-before-checkpoint')
    const expected = { delegation: p.delegation, parentRoot: request.parentRoot, childSessionId: request.childSessionId,
      task: request.request.task, materials: request.request.materials, grant: request.grant, workspace: request.effectivePlan.workspace, deadline: request.deadline }
    if (!equal(body, expected)) invalid('task-content')
  } else if (p.kind === 'result') {
    const expected = childResultPayload(state, p)
    if (source.kind !== 'terminal' || source.turn !== expected.source.turn || source.release !== expected.executionRelease.eventId
      || !equal(body, expected)) invalid('result-source')
  } else {
    if (source.kind !== 'action') invalid('protocol-action-required')
    const step = [...state.steps.values()].find(item => item.decided?.stored.eventId === source.action.eventId)
    const intent = step?.decided?.payload.actions[source.action.index]
    const turn = step === undefined ? undefined : state.turns.get(step.opened.payload.turn)
    const root = turn === undefined ? undefined : state.roots.get(turn.root)
    if (step?.decided?.payload.admitted !== true || intent === undefined || !equal(intent.source, source.intent)
      || turn?.started.stored.eventId !== state.openTurn || root?.outcome !== null || root.stopControl !== null
      || p.observedAt >= request.deadline || state.actions.has(referenceKey(source.action))) invalid('protocol-action-source')
    if ([...state.subagents.protocol.values()].some(item => item.payload.source.kind === 'action' && equal(item.payload.source.action, source.action))) invalid('duplicate-protocol-action')
    const args = originalAgentActionArguments(state, intent)
    const argsFields = p.kind === 'question' ? ['question', 'timeoutMs'] : p.kind === 'answer' ? ['delegationId', 'questionMessageId', 'text', 'timeoutMs'] : ['text']
    exact(args, argsFields)
    if (p.kind !== 'progress') integer(args.timeoutMs, 1, state.spec!.payload.limits.maxWaitMs)
    const value = record(body)
    if (p.kind === 'question' ? intent.route !== 'ask-parent' || value.question !== text(args.question, request.effectivePlan.template.limits.maxResultBytes)
      : p.kind === 'answer' ? intent.route !== 'answer-subagent' || args.delegationId !== p.delegation || value.questionMessageId !== args.questionMessageId || value.text !== args.text || root.id !== request.parentRoot
        : intent.route !== 'progress' || value.text !== text(args.text, request.effectivePlan.template.limits.maxResultBytes)) invalid('protocol-action-arguments')
    if (p.kind !== 'answer' && value.ordinal !== p.ordinal) invalid('protocol-ordinal-body')
    if (p.kind === 'question' && previous.some(question => {
      const outbox = [...state.sources.values()].find(item => item.stored.type === 'communication/outbox-accepted'
        && equal(record(item.payload).sendKey, { eventId: question.stored.eventId, index: 0 }))
      return outbox === undefined || ![...state.inputs.values()].some(input => input.protocol?.kind === 'answer'
        && input.protocol.delegation === p.delegation && input.claimedBy !== null
        && input.message?.replyTo === record(record(outbox.payload).envelope).messageId)
    })) invalid('question-still-open')
    if (p.kind === 'answer') {
      if ([...state.subagents.observations.values()].some(item => item.payload.delegation === p.delegation && item.payload.business.kind !== 'pending')
        || [...state.subagents.classifications.values()].some(item => item.payload.delegation === p.delegation && item.payload.kind === 'result' && item.payload.classification === 'eligible')) invalid('answer-after-child-terminal')
      const claim = [...state.inputs.values()].find(item => item.protocol?.delegation === p.delegation && item.protocol.kind === 'question'
        && item.message?.messageId === args.questionMessageId && item.claimedBy !== null
        && state.turns.get(item.claimedBy)?.root === root.id)
      if (claim === undefined || previous.some(item => record(item.payload.command.payload).questionMessageId === args.questionMessageId)) invalid('answer-not-claimed-or-duplicate')
    }
  }
  if (p.kind !== 'task') {
    const target = p.kind === 'answer' ? record(body).questionMessageId : undefined
    const inbox = [...state.sources.values()].find(item => item.stored.type === inboxAcceptedEvent.type
      && (target === undefined ? record(record(item.payload).envelope).type === 'subagent/task' : record(record(item.payload).envelope).messageId === target)
      && record(record(record(item.payload).envelope).payload).delegation === p.delegation)
    if (inbox === undefined) invalid('protocol-inbox-source')
    const envelope = inboxAcceptedEvent.decode(inbox.payload).envelope
    if (p.kind === 'progress') {
      if (p.command.kind !== 'send' || !equal(p.command.request, { kind: 'derived', recipient: p.parentAddress, channelId: request.channelId,
        correlationId: envelope.messageId, causationId: envelope.messageId })) invalid('progress-send-source')
    } else if (p.command.kind !== 'reply' || p.command.inboxMessageId !== envelope.messageId) invalid('protocol-reply-source')
  }
  if (Buffer.byteLength(JSON.stringify(body)) > request.effectivePlan.template.limits.maxResultBytes && p.kind !== 'task') invalid('protocol-content-bytes')
  state.subagents.protocol.set(event.stored.eventId, event)
}
function invalid(reason: string): never { throw new SubagentError('SUBAGENT_STATE_INVALID', reason) }
