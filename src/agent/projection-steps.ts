import { modelPreparedEvent, modelSettledEvent } from '../model/session-events.js'
import { toolRequestedEvent, toolSettledEvent } from '../tool/session-events.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { AgentActionIntent, AgentEventPayloads } from './event-contract.js'
import { actionBudget, emptyAgentBudget, reserveAgentBudget } from './budget.js'
import { workProtocolRecordedEvent } from '../workflow/protocol.js'
import { workQuestionRequestedEvent, workInteractionResolvedEvent } from '../workflow/interaction-events.js'
import { classifyAgentModel } from './decision.js'
import { invalidAgent } from './errors.js'
import { referenceKey } from './input-codec.js'
import type { AgentProjectionState } from './projection-state.js'
import { requireEntry, requireOpenRun, requireOpenTurn, requireSpec, source, stepClosed, turnSteps } from './projection-state.js'
import { equal, record } from './validation.js'
import { validateAgentActionSource } from './action-validation.js'

export function applyStepOpened(state: AgentProjectionState, event: CommittedSessionEvent<AgentEventPayloads['step-opened']>): void {
  const turn = requireOpenTurn(state, event.payload.turn)
  const root = requireEntry(state.roots, turn.root, 'missing-root')
  const spec = requireSpec(state).payload
  const steps = turnSteps(state, event.payload.turn)
  if (state.openRecovery !== null || root.outcome !== null || root.stopControl !== null || event.payload.observedAt >= root.deadline) invalidAgent('step-not-admissible')
  if (steps.some(step => !stepClosed(state, step)) || event.payload.ordinal !== steps.length + 1) invalidAgent('step-order')
  if (event.payload.outputTokens !== spec.target.maxOutputTokens) invalidAgent('output-reservation-mismatch')
  const budget = reserveAgentBudget(root.budget, { ...emptyAgentBudget, models: 1, steps: 1, outputTokens: event.payload.outputTokens }, root.limit)
  if (budget === null) invalidAgent('model-budget-exhausted')
  root.budget = budget
  state.steps.set(event.stored.eventId, { opened: event, decided: null })
}

export function applyStepDecided(state: AgentProjectionState, event: CommittedSessionEvent<AgentEventPayloads['step-decided']>): void {
  const p = event.payload
  const step = requireEntry(state.steps, p.step, 'missing-step')
  if (step.decided !== null) invalidAgent('duplicate-step-decision')
  const turn = requireOpenTurn(state, step.opened.payload.turn)
  const root = requireEntry(state.roots, turn.root, 'missing-root')
  const spec = requireSpec(state).payload
  if (p.reassemblies > spec.limits.maxReassemblies || p.admitted && p.actions.length > spec.limits.maxActionsPerStep) invalidAgent('step-limit')
  if (p.model === null) {
    if (!['not-issued', 'cancelled'].includes(p.classification) || p.actions.length !== 0 || p.admitted) invalidAgent('unissued-decision')
  } else {
    const cp2 = source(state, p.model.settled, modelSettledEvent)
    if (cp2.payload.invocationId !== p.model.invocationId || cp2.stored.sequence <= step.opened.stored.sequence) invalidAgent('model-source')
    const cp0raw = [...state.sources.values()].find(entry => entry.stored.type === modelPreparedEvent.type
      && record(entry.payload).invocationId === p.model!.invocationId)
    if (cp0raw === undefined) invalidAgent('missing-model-prepared')
    const cp0 = source(state, cp0raw.stored.eventId, modelPreparedEvent)
    const assembly = requireEntry(state.sources, p.model.assembly, 'missing-assembly')
    if (assembly.stored.type !== 'context/assembly-committed' || assembly.stored.payloadVersion !== (spec.protocolVersion + 1)
      || assembly.stored.sequence + 1 !== cp0.stored.sequence || assembly.stored.sequence <= step.opened.stored.sequence
      || !equal(record(assembly.payload).request, cp0.payload.submission.request)
      || !equal(record(record(record(assembly.payload).selection).target).provider, cp0.payload.submission.binding)
      || !equal(record(record(assembly.payload).consumer), { spec: requireSpec(state).stored.eventId, run: turn.started.payload.run,
        turn: turn.started.stored.eventId, step: p.step })) invalidAgent('model-assembly-source')
    const expected = classifyAgentModel(cp2.payload, spec, cp0.payload.submission.request.tools.map(tool => tool.name), { toolNames: root.allowedTools, nativeActions: root.allowedNativeActions })
    if (!equal(expected.actions, p.actions) || expected.classification !== p.classification || expected.reason !== p.reason) invalidAgent('model-decision-mismatch')
  }
  const amount = p.admitted ? actionBudget(p.actions.map(action => action.route)) : emptyAgentBudget
  if (!equal(amount, p.reservation) || p.admitted && (p.classification !== 'actions' || p.reason === 'invalid-control-batch'
    || root.stopControl !== null || root.outcome !== null || p.observedAt >= root.deadline)) invalidAgent('action-admission')
  const budget = reserveAgentBudget(root.budget, amount, root.limit)
  if (budget === null) invalidAgent('action-budget-exhausted')
  root.budget = budget; step.decided = event
}

function actionSource(state: AgentProjectionState, event: CommittedSessionEvent<AgentEventPayloads['action-settled']>) {
  const { action } = event.payload
  const command = state.commands.get(action.eventId)
  if (command !== undefined) {
    if (action.index !== 0) invalidAgent('command-index')
    requireOpenRun(state, command.payload.run, 'command')
    return { intent: null, turn: null, admitted: true }
  }
  const step = [...state.steps.values()].find(step => step.decided?.stored.eventId === action.eventId)
  const intent = step?.decided?.payload.actions[action.index]
  if (step === undefined || intent === undefined || step.decided === null) invalidAgent('missing-action-source')
  const turn = requireOpenTurn(state, step.opened.payload.turn)
  return { intent, turn, admitted: step.decided.payload.admitted }
}

function validateToolResult(state: AgentProjectionState, intent: AgentActionIntent | null, settled: AgentEventPayloads['turn-settled']['turn']): void {
  if (intent?.route !== 'tool') invalidAgent('tool-route-mismatch')
  const cp2 = source(state, settled, toolSettledEvent)
  const requested = [...state.sources.values()].find(entry => entry.stored.type === toolRequestedEvent.type
    && record(entry.payload).invocationId === cp2.payload.invocationId)
  if (requested === undefined) invalidAgent('missing-tool-request')
  const cp0 = source(state, requested.stored.eventId, toolRequestedEvent)
  if (cp0.payload.source.kind !== 'model' || !equal(cp0.payload.source.intent, intent.source)) invalidAgent('tool-intent-mismatch')
}

export function applyActionSettled(state: AgentProjectionState, event: CommittedSessionEvent<AgentEventPayloads['action-settled']>): void {
  const key = referenceKey(event.payload.action)
  if (state.actions.has(key)) invalidAgent('duplicate-action-result')
  const { intent, turn, admitted } = actionSource(state, event)
  const result = event.payload.result
  validateAgentActionSource(state, event, intent)
  if (!admitted && result.kind !== 'not-started') invalidAgent('unadmitted-action-executed')
  switch (result.kind) {
    case 'tool': validateToolResult(state, intent, result.settled); break
    case 'outbox': {
      if (intent !== null && !['send', 'reply'].includes(intent.route)) invalidAgent('outbox-route-mismatch')
      const accepted = requireEntry(state.sources, result.accepted, 'missing-outbox')
      if (accepted.stored.type !== 'communication/outbox-accepted' || accepted.stored.payloadVersion !== 2
        || !equal(record(accepted.payload).sendKey, event.payload.action)) invalidAgent('outbox-action-mismatch')
      break
    }
    case 'wait': {
      if (turn === null || intent === null || !['wait', 'ask', 'spawn', 'await-subagent', 'answer-subagent', 'ask-parent', 'work-ask', 'work-receive'].includes(intent.route)) invalidAgent('wait-route-mismatch')
      const descriptor = result.descriptor
      const root = requireEntry(state.roots, turn.root, 'missing-root')
      if (descriptor.root !== turn.root || descriptor.deadline > root.deadline
        || descriptor.kind === 'user' && intent.route !== 'ask' || descriptor.kind === 'reply' && intent.route !== 'wait') invalidAgent('wait-root-mismatch')
      if ([...state.waits.values()].filter(wait => wait.settled === null).length >= requireSpec(state).payload.limits.maxPendingWaits) invalidAgent('wait-capacity')
      if (descriptor.kind === 'reply') {
        const outgoing = requireEntry(state.sources, descriptor.outboxEventId, 'missing-watched-outbox')
        if (outgoing.stored.type !== 'communication/outbox-accepted' || record(record(outgoing.payload).envelope).messageId !== descriptor.messageId) invalidAgent('watched-outbox-mismatch')
        const own = [...state.actions.values()].find(action => action.payload.result.kind === 'outbox' && action.payload.result.accepted === descriptor.outboxEventId)
        const ownStep = own === undefined ? undefined : [...state.steps.values()].find(step => step.decided?.stored.eventId === own.payload.action.eventId)
        const ownTurn = ownStep === undefined ? undefined : state.turns.get(ownStep.opened.payload.turn)
        if (ownTurn?.root !== root.id) invalidAgent('wait-outbox-not-owned')
      }
      state.waits.set(key, { reference: event.payload.action, created: event, turn: turn.started.stored.eventId, settled: null })
      break
    }
    case 'not-started':
      if ([...state.sources.values()].some(entry => {
        if (entry.stored.type !== workInteractionResolvedEvent.type) return false
        const resolved = workInteractionResolvedEvent.decode(entry.payload)
        return resolved.outcome === 'admitted' && equal(workQuestionRequestedEvent.decode(state.sources.get(resolved.request)!.payload).action, event.payload.action)
      })) invalidAgent('not-started-has-work-admission')
      if ([...state.sources.values()].some(entry => {
        if (entry.stored.type !== workProtocolRecordedEvent.type) return false
        const source = workProtocolRecordedEvent.decode(entry.payload).source
        return typeof source !== 'string' && equal(source.action, event.payload.action)
      })) invalidAgent('not-started-has-work-intent')
      if ([...state.subagents.delegations.values()].some(item => item.payload.source.kind === 'model' && equal(item.payload.source.action, event.payload.action))
        || [...state.subagents.protocol.values()].some(item => item.payload.source.kind === 'action' && equal(item.payload.source.action, event.payload.action))) invalidAgent('not-started-has-delegation-intent')
      if (intent !== null && [...state.sources.values()].some(entry => entry.stored.type === toolRequestedEvent.type
        && record(record(entry.payload).source).kind === 'model'
        && equal(record(record(entry.payload).source).intent, intent.source))) invalidAgent('not-started-has-tool-request')
      break
    case 'protocol-accepted': break
    case 'communication-not-accepted':
      if (intent !== null && !['send', 'reply'].includes(intent.route)) invalidAgent('communication-result-route')
      break
  }
  if ((result.kind === 'not-started' || result.kind === 'communication-not-accepted') && [...state.sources.values()].some(entry =>
    entry.stored.type === 'communication/outbox-accepted' && entry.stored.payloadVersion === 2 && equal(record(entry.payload).sendKey, event.payload.action))) invalidAgent('not-accepted-has-outbox')
  state.actions.set(key, event)
}
