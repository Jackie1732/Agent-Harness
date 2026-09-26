import type { AgentActionReference } from '../agent/contract.js'
import type { AgentActionIntent, AgentActionResult, AgentActionSettled } from '../agent/event-contract.js'
import type { AgentNativeActionExecutor } from '../agent/native-action-port.js'
import type { AgentProjectionState } from '../agent/projection-state.js'
import { requireEntry } from '../agent/projection-state.js'
import { originalAgentActionArguments } from '../agent/model-source.js'
import { foldAgentSession } from '../agent/projection.js'
import { AgentJournal } from '../agent/journal.js'
import { exact, text } from '../agent/validation.js'
import { referenceKey } from '../agent/input-codec.js'
import { clockTimestamp } from '../foundation/clock.js'
import type { Clock } from '../foundation/clock.js'
import type { JsonObject } from '../foundation/json.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { SessionEventId } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { sameWorkflowValue } from './work-binding.js'
import { workAcceptanceForRoot } from './work-projection.js'
import { workProtocolRecordedEvent } from './protocol.js'
import type { WorkflowProtocolRecorded } from './protocol.js'
import { workflowProgressMessage } from './progress.js'
import { WorkflowError, invalidHistory } from './errors.js'
import { assertWorkflowMessageFits } from './message-budget.js'

/** Derive optional protocol sends from the exact admitted action and its root's frozen authority. */
export function workActionCommands(state: AgentProjectionState, source: Exclude<WorkflowProtocolRecorded['source'], string>): WorkflowProtocolRecorded & JsonObject {
  const step = [...state.steps.values()].find(item => item.decided?.stored.eventId === source.action.eventId)
  const intent = step?.decided?.payload.actions[source.action.index]
  const turn = step === undefined ? undefined : state.turns.get(step.opened.payload.turn)
  const root = turn === undefined ? undefined : state.roots.get(turn.root)
  if (state.spec?.payload.protocolVersion !== 3 || intent?.route !== 'work-progress' || !step?.decided?.payload.admitted
    || turn === undefined || state.openTurn !== turn.started.stored.eventId || root?.source.kind !== 'workflow'
    || root.outcome !== null || root.stopControl !== null || state.actions.has(referenceKey(source.action))) invalidHistory('work-action-source')
  const binding = workAcceptanceForRoot(state, root.id).work!
  if (binding.value.kind !== 'production' || !binding.value.nativeActions.includes('agent_report_work_progress')) invalidHistory('work-action-authority')
  if (source.observedAt >= root.deadline) blocked('work-action-expired')
  const args = originalAgentActionArguments(state, intent)
  exact(args, ['text'])
  const value = text(args.text, binding.recipe.limits.maxTextBytes)
  if ([...state.sources.values()].some(event => {
    if (event.stored.type !== workProtocolRecordedEvent.type) return false
    const prior = workProtocolRecordedEvent.decode(event.payload).source
    return typeof prior !== 'string' && sameWorkflowValue(prior.action, source.action)
  })) invalidHistory('work-action-already-recorded')
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
  if (result.kind !== 'protocol-accepted' || intent?.route !== 'work-progress') invalidHistory('work-action-result-kind')
  const protocol = requireEntry(state.sources, result.protocol, 'work-action-protocol')
  const p = workProtocolRecordedEvent.decode(protocol.payload)
  if (protocol.stored.type !== workProtocolRecordedEvent.type || typeof p.source === 'string'
    || !sameWorkflowValue(p.source.action, event.payload.action)) invalidHistory('work-action-result-source')
}

/** The execution generation borrows its Session; durable sends remain owned by protocol maintenance. */
export class SessionWorkActions implements AgentNativeActionExecutor {
  constructor(readonly session: SessionHandle, readonly clock: Clock) {}

  async execute(_turn: SessionEventId, action: AgentActionReference, _intent: AgentActionIntent, _args: JsonObject, signal: AbortSignal): Promise<AgentActionResult> {
    if (signal.aborted) return { kind: 'not-started', reason: 'cancelled-before-work-action' }
    const state = foldAgentSession(this.session.snapshot())
    const source = { action, observedAt: clockTimestamp(this.clock) }
    const protocol = workActionCommands(state, source)
    const recorded = await new AgentJournal(this.session, state.spec!.payload.limits.maxJournalConflicts, this.clock)
      .append(workProtocolRecordedEvent, () => protocol)
    return { kind: 'protocol-accepted', protocol: recorded.stored.eventId }
  }
}

function blocked(reason: string): never { throw new WorkflowError('WORKFLOW_ADMISSION_BLOCKED', reason) }
