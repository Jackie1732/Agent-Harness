import { sameWorkflowValue } from '../workflow/work-binding.js'
import { workAcceptanceForRoot } from '../workflow/work-projection.js'
import { delegationClosure } from '../subagent/closure.js'
import { hasPendingAgentAbandon } from './input-ownership.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { AgentEventPayloads } from './event-contract.js'
import type { AgentMaintenanceRunSettled, AgentMaintenanceRunStarted } from './event-contract.js'
import { emptyAgentBudget, reserveAgentBudget } from './budget.js'
import { invalidAgent } from './errors.js'
import { inputKey, referenceKey } from './input-codec.js'
import type { AgentProjectionState } from './projection-state.js'
import { requireEntry, requireOpenRun, requireOpenTurn, requireSpec, stepClosed, turnSteps } from './projection-state.js'
import { equal, record } from './validation.js'
import { requiresAgentReply, rootPeerInputs } from './obligations.js'

export function applyRunStarted(state: AgentProjectionState, event: CommittedSessionEvent<AgentEventPayloads['run-started']>): void {
  if (event.stored.payloadVersion !== (requireSpec(state).payload.protocolVersion === 3 ? 3 : 1)) invalidAgent('run-spec-version')
  if (state.openRun !== null || state.openRecovery !== null || state.closing !== null
    || [...state.controls.values()].some(control => control.settled === null && control.supersededBy === null)) invalidAgent('driver-already-owned')
  if (event.payload.spec !== requireSpec(state).stored.eventId) invalidAgent('run-spec-mismatch')
  state.runs.set(event.stored.eventId, { started: event, settled: null }); state.openRun = event.stored.eventId
}
export function applyRunSettled(state: AgentProjectionState, event: CommittedSessionEvent<AgentEventPayloads['run-settled']>): void {
  const run = requireOpenRun(state, event.payload.run)
  if (run.started.stored.payloadVersion !== event.stored.payloadVersion) invalidAgent('run-version-mismatch')
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
  if (run.started.stored.payloadVersion !== 2) invalidAgent('run-version-mismatch')
  if (state.openTurn !== null || [...state.commands.values()].some(command => command.payload.run === event.payload.run)) {
    invalidAgent('maintenance-has-business-work')
  }
  run.settled = event; state.openRun = null
}
export function applyTurnStarted(state: AgentProjectionState, event: CommittedSessionEvent<AgentEventPayloads['turn-started']>): void {
  const payload = event.payload
  const run = requireOpenRun(state, payload.run, 'drive')
  if (state.openTurn !== null || state.openRecovery !== null || state.closing !== null) invalidAgent('turn-not-admissible')
  const spec = requireSpec(state).payload
  const input = requireEntry(state.inputs, inputKey(payload.input), 'missing-turn-input')
  if (spec.protocolVersion !== 1 && payload.protocolSource !== (input.protocol?.inbox ?? input.work?.inbox ?? input.workMessage?.inbox ?? null)) invalidAgent('turn-protocol-source')
  const inherited = payload.root === null ? input : workAcceptanceForRoot(state, payload.root)
  const work = inherited.work
  if (spec.protocolVersion === 3) {
    if (work === undefined && ([...state.roots.values()].some(root => root.source.kind === 'workflow' && root.outcome === null)
      || [...state.inputs.values()].some(item => item.work !== undefined && item.status === 'queued'))) invalidAgent('ordinary-turn-during-work')
    const selection = run.started.payload.kind === 'maintenance' ? undefined : run.started.payload.selection
    if (work === undefined ? selection?.kind !== 'ordinary' || payload.work !== null
      : selection?.kind !== 'workflow' || !sameWorkflowValue(selection.assignment, work.assignment)
        || !sameWorkflowValue(payload.work, { accepted: inherited.reference.eventId, assignment: work.assignment, allowance: work.value.effectiveAllowance,
          toolNames: work.value.toolNames, nativeActions: work.value.nativeActions })) invalidAgent('turn-work-selection')
  }
  if (hasPendingAgentAbandon(state.controls.values(), input, 2)) invalidAgent('input-disposition-owned')
  if (input.lane !== payload.lane || payload.ordinal !== state.turns.size + 1) invalidAgent('turn-order')
  if ([...state.turns.values()].filter(turn => turn.started.payload.run === payload.run).length >= (spec.protocolVersion === 3 ? 1 : spec.limits.maxTurnsPerRun)) invalidAgent('run-turn-budget')
  if (payload.root === null) {
    if (payload.predecessor !== null || input.status !== 'queued' || input.input?.kind === 'answer' || input.workMessage !== undefined) invalidAgent('root-input-not-queued')
    const child = spec.protocolVersion !== 1 && spec.subagents.role === 'child' ? spec.subagents : undefined
    if (child === undefined && work === undefined && (payload.deadline !== null || input.protocol !== undefined)) invalidAgent('root-deadline-must-derive-from-acceptance')
    if (child !== undefined && state.subagents.bound?.payload.requested.effectivePlan.workspace.kind !== 'none') {
      const execution = [...state.subagents.resources.values()].filter(item => item.opened.payload.component === 'execution').at(-1)
      if (execution === undefined || execution.released !== null || !state.subagents.baselines.has(execution.opened.stored.eventId)) invalidAgent('child-workspace-not-ready')
    }
    if (child !== undefined && (input.protocol?.kind !== 'task' || state.subagents.ready === null || state.subagents.controls.size > 0 || state.roots.size !== 0
      || payload.deadline !== child.deadline || payload.observedAt >= child.deadline)) invalidAgent('child-root-claim')
    const limit = work?.value.effectiveAllowance ?? spec.budget
    const deadline = child?.deadline ?? new Date(Math.min(Date.parse(event.stored.recordedAt) + spec.rootDurationMs,
      work === undefined ? Infinity : Date.parse(work.value.deadline))).toISOString()
    if (work !== undefined && (payload.deadline !== work.value.deadline || payload.observedAt >= deadline
      || [...state.roots.values()].some(root => root.source.kind === 'workflow' && sameWorkflowValue(root.source.assignment, work.assignment)))) invalidAgent('work-root-claim')
    const budget = child === undefined ? emptyAgentBudget : reserveAgentBudget(emptyAgentBudget, child.protocolReserve, spec.budget)
    if (budget === null) invalidAgent('child-protocol-budget')
    state.roots.set(event.stored.eventId, { id: event.stored.eventId, deadline, budget, limit, allowedTools: work?.value.toolNames ?? spec.toolNames,
      allowedNativeActions: (work?.value.nativeActions ?? spec.nativeActions) as import('./state.js').AgentRootState['allowedNativeActions'],
      source: work === undefined ? { kind: 'ordinary' } : { kind: 'workflow', assignment: work.assignment },
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
      if ([...state.subagents.delegations.values()].filter(item => item.payload.parentRoot === root.id).some(item => {
        const closure = delegationClosure(state, item.stored.eventId, state.sources.values())
        return !closure.businessResolved || !closure.executionReleased || !closure.adopted
      })) invalidAgent('unresolved-delegation')
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
