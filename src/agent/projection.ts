import { validateWorkflowProtocol, workProtocolRecordedEvent } from '../workflow/protocol.js'
import { validateWorkActionProtocol } from '../workflow/actions.js'
import { workProtocolClassifiedEvent, workQuestionRequestedEvent, workInteractionResolvedEvent } from '../workflow/interaction-events.js'
import { applyWorkProtocolClassified } from '../workflow/receive.js'
import { validateWorkInteractionEvent } from '../workflow/question-action.js'
import { workQuestionDeclinedEvent } from '../workflow/interaction-events.js'
import { applyWorkQuestionDeclined } from '../workflow/question-decline.js'
import { workGroupEventDefinitions, workGroupResultEvent } from '../workflow/group-events.js'
import { validateGroupActionEvent } from '../workflow/group-action.js'
import { applyWorkGroupResult } from '../workflow/group-result.js'
import { workInputUnadoptedEvent, applyWorkInputUnadopted } from '../workflow/input-disposition.js'
import { applyWorkResultEvent } from '../workflow/result-projection.js'
import { workResultEventDefinitions } from '../workflow/result-events.js'
import { applyWorkAssignmentAccepted, applyWorkAssignmentSettled } from '../workflow/work-projection.js'
import { workAssignmentSettledEvent } from '../workflow/settlement-events.js'
import { workAssignmentAcceptedEvent } from '../workflow/work-binding.js'
import { workStopReceivedEvent, workStopSettledEvent, workAssignmentRejectedEvent } from '../workflow/stop-events.js'
import { applyWorkStop } from '../workflow/stop-projection.js'
import { applyStoppedWorkMessage, workStoppedMessageEvent } from '../workflow/stopped-message.js'
import { sessionDelegationsClosed } from '../subagent/closure.js'
import { isSessionEndedRecord } from '../session/history.js'
import { inboxAcceptedEvent, inboxAbandonedEvent, inboxProcessedEvent } from '../communication/session-events.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import { projectModelSession } from '../model/projection.js'
import { projectToolSession } from '../tool/projection.js'
import type { JsonValue } from '../foundation/json.js'
import type { CommittedSessionEvent, SessionSnapshot } from '../session/types.js'
import { invalidAgent } from './errors.js'
import { inputKey, referenceKey } from './input-codec.js'
import { applyControlRequested, applyControlSettled, applyWaitSettled } from './projection-controls.js'
import { applyMaintenanceRunSettled, applyMaintenanceRunStarted, applyRunSettled, applyRunStarted, applyTurnSettled, applyTurnStarted } from './projection-runs.js'
import { applyActionSettled, applyStepDecided, applyStepOpened } from './projection-steps.js'
import type { AgentProjectionState } from './projection-state.js'
import { initialAgentState, requireEntry, requireOpenRun, requireSpec } from './projection-state.js'
import * as events from './session-events.js'
import type { AgentSessionSnapshot } from './state.js'
import { equal, record } from './validation.js'
import { applySubagentEvent } from '../subagent/projection.js'
import { workRecoveryRequestedEvent, workRecoverySettledEvent } from '../workflow/recovery-events.js'
import { applyWorkRecoveryEvent, projectWorkRecoveries } from '../workflow/recovery-projection.js'

function applyInput(state: AgentProjectionState, event: CommittedSessionEvent): void {
  const p = events.agentInputAcceptedEvent.decode(event.payload)
  const spec = requireSpec(state)
  if (spec.payload.protocolVersion !== 1 && spec.payload.subagents.role === 'child') invalidAgent('child-input-requires-protocol')
  if (p.spec !== spec.stored.eventId || state.openRecovery !== null || state.closing !== null) invalidAgent('input-not-admissible')
  if (Buffer.byteLength(p.input.text) > spec.payload.limits.maxInputBytes) invalidAgent('input-byte-limit')
  const pending = [...state.inputs.values()].filter(input => input.message === null && ['queued', 'reserved', 'claimed', 'review-required'].includes(input.status))
  if (pending.length >= spec.payload.limits.maxPendingInputs) invalidAgent('input-capacity')
  if (p.input.kind === 'answer') {
    const wait = requireEntry(state.waits, referenceKey(p.input.wait), 'missing-answer-wait')
    const result = wait.created.payload.result
    if (wait.settled !== null || result.kind !== 'wait' || result.descriptor.kind !== 'user') invalidAgent('answer-wait-terminal')
    const root = requireEntry(state.roots, result.descriptor.root, 'missing-root')
    if (root.outcome !== null || root.stopControl !== null) invalidAgent('answer-root-stopped')
  }
  const reference = { kind: 'user' as const, eventId: event.stored.eventId }
  state.inputs.set(inputKey(reference), { reference, input: p.input, message: null, acceptedAt: event.stored.recordedAt,
    sequence: event.stored.sequence, lane: 'user', status: 'queued', claimedBy: null, reservedBy: null, everMatched: false, reason: null })
}
function applyAgentEvent(state: AgentProjectionState, event: CommittedSessionEvent): void {
  if (event.stored.ignorable === true) invalidAgent('unsupported-agent-event')
  const decoded = <T,>(decode: (value: JsonValue) => T) => ({ ...event, payload: decode(event.payload) })
  if (['agent/turn-started', 'agent/turn-settled', 'agent/step-decided', 'agent/action-settled', 'agent/wait-settled'].includes(event.stored.type)
    && event.stored.payloadVersion !== requireSpec(state).payload.protocolVersion) invalidAgent('agent-event-spec-version')
  switch (event.stored.type) {
    case 'agent/spec-recorded': {
      if (state.spec !== null) invalidAgent('spec-already-installed')
      const spec = event.stored.payloadVersion === 3 ? events.workflowAgentSpecRecordedEvent.decode(event.payload) : event.stored.payloadVersion === 2 ? events.subagentAgentSpecRecordedEvent.decode(event.payload) : events.agentSpecRecordedEvent.decode(event.payload)
      const profile = requireEntry(state.sources, spec.profileEventId, 'missing-spec-profile')
      if (profile.stored.type !== 'context/profile-recorded' || profile.stored.payloadVersion !== (spec.protocolVersion + 1)
        || record(profile.payload).purpose !== 'generation' || !equal(record(profile.payload).toolNames, spec.toolNames)) invalidAgent('spec-profile-mismatch')
      if (spec.protocolVersion === 2 && spec.subagents.role === 'child') {
        const bound = state.subagents.bound
        if (bound?.stored.eventId !== spec.subagents.bound || !equal(spec.budget, bound.payload.requested.grant)
          || spec.subagents.deadline !== bound.payload.requested.deadline
          || !equal(spec.subagents.protocolReserve, bound.payload.requested.childProtocolReserve)) invalidAgent('child-spec-source')
      } else if (state.subagents.bound !== null) invalidAgent('bound-session-requires-child-spec')
      state.spec = { ...event, payload: spec }; break
    }
    case 'agent/input-accepted': applyInput(state, event); break
    case 'agent/run-started':
      if (event.stored.payloadVersion === 2) applyMaintenanceRunStarted(state, decoded(events.agentMaintenanceRunStartedEvent.decode))
      else applyRunStarted(state, decoded(events.agentBusinessEvents(requireSpec(state).payload.protocolVersion).started.decode))
      break
    case 'agent/run-settled':
      if (event.stored.payloadVersion === 2) applyMaintenanceRunSettled(state, decoded(events.agentMaintenanceRunSettledEvent.decode))
      else applyRunSettled(state, decoded(events.agentBusinessEvents(requireSpec(state).payload.protocolVersion).settled.decode))
      break
    case 'agent/turn-started': applyTurnStarted(state, decoded(events.agentExecutionEvents(requireSpec(state).payload.protocolVersion).turnStarted.decode)); break
    case 'agent/turn-settled': applyTurnSettled(state, decoded(events.agentTurnSettledEvent.decode)); break
    case 'agent/step-opened': applyStepOpened(state, decoded(events.agentStepOpenedEvent.decode)); break
    case 'agent/step-decided': applyStepDecided(state, decoded(events.agentExecutionEvents(requireSpec(state).payload.protocolVersion).stepDecided.decode)); break
    case 'agent/action-settled': applyActionSettled(state, decoded(events.agentExecutionEvents(requireSpec(state).payload.protocolVersion).actionSettled.decode)); break
    case 'agent/wait-settled': applyWaitSettled(state, decoded(events.agentExecutionEvents(requireSpec(state).payload.protocolVersion).waitSettled.decode)); break
    case 'agent/control-requested':
      if (event.stored.payloadVersion >= 3 && event.stored.payloadVersion !== requireSpec(state).payload.protocolVersion + 1) invalidAgent('agent-event-spec-version')
      applyControlRequested(state, decoded(event.stored.payloadVersion >= 3 ? events.agentExecutionEvents(requireSpec(state).payload.protocolVersion).abandonRequested.decode : events.agentControlRequestedEvent.decode)); break
    case 'agent/control-settled': applyControlSettled(state, decoded(events.agentControlSettledEvent.decode)); break
    case 'agent/command-accepted': {
      const command = decoded(events.agentCommandAcceptedEvent.decode)
      requireOpenRun(state, command.payload.run, 'command')
      if (command.payload.spec !== requireSpec(state).stored.eventId || state.openRecovery !== null || state.closing !== null
        || [...state.commands.values()].some(prior => prior.payload.run === command.payload.run)) invalidAgent('command-not-admissible')
      if (state.commands.size >= requireSpec(state).payload.maxDirectSendCommandsPerSession) invalidAgent('command-budget')
      state.commands.set(event.stored.eventId, command); break
    }
    default: invalidAgent('unknown-agent-event')
  }
}
function applyCommunicationInput(state: AgentProjectionState, event: CommittedSessionEvent): void {
  if (event.stored.type === inboxAcceptedEvent.type) {
    const payload = inboxAcceptedEvent.decode(event.payload)
    const message = payload.envelope
    if (state.spec !== null && state.spec.payload.protocolVersion !== 1 && message.type.startsWith('subagent/')
      || state.spec?.payload.protocolVersion === 3 && message.type.startsWith('workflow/')) return
    const reference = { kind: 'peer' as const, eventId: event.stored.eventId }
    state.inputs.set(inputKey(reference), { reference, input: null, message, acceptedAt: event.stored.recordedAt, sequence: event.stored.sequence,
      lane: `peer:${message.sender}:${message.channelId}`, status: 'queued', claimedBy: null, reservedBy: null, everMatched: false, reason: null })
  } else if (event.stored.type === inboxProcessedEvent.type || event.stored.type === inboxAbandonedEvent.type) {
    const messageId = record(event.payload).messageId
    if (state.spec !== null && state.spec.payload.protocolVersion !== 1) {
      const inbox = [...state.sources.values()].find(item => item.stored.type === inboxAcceptedEvent.type
        && record(record(item.payload).envelope).messageId === messageId)
      if (inbox !== undefined && state.spec.payload.protocolVersion === 3 && String(record(record(inbox.payload).envelope).type).startsWith('workflow/')) {
        if (![...state.inputs.values()].some(input => input.work?.inbox === inbox.stored.eventId)
          && ![...state.sources.values()].some(item => item.stored.type === workProtocolClassifiedEvent.type && workProtocolClassifiedEvent.decode(item.payload).inbox === inbox.stored.eventId)
          && ![...state.sources.values()].some(item => [workAssignmentSettledEvent, workStopReceivedEvent, workAssignmentRejectedEvent, workStoppedMessageEvent].some(definition =>
            item.stored.type === definition.type && definition.decode(item.payload).inbox === inbox.stored.eventId))) invalidAgent('work-receipt-before-classification')
        return
      }
      if (inbox !== undefined && String(record(record(inbox.payload).envelope).type).startsWith('subagent/')) {
        if (![...state.subagents.classifications.values()].some(item => item.payload.inbox === inbox.stored.eventId)) invalidAgent('protocol-receipt-before-classification')
        return
      }
    }
    const input = [...state.inputs.values()].find(input => input.message?.messageId === messageId)
    if (input === undefined) invalidAgent('missing-confirmed-inbox')
    const expected = event.stored.type === inboxProcessedEvent.type ? 'handled' : 'abandoned'
    if (input.claimedBy !== null || input.reservedBy !== null) {
      if (input.status !== expected) invalidAgent('inbox-confirmation-before-agent-settlement')
    } else { input.status = expected; input.reason = 'communication-settled' }
  }
}

/** Replay local ownership only; ancestor history never becomes a queue or budget. */
export function foldAgentSession(snapshot: SessionSnapshot): AgentProjectionState {
  projectCommunicationFacts(snapshot); projectModelSession(snapshot); projectToolSession(snapshot)
  const state = initialAgentState()
  const local = snapshot.history.find(segment => segment.header.sessionId === snapshot.header.sessionId)
  if (local === undefined) invalidAgent('missing-local-segment')
  for (const event of local.events) {
    if (event.kind === 'opaque') {
      if (event.stored.type.startsWith('agent/') || event.stored.type.startsWith('subagent/')) invalidAgent('opaque-agent-event')
      continue
    }
    if (event.stored.type.startsWith('agent/')) {
      if (event.stored.type === 'agent/run-started' && projectWorkRecoveries(state.sources.values()).some(item => item.settled === null && item.supersededBy === null)) invalidAgent('work-recovery-open')
      const definition = events.agentSessionEventDefinitions.find(item => item.type === event.stored.type && item.payloadVersion === event.stored.payloadVersion)
      if (definition === undefined || !equal(definition.decode(event.payload), event.payload) || !equal(event.payload, event.stored.payload)) invalidAgent('noncanonical-agent-event')
      applyAgentEvent(state, event)
    }
    else if ([workRecoveryRequestedEvent.type, workRecoverySettledEvent.type].includes(event.stored.type)) applyWorkRecoveryEvent(state, event)
    else if (event.stored.type === workAssignmentAcceptedEvent.type) applyWorkAssignmentAccepted(state, event)
    else if (event.stored.type === workAssignmentSettledEvent.type) applyWorkAssignmentSettled(state, event)
    else if ([workStopReceivedEvent.type, workStopSettledEvent.type, workAssignmentRejectedEvent.type].includes(event.stored.type)) applyWorkStop(state, event)
    else if (event.stored.type === workStoppedMessageEvent.type) applyStoppedWorkMessage(state, event)
    else if (event.stored.type === workQuestionDeclinedEvent.type) applyWorkQuestionDeclined(state, event)
    else if (event.stored.type === workInputUnadoptedEvent.type) {
      if (event.stored.payloadVersion !== 1 || event.stored.ignorable) invalidAgent('work-input-version')
      applyWorkInputUnadopted(state, event)
    }
    else if (workGroupEventDefinitions.some(definition => definition.type === event.stored.type)) {
      if (event.stored.payloadVersion !== 1 || event.stored.ignorable) invalidAgent('work-group-version')
      if (event.stored.type === workGroupResultEvent.type) applyWorkGroupResult(state, event)
      else validateGroupActionEvent(state, event)
    }
    else if ([workQuestionRequestedEvent.type, workInteractionResolvedEvent.type, workProtocolClassifiedEvent.type].includes(event.stored.type)) {
      if (event.stored.payloadVersion !== 1 || event.stored.ignorable) invalidAgent('work-interaction-version')
      if (event.stored.type === workProtocolClassifiedEvent.type) applyWorkProtocolClassified(state, event)
      else validateWorkInteractionEvent(state, event)
    }
    else if (event.stored.type === workProtocolRecordedEvent.type) {
      validateWorkflowProtocol(state.sources, event)
      validateWorkActionProtocol(state, event)
    }
    else if (workResultEventDefinitions.some(definition => definition.type === event.stored.type)) {
      const definition = workResultEventDefinitions.find(definition => definition.type === event.stored.type)!
      if (event.stored.payloadVersion !== 1 || event.stored.ignorable === true || !equal(definition.decode(event.payload), event.payload)) invalidAgent('invalid-work-result')
      applyWorkResultEvent(state, event)
    }
    else if (event.stored.type.startsWith('subagent/')) applySubagentEvent(state, event)
    else if (event.stored.type.startsWith('communication/')) applyCommunicationInput(state, event)
    else if (isSessionEndedRecord(event.stored)) {
      if (state.openRun !== null || state.openTurn !== null || state.openRecovery !== null
        || !sessionDelegationsClosed(state, [...state.sources.values()])
        || [...state.roots.values()].some(root => root.outcome === null)
        || [...state.inputs.values()].some(input => !['handled', 'abandoned', 'not-adopted'].includes(input.status))
        || [...state.controls.values()].some(control => control.settled === null && control.supersededBy === null && control.requested.payload.kind !== 'close-session')) invalidAgent('ended-with-stranded-agent-work')
      state.closing = null
    }
    state.sources.set(event.stored.eventId, event)
  }
  return state
}

/** Freeze the public observation independently of the mutable, call-local replay accumulators. */
export function projectAgentSession(snapshot: SessionSnapshot): AgentSessionSnapshot {
  const state = foldAgentSession(snapshot)
  const frozen = <T extends object>(values: Iterable<T>) => Object.freeze([...values].map(value => Object.freeze({ ...value })))
  return Object.freeze({ spec: state.spec, subagents: Object.freeze({ baselines: frozen(state.subagents.baselines.values()), provisions: frozen(state.subagents.provisions.values()), failures: frozen(state.subagents.failures.values()),
    observations: frozen(state.subagents.observations.values()), controls: frozen(state.subagents.controls.values()), recoveries: frozen(state.subagents.recoveries.values()), delegations: frozen(state.subagents.delegations.values()),
    protocol: frozen(state.subagents.protocol.values()), classifications: frozen(state.subagents.classifications.values()),
    bound: state.subagents.bound, ready: state.subagents.ready, resources: frozen(state.subagents.resources.values()) }),
    runs: frozen(state.runs.values()), turns: frozen(state.turns.values()), steps: frozen(state.steps.values()),
    actions: frozen(state.actions.values()), waits: frozen(state.waits.values()), controls: frozen(state.controls.values()),
    commands: frozen(state.commands.values()), inputs: frozen(state.inputs.values()), roots: frozen(state.roots.values()),
    laneOrdinals: frozen([...state.lanes].map(([lane, ordinal]) => ({ lane, ordinal }))), openRun: state.openRun,
    openTurn: state.openTurn, openRecovery: state.openRecovery, closing: state.closing })
}
