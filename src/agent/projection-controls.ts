import type { CommittedSessionEvent } from '../session/types.js'
import type { AgentEventPayloads } from './event-contract.js'
import type { AgentInputState, AgentWaitState } from './state.js'
import { invalidAgent } from './errors.js'
import { inputKey, referenceKey } from './input-codec.js'
import type { AgentProjectionState } from './projection-state.js'
import { requireEntry, requireSpec } from './projection-state.js'
import { equal, record } from './validation.js'

export function matchesAgentWait(wait: AgentWaitState, input: AgentInputState, state: Pick<AgentProjectionState, 'sources'>): boolean {
  const result = wait.created.payload.result
  if (result.kind !== 'wait' || input.status !== 'queued' || input.everMatched || input.acceptedAt > result.descriptor.deadline) return false
  const descriptor = result.descriptor
  if (descriptor.kind === 'user') return input.input?.kind === 'answer' && equal(input.input.wait, wait.reference)
  const envelope = input.message
  if (envelope === null) return false
  const outgoing = state.sources.get(descriptor.outboxEventId)
  if (outgoing === undefined) return false
  const watched = record(record(outgoing.payload).envelope)
  return envelope.recipient === watched.sender && envelope.sender === watched.recipient
    && envelope.channelId === watched.channelId && envelope.correlationId === watched.correlationId
    && envelope.replyTo === descriptor.messageId
}

export function applyWaitSettled(state: AgentProjectionState, event: CommittedSessionEvent<AgentEventPayloads['wait-settled']>): void {
  const p = event.payload
  const wait = requireEntry(state.waits, referenceKey(p.wait), 'missing-wait')
  if (wait.settled !== null || wait.created.payload.result.kind !== 'wait') invalidAgent('duplicate-wait-terminal')
  const turn = requireEntry(state.turns, wait.turn, 'missing-wait-turn')
  if (turn.settled?.payload.outcome !== 'waiting') invalidAgent('wait-before-checkpoint')
  const descriptor = wait.created.payload.result.descriptor
  const root = requireEntry(state.roots, descriptor.root, 'missing-root')
  if (root.outcome !== null) invalidAgent('wait-root-terminal')
  if (new Set(p.supportedMessages.map(item => `${item.type}@${item.payloadVersion}`)).size !== p.supportedMessages.length
    || p.supportedMessages.some(item => !requireSpec(state).payload.messages.some(kind => kind.type === item.type && kind.payloadVersion === item.payloadVersion))) invalidAgent('wait-support-observation')
  const eligible = [...state.inputs.values()].filter(input => matchesAgentWait(wait, input, state) && (input.message === null
    || p.supportedMessages.some(kind => kind.type === input.message!.type && kind.payloadVersion === input.message!.payloadVersion)))
  if (p.outcome !== 'unavailable' && p.outboxTerminal !== null) invalidAgent('unexpected-outbox-terminal')
  if (p.outcome === 'matched') {
    if (p.response === null || root.stopControl !== null) invalidAgent('match-stopped')
    const input = requireEntry(state.inputs, inputKey(p.response), 'missing-response')
    if (!matchesAgentWait(wait, input, state) || eligible[0] !== input) invalidAgent('response-mismatch')
    input.status = 'reserved'; input.reservedBy = p.wait; input.everMatched = true
  } else {
    if (p.response !== null) invalidAgent('nonmatched-response')
    if (p.outcome === 'timed-out' && p.observedAt < descriptor.deadline) invalidAgent('premature-timeout')
    if ((p.outcome === 'timed-out' || p.outcome === 'unavailable') && eligible.length > 0) invalidAgent('response-before-wait-failure')
    if (p.outcome === 'unavailable') {
      if (descriptor.kind !== 'reply' || p.outboxTerminal === null) invalidAgent('missing-outbox-terminal')
      const terminal = requireEntry(state.sources, p.outboxTerminal, 'missing-outbox-terminal')
      if (!['communication/outbox-rejected', 'communication/outbox-abandoned'].includes(terminal.stored.type)
        || record(terminal.payload).messageId !== descriptor.messageId) invalidAgent('outbox-terminal-source')
    }
    if (p.outcome === 'cancelled' && root.stopControl === null) invalidAgent('missing-cancel-control')
    if (root.stopControl === null) {
      root.outcome = p.outcome === 'timed-out' ? 'timed-out' : 'failed'; root.reason = p.reason
    }
  }
  wait.settled = event
  for (const input of state.inputs.values()) {
    if (input.status === 'queued' && input.input?.kind === 'answer' && equal(input.input.wait, p.wait)) {
      input.status = 'not-adopted'
      input.reason = input.acceptedAt > descriptor.deadline ? 'answer-after-deadline' : p.outcome === 'matched' ? 'answer-not-selected' : `wait-${p.outcome}`
    }
  }
}

export function applyControlRequested(state: AgentProjectionState, event: CommittedSessionEvent<AgentEventPayloads['control-requested']>): void {
  const p = event.payload
  requireSpec(state)
  if (state.openRecovery !== null && p.kind !== 'recovery') invalidAgent('recovery-owns-session')
  switch (p.kind) {
    case 'cancel-work': case 'expire-work': {
      const root = requireEntry(state.roots, p.root, 'missing-root')
      if (root.outcome !== null || root.stopControl !== null) invalidAgent('root-stop-already-decided')
      if (p.kind === 'expire-work' && p.deadline !== root.deadline) invalidAgent('expiry-deadline-mismatch')
      root.stopControl = event.stored.eventId
      break
    }
    case 'abandon-input': {
      const input = requireEntry(state.inputs, inputKey(p.input), 'missing-abandoned-input')
      if (!['queued', 'review-required'].includes(input.status)) invalidAgent('input-not-abandonable')
      if ([...state.controls.values()].some(control => control.settled === null && control.requested.payload.kind === 'abandon-input'
        && equal(control.requested.payload.input, p.input))) invalidAgent('input-abandon-already-owned')
      break
    }
    case 'close-session':
      if (state.closing !== null) invalidAgent('close-already-owned')
      state.closing = event.stored.eventId
      break
    case 'recovery': {
      if (p.through !== event.stored.sequence - 1) invalidAgent('recovery-cut-mismatch')
      if (state.openRecovery !== p.supersedes) invalidAgent('recovery-predecessor-mismatch')
      if (p.targetRun !== null) requireEntry(state.runs, p.targetRun, 'missing-recovery-run')
      p.controls.forEach(id => requireEntry(state.controls, id, 'missing-recovery-control'))
      if (p.targetRun === null && p.controls.length === 0 && p.supersedes === null) invalidAgent('empty-recovery')
      if (p.targetRun !== state.openRun && state.openRun !== null) invalidAgent('recovery-omits-open-run')
      if (p.supersedes !== null) {
        const previous = requireEntry(state.controls, p.supersedes, 'missing-recovery-predecessor')
        if (previous.requested.payload.kind !== 'recovery' || previous.settled !== null || previous.supersededBy !== null) invalidAgent('recovery-predecessor-terminal')
        previous.supersededBy = event.stored.eventId
      }
      state.openRecovery = event.stored.eventId
      break
    }
  }
  state.controls.set(event.stored.eventId, { requested: event, settled: null, supersededBy: null })
}

export function applyControlSettled(state: AgentProjectionState, event: CommittedSessionEvent<AgentEventPayloads['control-settled']>): void {
  const p = event.payload
  const control = requireEntry(state.controls, p.control, 'missing-control')
  if (control.settled !== null || control.supersededBy !== null) invalidAgent('control-already-terminal')
  const request = control.requested.payload
  switch (request.kind) {
    case 'cancel-work': case 'expire-work': {
      const root = requireEntry(state.roots, request.root, 'missing-root')
      if ([...state.turns.values()].some(turn => turn.root === root.id && turn.settled === null)) invalidAgent('stop-has-open-turn')
      if ([...state.waits.values()].some(wait => wait.created.payload.result.kind === 'wait'
        && wait.created.payload.result.descriptor.root === root.id && wait.settled === null)) invalidAgent('stop-has-pending-wait')
      const expected = request.kind === 'expire-work' ? 'timed-out' : 'cancelled'
      if (p.rootOutcome !== expected && p.rootOutcome !== 'result-unknown' || p.outcome !== 'completed') invalidAgent('stop-outcome')
      if (root.outcome !== null && root.outcome !== p.rootOutcome) invalidAgent('root-terminal-overwrite')
      const reserved = [...state.inputs.values()].filter(input => {
        if (input.status !== 'reserved' || input.reservedBy === null) return false
        const result = state.waits.get(referenceKey(input.reservedBy))?.created.payload.result
        return result?.kind === 'wait' && result.descriptor.root === root.id
      })
      if (reserved.length > 1) invalidAgent('multiple-root-responses')
      const response = reserved[0]
      const disposition = response === undefined ? null : response.message === null ? 'not-adopted' : 'release-peer'
      if (p.responseDisposition !== disposition) invalidAgent('stop-response-disposition')
      if (response !== undefined) {
        response.status = disposition === 'release-peer' ? 'queued' : 'not-adopted'
        response.reservedBy = null; response.reason = 'root-stopped-before-resume'
      }
      root.outcome = p.rootOutcome; root.reason ??= request.reason
      break
    }
    case 'abandon-input': {
      if (p.outcome !== 'completed') invalidAgent('abandon-outcome')
      const input = requireEntry(state.inputs, inputKey(request.input), 'missing-input')
      if (!['queued', 'review-required'].includes(input.status)) invalidAgent('abandon-raced-with-claim')
      input.status = 'abandoned'; input.reason = request.reason
      break
    }
    case 'close-session':
      if (!['rejected', 'no-op'].includes(p.outcome)) invalidAgent('close-success-requires-session-ended')
      state.closing = null; break
    case 'recovery':
      if (state.openRecovery !== p.control || !['recovered', 'recovery-incomplete'].includes(p.outcome)) invalidAgent('recovery-settlement')
      if (p.outcome === 'recovered' && (state.openRun !== null || [...state.controls.values()].some(other =>
        other.requested.stored.eventId !== p.control && other.settled === null && other.supersededBy === null))) invalidAgent('recovery-still-open')
      state.openRecovery = null; break
  }
  if (request.kind !== 'cancel-work' && request.kind !== 'expire-work' && (p.rootOutcome !== null || p.responseDisposition !== null)) invalidAgent('unexpected-control-root')
  control.settled = event
}
