import type { SessionHandle } from '../session/session-handle.js'
import type { SessionEventId } from '../session/ids.js'
import type { Clock } from '../foundation/clock.js'
import { clockTimestamp } from '../foundation/clock.js'
import type { JsonObject } from '../foundation/json.js'
import { AgentJournal } from '../agent/journal.js'
import { projectAgentSession } from '../agent/projection.js'
import type { AgentActionReference, AgentWaitDescriptor } from '../agent/contract.js'
import type { AgentActionIntent, AgentActionResult } from '../agent/event-contract.js'
import { eventId, exact, integer, text } from '../agent/validation.js'
import type { SubagentActionExecutor } from './action-port.js'
import type { SubagentAdmission } from './admission.js'
import type { DelegationRequested } from './event-contract.js'
import { SubagentError } from './errors.js'
import { subagentProtocolRecordedEvent } from './session-events.js'
import { parseMessageId } from '../communication/ids.js'
import type { SubagentMessagePayloads } from './messages.js'
import type { MessageSendCommand } from '../communication/send-command.js'

/** Native actions accept durable obligations and yield the existing Agent driver at wait checkpoints. */
export class SessionSubagentActions implements SubagentActionExecutor {
  constructor(readonly session: SessionHandle, readonly parentKey: string, readonly admission: SubagentAdmission, readonly clock: Clock) {}

  async execute(turnId: SessionEventId, action: AgentActionReference, intent: AgentActionIntent, args: JsonObject, signal: AbortSignal): Promise<AgentActionResult> {
    const state = projectAgentSession(this.session.snapshot())
    const spec = state.spec!.payload
    const turn = state.turns.find(item => item.started.stored.eventId === turnId)
    const root = state.roots.find(item => item.id === turn?.root)
    if (spec.protocolVersion === 1 || turn === undefined || state.openTurn !== turnId || root === undefined || root.outcome !== null || root.stopControl !== null || signal.aborted) invalid('subagent-action-not-active')
    let delegation: SessionEventId
    let request: DelegationRequested
    if (intent.route === 'spawn') {
      const accepted = await this.admission.spawn(this.parentKey, this.session, root.id, { kind: 'model', action, intent: intent.source }, args)
      delegation = accepted.delegationId
      request = projectAgentSession(this.session.snapshot()).subagents.delegations.find(item => item.stored.eventId === delegation)!.payload
      return { kind: 'wait', descriptor: { kind: 'delegation', delegation, root: root.id, deadline: request.deadline,
        observedAt: request.observedAt, protectedTurns: state.turns.filter(item => item.root === root.id).map(item => item.started.stored.eventId) } }
    }
    const toChild = intent.route === 'await-subagent' || intent.route === 'answer-subagent'
    if (toChild) {
      exact(args, intent.route === 'await-subagent' ? ['delegationId', 'timeoutMs'] : ['delegationId', 'questionMessageId', 'text', 'timeoutMs'])
      delegation = eventId(args.delegationId)
      const accepted = state.subagents.delegations.find(item => item.stored.eventId === delegation && item.payload.parentRoot === root.id)
      if (spec.subagents.role !== 'parent' || accepted === undefined) invalid('delegation-not-owned')
      request = accepted.payload
    } else {
      if (spec.subagents.role !== 'child' || state.subagents.bound === null) invalid('child-role-required')
      exact(args, intent.route === 'ask-parent' ? ['question', 'timeoutMs'] : ['text'])
      delegation = state.subagents.bound.payload.delegation; request = state.subagents.bound.payload.requested
    }
    const observedAt = clockTimestamp(this.clock)
    const common = { root: root.id, observedAt, protectedTurns: state.turns.filter(item => item.root === root.id).map(item => item.started.stored.eventId),
      deadline: intent.route === 'progress' ? request.deadline : new Date(Math.min(Date.parse(observedAt) + integer(args.timeoutMs, 1, spec.limits.maxWaitMs), Date.parse(root.deadline), Date.parse(request.deadline))).toISOString() }
    if (intent.route === 'await-subagent') return { kind: 'wait', descriptor: { ...common, kind: 'delegation', delegation } }
    if (observedAt >= request.deadline) invalid('delegation-expired')
    const kind: 'question' | 'answer' | 'progress' = intent.route === 'ask-parent' ? 'question' : intent.route === 'answer-subagent' ? 'answer' : 'progress'
    if (kind === 'answer' && (state.subagents.classifications.some(item => item.payload.delegation === delegation && item.payload.kind === 'result' && item.payload.classification === 'eligible')
      || state.subagents.observations.some(item => item.payload.delegation === delegation && item.payload.business.kind !== 'pending'))) invalid('child-already-terminal')
    const ordinal = state.subagents.protocol.filter(item => item.payload.delegation === delegation && item.payload.kind === kind).length + 1
    if (kind === 'question' && ordinal > request.effectivePlan.template.maxQuestions) invalid('question-limit')
    const identity = { delegation, parentRoot: request.parentRoot, childSessionId: request.childSessionId }
    const content = text(kind === 'question' ? args.question : args.text, request.effectivePlan.template.limits.maxResultBytes)
    const payload: SubagentMessagePayloads['question' | 'answer' | 'progress'] = kind === 'question' ? { ...identity, ordinal, question: content }
      : kind === 'answer' ? { ...identity, questionMessageId: parseMessageId(text(args.questionMessageId)), text: content } : { ...identity, ordinal, text: content }
    const incoming = state.inputs.find(input => input.protocol?.delegation === delegation && (kind === 'answer' ? input.message?.messageId === args.questionMessageId : input.protocol.kind === 'task'))?.message
    if (incoming == null) invalid('protocol-inbox-required')
    const body = { type: 'subagent/' + kind, payloadVersion: 1, payload }
    const command: MessageSendCommand = kind === 'progress' ? { ...body, kind: 'send', request: { kind: 'derived', recipient: request.parentAddress,
      channelId: request.channelId, correlationId: incoming.messageId, causationId: incoming.messageId } } : { ...body, kind: 'reply', inboxMessageId: incoming.messageId }
    const journal = new AgentJournal(this.session, spec.limits.maxJournalConflicts, this.clock)
    const protocol = await journal.append(subagentProtocolRecordedEvent, () => ({ delegation, parentAddress: request.parentAddress, childAddress: request.childAddress,
      kind, ordinal, command, source: { kind: 'action' as const, action, intent: intent.source }, observedAt }))
    if (kind === 'progress') return { kind: 'protocol-accepted', protocol: protocol.stored.eventId }
    const descriptor: AgentWaitDescriptor = kind === 'question' ? { ...common, kind: 'parent-answer', delegation, question: protocol.stored.eventId }
      : { ...common, kind: 'delegation', delegation }
    return { kind: 'wait', descriptor }
  }
}
function invalid(reason: string): never { throw new SubagentError('SUBAGENT_STATE_INVALID', reason) }
