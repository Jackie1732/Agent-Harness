import { hasPendingAgentAbandon } from './input-ownership.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { AgentEventPayloads } from './event-contract.js'
import type { AgentMaintenanceRunSettled, AgentMaintenanceRunStarted } from './event-contract.js'
import { emptyAgentBudget } from './budget.js'
import { invalidAgent } from './errors.js'
import { inputKey, referenceKey } from './input-codec.js'
import type { AgentProjectionState } from './projection-state.js'
import { requireEntry, requireOpenRun, requireOpenTurn, requireSpec, stepClosed, turnSteps } from './projection-state.js'
import { equal, record } from './validation.js'
import { requiresAgentReply, rootPeerInputs } from './obligations.js'

export function applyRunStarted(state: AgentProjectionState, event: CommittedSessionEvent<AgentEventPayloads['run-started']>): void {
  if (state.openRun !== null || state.openRecovery !== null || state.closing !== null
    || [...state.controls.values()].some(control => control.settled === null && control.supersededBy === null)) invalidAgent('driver-already-owned')
  if (event.payload.spec !== requireSpec(state).stored.eventId) invalidAgent('run-spec-mismatch')
  state.runs.set(event.stored.eventId, { started: event, settled: null }); state.openRun = event.stored.eventId
}
export function applyRunSettled(state: AgentProjectionState, event: CommittedSessionEvent<AgentEventPayloads['run-settled']>): void {
  const run = requireOpenRun(state, event.payload.run)
  if (state.openTurn !== null) invalidAgent('run-has-open-turn')
  const commands = [...state.commands.values()].filter(command => command.payload.run === event.payload.run)
  if (commands.some(command => !state.actions.has(referenceKey({ eventId: command.stored.eventId, index: 0 })))) invalidAgent('run-has-open-command')
  const commandStop = ['command-settled', 'command-budget'].includes(event.payload.stoppedBy)
  if (run.started.payload.kind === 'drive' && commandStop || run.started.payload.kind === 'command'
    && !commandStop && !['faulted', 'interrupted', 'cancelled'].includes(event.payload.stoppedBy)) invalidAgent('run-stop-kind')
  run.settled = event; state.openRun = null
}
export function applyMaintenanceRunStarted(
  state: AgentProjectionState,
  event: CommittedSessionEvent<AgentMaintenanceRunStarted>,
): void {
  const pending = [...state.controls.values()].filter(control => control.settled === null && control.supersededBy === null)
  if (state.openRun !== null || state.openTurn !== null || state.openRecovery !== null || state.closing !== null
    || pending.some(control => !['cancel-work', 'expire-work'].includes(control.requested.payload.kind))) invalidAgent('maintenance-not-admissible')
  if (event.payload.spec !== requireSpec(state).stored.eventId) invalidAgent('run-spec-mismatch')
  state.runs.set(event.stored.eventId, { started: event, settled: null }); state.openRun = event.stored.eventId
}
export function applyMaintenanceRunSettled(
  state: AgentProjectionState,
  event: CommittedSessionEvent<AgentMaintenanceRunSettled>,
): void {
  const run = requireOpenRun(state, event.payload.run, 'maintenance')
  if (state.openTurn !== null || [...state.commands.values()].some(command => command.payload.run === event.payload.run)) {
    invalidAgent('maintenance-has-business-work')
  }
  run.settled = event; state.openRun = null
}
export function applyTurnStarted(state: AgentProjectionState, event: CommittedSessionEvent<AgentEventPayloads['turn-started']>): void {
  const payload = event.payload
  requireOpenRun(state, payload.run, 'drive')
  if (state.openTurn !== null || state.openRecovery !== null || state.closing !== null) invalidAgent('turn-not-admissible')
  const spec = requireSpec(state).payload
  const input = requireEntry(state.inputs, inputKey(payload.input), 'missing-turn-input')
  if (hasPendingAgentAbandon(state.controls.values(), input, 2)) invalidAgent('input-disposition-owned')
  if (input.lane !== payload.lane || payload.ordinal !== state.turns.size + 1) invalidAgent('turn-order')
  if ([...state.turns.values()].filter(turn => turn.started.payload.run === payload.run).length >= spec.limits.maxTurnsPerRun) invalidAgent('run-turn-budget')
  if (payload.root === null) {
    if (payload.predecessor !== null || input.status !== 'queued' || input.input?.kind === 'answer') invalidAgent('root-input-not-queued')
    if (payload.deadline !== null) invalidAgent('root-deadline-must-derive-from-acceptance')
    const deadline = new Date(Date.parse(event.stored.recordedAt) + spec.rootDurationMs).toISOString()
    state.roots.set(event.stored.eventId, { id: event.stored.eventId, deadline, budget: emptyAgentBudget,
      outcome: null, reason: null, stopControl: null })
  } else {
    const root = requireEntry(state.roots, payload.root, 'missing-root')
    if (root.outcome !== null || root.stopControl !== null || root.deadline !== payload.deadline || payload.observedAt >= root.deadline) invalidAgent('root-not-runnable')
    if (payload.predecessor === null || input.status !== 'reserved' || !equal(input.reservedBy, payload.predecessor)) invalidAgent('continuation-not-reserved')
    const wait = requireEntry(state.waits, referenceKey(payload.predecessor), 'missing-wait')
    if (wait.settled?.payload.outcome !== 'matched' || !equal(wait.settled.payload.response, payload.input)
      || wait.created.payload.result.kind !== 'wait' || wait.created.payload.result.descriptor.root !== payload.root) invalidAgent('continuation-source')
  }
  input.status = 'claimed'; input.claimedBy = event.stored.eventId; input.reservedBy = null
  state.turns.set(event.stored.eventId, { started: event, root: payload.root ?? event.stored.eventId, settled: null })
  state.openTurn = event.stored.eventId; state.lanes.set(payload.lane, payload.ordinal)
}
export function applyTurnSettled(state: AgentProjectionState, event: CommittedSessionEvent<AgentEventPayloads['turn-settled']>): void {
  const p = event.payload
  const turn = requireOpenTurn(state, p.turn)
  const root = requireEntry(state.roots, turn.root, 'missing-root')
  const steps = turnSteps(state, p.turn)
  if (steps.some(step => !stepClosed(state, step)) || !equal(root.budget, p.budget)) invalidAgent('turn-open-actions-or-budget')
  const waits = [...state.waits.values()].filter(wait => wait.turn === p.turn)
  if (p.outcome === 'waiting') {
    if (waits.length !== 1 || waits[0]!.settled !== null || p.rootOutcome !== null || p.disposition !== 'handled') invalidAgent('waiting-checkpoint')
  } else {
    if (waits.some(wait => wait.settled === null) || p.rootOutcome === null) invalidAgent('turn-terminal-obligations')
    if (root.outcome !== null) invalidAgent('duplicate-root-terminal')
    if (p.outcome === 'completed' && (root.stopControl !== null || p.rootOutcome !== 'completed' || p.disposition !== 'handled')) invalidAgent('completion-stopped')
    if (p.outcome !== 'completed' && p.disposition !== 'review-required'
      && !(p.outcome === 'failed' && p.reason === 'business-refusal' && requireSpec(state).payload.businessRefusalHandled && p.disposition === 'handled')) invalidAgent('terminal-input-disposition')
    if (p.reason === 'business-refusal' && steps.at(-1)?.decided?.payload.reason !== 'business-refusal') invalidAgent('refusal-source')
    if (p.outcome === 'completed') {
      const final = steps.at(-1)?.decided
      if (final?.payload.classification !== 'final' || p.finalStep !== final.payload.step) invalidAgent('final-source')
      for (const input of rootPeerInputs(turn.root, [...state.turns.values()], [...state.inputs.values()])) {
        if (!requiresAgentReply(requireSpec(state).payload, input)) continue
        const replied = [...state.actions.values()].some(action => {
          const result = action.payload.result
          if (result.kind !== 'outbox') return false
          const step = [...state.steps.values()].find(step => step.decided?.stored.eventId === action.payload.action.eventId)
          if (step === undefined || state.turns.get(step.opened.payload.turn)?.root !== turn.root) return false
          return record(record(requireEntry(state.sources, result.accepted, 'reply-outbox-source').payload).envelope).replyTo === input.message!.messageId
        })
        if (!replied) invalidAgent('reply-obligation-unsatisfied')
      }
    } else if (p.finalStep !== null) invalidAgent('nonfinal-text-source')
    root.outcome = p.rootOutcome; root.reason = p.reason
  }
  const input = requireEntry(state.inputs, inputKey(turn.started.payload.input), 'missing-input')
  input.status = p.disposition; input.reason = p.reason
  turn.settled = event; state.openTurn = null
}
