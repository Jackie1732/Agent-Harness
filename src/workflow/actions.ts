import type { AgentActionReference } from '../agent/contract.js'
import type { AgentActionIntent, AgentActionResult, AgentActionSettled } from '../agent/event-contract.js'
import type { AgentNativeActionExecutor } from '../agent/native-action-port.js'
import type { AgentProjectionState } from '../agent/projection-state.js'
import { requireEntry } from '../agent/projection-state.js'
import { foldAgentSession } from '../agent/projection.js'
import { AgentJournal } from '../agent/journal.js'
import { choice, exact, text } from '../agent/validation.js'
import { clockTimestamp } from '../foundation/clock.js'
import type { Clock } from '../foundation/clock.js'
import type { JsonObject } from '../foundation/json.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { SessionEventId } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { sameWorkflowValue } from './work-binding.js'
import { workActionSource } from './action-source.js'
import { executeWorkQuestion, workQuestionResult, workReceiveDescriptor } from './question-action.js'
import type { WorkInteractionAuthority } from './question-action.js'
import { workInteractionResolvedEvent, workQuestionRequestedEvent, workQuestionDeclinedEvent, workflowQuestionMessage, workflowAnswerMessage } from './interaction-events.js'
import { workProtocolRecordedEvent } from './protocol.js'
import type { WorkflowProtocolRecorded } from './protocol.js'
import { workflowProgressMessage } from './progress.js'
import { WorkflowError, invalidHistory } from './errors.js'
import { assertWorkflowMessageFits } from './message-budget.js'

/** Derive optional protocol sends from the exact admitted action and its root's frozen authority. */
export function workActionCommands(state: AgentProjectionState, source: Exclude<WorkflowProtocolRecorded['source'], string>): WorkflowProtocolRecorded & JsonObject {
  const { intent, turn, root, binding, args } = workActionSource(state, source.action)
  if (root.stopControl !== null) blocked('work-root-stopped')
  if (source.observedAt >= root.deadline) blocked('work-action-expired')
  if ([...state.sources.values()].some(event => {
    if (event.stored.type !== workProtocolRecordedEvent.type) return false
    const prior = workProtocolRecordedEvent.decode(event.payload).source
    return typeof prior !== 'string' && sameWorkflowValue(prior.action, source.action)
  })) invalidHistory('work-action-already-recorded')
  if (intent.route === 'work-answer') {
    exact(args, ['questionMessageId', 'outcome', 'text'])
    const input = [...state.inputs.values()].find(item => item.workMessage?.kind === 'question'
      && item.message?.messageId === args.questionMessageId && item.claimedBy !== null && state.turns.get(item.claimedBy)?.root === root.id)
    if (input?.message == null) blocked('work-question-not-claimed')
    const question = workflowQuestionMessage.decode(input.message.payload)
    if (source.observedAt >= question.deadline) blocked('work-question-expired')
    if ([...state.sources.values()].some(item => item.stored.type === workQuestionDeclinedEvent.type
      && workQuestionDeclinedEvent.decode(item.payload).inbox === input.workMessage!.inbox)) blocked('work-question-already-declined')
    if ([...state.sources.values()].some(item => item.stored.type === workProtocolRecordedEvent.type && workProtocolRecordedEvent.decode(item.payload).commands
      .some(command => command.type === workflowAnswerMessage.type && workflowAnswerMessage.decode(command.payload).questionMessageId === input.message!.messageId))) blocked('work-question-already-answered')
    const command = { kind: 'reply' as const, inboxMessageId: input.message.messageId, type: workflowAnswerMessage.type, payloadVersion: 1,
      payload: { definition: binding.definition, assignment: binding.assignment, targetAssignment: question.assignment,
        interaction: question.interaction, question: question.question, questionMessageId: input.message.messageId,
        outcome: choice(args.outcome, ['answered', 'declined']), text: text(args.text, binding.recipe.limits.maxTextBytes) } }
    assertWorkflowMessageFits(turn.started.stored.sessionId, command, binding.value.protocolLimits, input.message)
    return { assignment: binding.assignment, source, commands: [command] }
  }
  if (intent.route !== 'work-progress') invalidHistory('work-protocol-action-route')
  exact(args, ['text'])
  const value = text(args.text, binding.recipe.limits.maxTextBytes)
  const ordinal = [...state.sources.values()].filter(event => event.stored.type === workProtocolRecordedEvent.type
    && workProtocolRecordedEvent.decode(event.payload).commands.some(command => command.type === workflowProgressMessage.type
      && sameWorkflowValue(workProtocolRecordedEvent.decode(event.payload).assignment, binding.assignment))).length + 1
  if (ordinal > binding.recipe.limits.maxProgress) blocked('work-progress-limit')
  const command = { kind: 'send' as const, type: workflowProgressMessage.type, payloadVersion: 1,
    request: { kind: 'root' as const, recipient: binding.assignment.address, channelId: binding.value.channelId },
    payload: { assignment: binding.assignment, root: root.id, ordinal, text: value } }
  assertWorkflowMessageFits(turn.started.stored.sessionId, command, binding.value.protocolLimits)
  return { assignment: binding.assignment, source, commands: [command] }
}

export function validateWorkActionProtocol(state: AgentProjectionState, event: CommittedSessionEvent): void {
  const protocol = workProtocolRecordedEvent.decode(event.payload)
  if (typeof protocol.source === 'string') return
  if (!sameWorkflowValue(protocol, workActionCommands(state, protocol.source))) invalidHistory('work-action-command-mismatch')
}

export function validateWorkActionResult(state: AgentProjectionState, event: CommittedSessionEvent<AgentActionSettled>, intent: AgentActionIntent | null): void {
  const result = event.payload.result
  if (result.kind === 'wait' && intent?.route === 'work-receive') {
    if (!sameWorkflowValue(result.descriptor, workReceiveDescriptor(state, event.payload.action, result.descriptor.observedAt))) invalidHistory('work-receive-source')
    return
  }
  if (result.kind === 'wait' && intent?.route === 'work-ask') {
    const request = [...state.sources.values()].find(item => item.stored.type === workQuestionRequestedEvent.type
      && sameWorkflowValue(workQuestionRequestedEvent.decode(item.payload).action, event.payload.action))
    const resolved = [...state.sources.values()].find(item => item.stored.type === workInteractionResolvedEvent.type
      && workInteractionResolvedEvent.decode(item.payload).request === request?.stored.eventId)
    if (resolved === undefined || !sameWorkflowValue(result, workQuestionResult(state, { ...resolved, payload: workInteractionResolvedEvent.decode(resolved.payload) }))) invalidHistory('work-question-wait-source')
    return
  }
  if (result.kind !== 'protocol-accepted' || !['work-progress', 'work-answer'].includes(intent?.route ?? '')) invalidHistory('work-action-result-kind')
  const protocol = requireEntry(state.sources, result.protocol, 'work-action-protocol')
  const p = workProtocolRecordedEvent.decode(protocol.payload)
  if (protocol.stored.type !== workProtocolRecordedEvent.type || typeof p.source === 'string'
    || !sameWorkflowValue(p.source.action, event.payload.action)) invalidHistory('work-action-result-source')
}

/** The execution generation borrows its Session; durable sends remain owned by protocol maintenance. */
export class SessionWorkActions implements AgentNativeActionExecutor {
  constructor(readonly session: SessionHandle, readonly clock: Clock, readonly authority?: WorkInteractionAuthority) {}

  async execute(_turn: SessionEventId, action: AgentActionReference, _intent: AgentActionIntent, _args: JsonObject, signal: AbortSignal): Promise<AgentActionResult> {
    if (signal.aborted) return { kind: 'not-started', reason: 'cancelled-before-work-action' }
    const state = foldAgentSession(this.session.snapshot())
    const source = { action, observedAt: clockTimestamp(this.clock) }
    if (_intent.route === 'work-receive') return { kind: 'wait', descriptor: workReceiveDescriptor(state, action, source.observedAt) }
    if (_intent.route === 'work-ask') {
      if (this.authority === undefined) blocked('work-interaction-authority-unavailable')
      return executeWorkQuestion(this.session, this.clock, action, this.authority)
    }
    const protocol = workActionCommands(state, source)
    const recorded = await new AgentJournal(this.session, state.spec!.payload.limits.maxJournalConflicts, this.clock)
      .append(workProtocolRecordedEvent, () => protocol)
    return { kind: 'protocol-accepted', protocol: recorded.stored.eventId }
  }
}

function blocked(reason: string): never { throw new WorkflowError('WORKFLOW_ADMISSION_BLOCKED', reason) }
