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
import { applyRunSettled, applyRunStarted, applyTurnSettled, applyTurnStarted } from './projection-runs.js'
import { applyActionSettled, applyStepDecided, applyStepOpened } from './projection-steps.js'
import type { AgentProjectionState } from './projection-state.js'
import { initialAgentState, requireEntry, requireOpenRun, requireSpec } from './projection-state.js'
import * as events from './session-events.js'
import type { AgentSessionSnapshot } from './state.js'
import { equal, record } from './validation.js'

function applyInput(state: AgentProjectionState, event: CommittedSessionEvent): void {
  const p = events.agentInputAcceptedEvent.decode(event.payload)
  const spec = requireSpec(state)
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
  if (event.stored.payloadVersion !== 1 && !(event.stored.payloadVersion === 2 && ['agent/control-requested', 'agent/control-settled'].includes(event.stored.type)) || event.stored.ignorable === true) invalidAgent('unsupported-agent-event')
  const decoded = <T,>(decode: (value: JsonValue) => T) => ({ ...event, payload: decode(event.payload) })
  switch (event.stored.type) {
    case 'agent/spec-recorded': {
      if (state.spec !== null) invalidAgent('spec-already-installed')
      const spec = events.agentSpecRecordedEvent.decode(event.payload)
      const profile = requireEntry(state.sources, spec.profileEventId, 'missing-spec-profile')
      if (profile.stored.type !== 'context/profile-recorded' || profile.stored.payloadVersion !== 2
        || record(profile.payload).purpose !== 'generation' || !equal(record(profile.payload).toolNames, spec.toolNames)) invalidAgent('spec-profile-mismatch')
      state.spec = { ...event, payload: spec }; break
    }
    case 'agent/input-accepted': applyInput(state, event); break
    case 'agent/run-started': applyRunStarted(state, decoded(events.agentRunStartedEvent.decode)); break
    case 'agent/run-settled': applyRunSettled(state, decoded(events.agentRunSettledEvent.decode)); break
    case 'agent/turn-started': applyTurnStarted(state, decoded(events.agentTurnStartedEvent.decode)); break
    case 'agent/turn-settled': applyTurnSettled(state, decoded(events.agentTurnSettledEvent.decode)); break
    case 'agent/step-opened': applyStepOpened(state, decoded(events.agentStepOpenedEvent.decode)); break
    case 'agent/step-decided': applyStepDecided(state, decoded(events.agentStepDecidedEvent.decode)); break
    case 'agent/action-settled': applyActionSettled(state, decoded(events.agentActionSettledEvent.decode)); break
    case 'agent/wait-settled': applyWaitSettled(state, decoded(events.agentWaitSettledEvent.decode)); break
    case 'agent/control-requested': applyControlRequested(state, decoded(events.agentControlRequestedEvent.decode)); break
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
    const reference = { kind: 'peer' as const, eventId: event.stored.eventId }
    state.inputs.set(inputKey(reference), { reference, input: null, message, acceptedAt: event.stored.recordedAt, sequence: event.stored.sequence,
      lane: `peer:${message.sender}:${message.channelId}`, status: 'queued', claimedBy: null, reservedBy: null, everMatched: false, reason: null })
  } else if (event.stored.type === inboxProcessedEvent.type || event.stored.type === inboxAbandonedEvent.type) {
    const messageId = record(event.payload).messageId
    const input = [...state.inputs.values()].find(input => input.message?.messageId === messageId)
    if (input === undefined) invalidAgent('missing-confirmed-inbox')
    const expected = event.stored.type === inboxProcessedEvent.type ? 'handled' : 'abandoned'
    if (input.claimedBy !== null || input.reservedBy !== null) {
      if (input.status !== expected) invalidAgent('inbox-confirmation-before-agent-settlement')
    } else { input.status = expected; input.reason = 'communication-settled' }
  }
}

/** Replay local ownership only; ancestor history never becomes a queue or budget. */
export function projectAgentSession(snapshot: SessionSnapshot): AgentSessionSnapshot {
  projectCommunicationFacts(snapshot); projectModelSession(snapshot); projectToolSession(snapshot)
  const state = initialAgentState()
  const local = snapshot.history.find(segment => segment.header.sessionId === snapshot.header.sessionId)
  if (local === undefined) invalidAgent('missing-local-segment')
  for (const event of local.events) {
    if (event.kind === 'opaque') {
      if (event.stored.type.startsWith('agent/')) invalidAgent('opaque-agent-event')
      continue
    }
    if (event.stored.type.startsWith('agent/')) {
      const definition = events.agentSessionEventDefinitions.find(item => item.type === event.stored.type && item.payloadVersion === event.stored.payloadVersion)
      if (definition === undefined || !equal(definition.decode(event.payload), event.payload) || !equal(event.payload, event.stored.payload)) invalidAgent('noncanonical-agent-event')
      applyAgentEvent(state, event)
    }
    else if (event.stored.type.startsWith('communication/')) applyCommunicationInput(state, event)
    else if (isSessionEndedRecord(event.stored)) {
      if (state.openRun !== null || state.openTurn !== null || state.openRecovery !== null
        || [...state.roots.values()].some(root => root.outcome === null)
        || [...state.inputs.values()].some(input => !['handled', 'abandoned', 'not-adopted'].includes(input.status))
        || [...state.controls.values()].some(control => control.settled === null && control.supersededBy === null && control.requested.payload.kind !== 'close-session')) invalidAgent('ended-with-stranded-agent-work')
      state.closing = null
    }
    state.sources.set(event.stored.eventId, event)
  }
  const frozen = <T extends object>(values: Iterable<T>) => Object.freeze([...values].map(value => Object.freeze({ ...value })))
  return Object.freeze({ spec: state.spec, runs: frozen(state.runs.values()), turns: frozen(state.turns.values()), steps: frozen(state.steps.values()),
    actions: frozen(state.actions.values()), waits: frozen(state.waits.values()), controls: frozen(state.controls.values()),
    commands: frozen(state.commands.values()), inputs: frozen(state.inputs.values()), roots: frozen(state.roots.values()),
    laneOrdinals: frozen([...state.lanes].map(([lane, ordinal]) => ({ lane, ordinal }))), openRun: state.openRun,
    openTurn: state.openTurn, openRecovery: state.openRecovery, closing: state.closing })
}
