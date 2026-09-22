import { delegationClosure } from '../subagent/closure.js'
import { agentRootUsageUnknown, expireAgentRoot } from './root-policy.js'
import type { SessionEventId } from '../session/ids.js'
import { clockTimestamp } from '../foundation/clock.js'
import { ContextError } from '../context/errors.js'
import { ModelError } from '../model/errors.js'
import { projectModelSession } from '../model/projection.js'
import { projectToolSession } from '../tool/projection.js'
import { actionBudget, emptyAgentBudget, reserveAgentBudget } from './budget.js'
import { classifyAgentModel } from './decision.js'
import { executeAgentAction } from './action-driver.js'
import { projectAgentSession } from './projection.js'
import { settleAgentStops, synchronizeAgentReceipts } from './management.js'
import type { AgentRuntime } from './runtime-contract.js'
import type { AgentRootOutcome, AgentTurnOutcome } from './contract.js'
import type { AgentStepDecided, AgentActionResult } from './event-contract.js'
import * as events from './session-events.js'
import { hasUnfulfilledAgentReply } from './obligations.js'
import { projectCommunicationFacts } from '../communication/projection.js'

/** One accepted Turn owns its serial model/action transitions until a durable checkpoint. */
export async function driveAgentTurn(runtime: AgentRuntime, turnId: SessionEventId, signal: AbortSignal): Promise<void> {
  const view = () => projectAgentSession(runtime.session.snapshot())
  const initial = view()
  const spec = initial.spec!
  const turn = initial.turns.find(item => item.started.stored.eventId === turnId)!
  const rootView = () => view().roots.find(item => item.id === turn.root)!
  const finish = async (outcome: AgentTurnOutcome, reason: string, rootOutcome: AgentRootOutcome | null, finalStep: SessionEventId | null = null) => {
    await expireAgentRoot(runtime, turn.root)
    await runtime.journal.append(runtime.events.turnSettled, state => {
      const root = state.roots.find(item => item.id === turn.root)!
      if (root.stopControl !== null && outcome !== 'waiting' && outcome !== 'result-unknown') {
        outcome = 'cancelled'; reason = 'root-stopped'; finalStep = null
        rootOutcome = state.controls.find(item => item.requested.stored.eventId === root.stopControl)?.requested.payload.kind === 'expire-work' ? 'timed-out' : 'cancelled'
      }
      return { turn: turnId, outcome, rootOutcome, reason,
      disposition: outcome === 'completed' || outcome === 'waiting' || outcome === 'failed' && reason === 'business-refusal' && spec.payload.businessRefusalHandled
        ? 'handled' as const : 'review-required' as const, finalStep,
      budget: root.budget }
    })
    await synchronizeAgentReceipts(runtime)
    await settleAgentStops(runtime)
  }
  while (true) {
    await expireAgentRoot(runtime, turn.root)
    let root = rootView()
    if (signal.aborted || root.stopControl !== null) {
      const control = view().controls.find(item => item.requested.stored.eventId === root.stopControl)
      await finish('cancelled', 'root-stopped', control?.requested.payload.kind === 'expire-work' ? 'timed-out' : 'cancelled'); return
    }
    if (agentRootUsageUnknown(runtime.session.snapshot(), view(), root.id)) { await finish('failed', 'model-usage-unknown', 'failed'); return }
    if (reserveAgentBudget(root.budget, { ...emptyAgentBudget, models: 1, steps: 1, outputTokens: spec.payload.target.maxOutputTokens }, spec.payload.budget) === null) {
      await finish('budget-exhausted', 'model-budget', 'budget-exhausted'); return
    }
    const step = await runtime.journal.append(events.agentStepOpenedEvent, state => ({ turn: turnId,
      ordinal: state.steps.filter(item => item.opened.payload.turn === turnId).length + 1,
      outputTokens: spec.payload.target.maxOutputTokens, observedAt: clockTimestamp(runtime.clock) }))
    let model: AgentStepDecided['model'] = null
    let assemblyId: SessionEventId | null = null
    let classification: Pick<AgentStepDecided, 'classification' | 'reason' | 'actions'> = { classification: 'not-issued', reason: 'context-unavailable', actions: [] }
    let reassemblies = 0
    for (; reassemblies <= spec.payload.limits.maxReassemblies; reassemblies++) {
      try {
        const built = await runtime.context.assembleAgent({ spec: spec.stored.eventId, run: turn.started.payload.run, turn: turnId, step: step.stored.eventId }, { signal })
        if (built.kind !== 'ready') { classification = { classification: 'not-issued', reason: built.kind === 'blocked' ? `context-blocked:${built.reason}` : `context-${built.kind}:${built.limit}`, actions: [] }; break }
        assemblyId = built.committed.stored.eventId
        const settled = await runtime.model.invoke(built.request, { signal, inputPrecondition: built.inputPrecondition })
        model = { invocationId: settled.payload.invocationId, assembly: built.committed.stored.eventId, settled: settled.stored.eventId }
        classification = classifyAgentModel(settled.payload, spec.payload, built.request.tools.map(item => item.name)); break
      } catch (error) {
        if (error instanceof ModelError && error.code === 'MODEL_INPUT_STALE' || error instanceof ContextError && error.code === 'CONTEXT_SOURCE_CHANGED') {
          classification = { classification: 'not-issued', reason: 'context-stale', actions: [] }; continue
        }
        const committed = projectModelSession(runtime.session.snapshot()).invocations.find(item => item.prepared.stored.sequence > step.stored.sequence)
        if (committed?.state === 'settled' && assemblyId !== null) {
          model = { invocationId: committed.invocationId, assembly: assemblyId, settled: committed.settled.stored.eventId }
          classification = classifyAgentModel(committed.settled.payload, spec.payload, committed.prepared.payload.submission.request.tools.map(item => item.name)); break
        }
        if (runtime.session.status !== 'open' || runtime.context.status === 'faulted' || runtime.model.status === 'faulted') throw error
        if (projectModelSession(runtime.session.snapshot()).pendingInvocationId !== null) throw error
        if (!(error instanceof ModelError) && !(error instanceof ContextError)) throw error
        classification = { classification: signal.aborted ? 'cancelled' : 'not-issued', reason: error.code, actions: [] }; break
      }
    }
    await expireAgentRoot(runtime, turn.root)
    const amount = actionBudget(classification.actions.map(item => item.route))
    const decision = await runtime.journal.append(runtime.events.stepDecided, state => {
      const current = state.roots.find(item => item.id === turn.root)!
      const observedAt = clockTimestamp(runtime.clock)
      const admitted = classification.classification === 'actions' && classification.actions.length <= spec.payload.limits.maxActionsPerStep && classification.reason !== 'invalid-control-batch' && !signal.aborted
        && (amount.waits === 0 || state.waits.filter(wait => wait.settled === null).length < spec.payload.limits.maxPendingWaits)
        && current.stopControl === null && observedAt < current.deadline && reserveAgentBudget(current.budget, amount, spec.payload.budget) !== null
      return { step: step.stored.eventId, model, ...classification, admitted, reservation: admitted ? amount : emptyAgentBudget,
        reassemblies: Math.min(reassemblies, spec.payload.limits.maxReassemblies), observedAt }
    })
    const admitted = decision.payload.admitted
    let waiting = false; let failedAction = false; let uncertain = false; let questionLimit = false
    for (const [index, intent] of classification.actions.entries()) {
      const action = { eventId: decision.stored.eventId, index }
      const result: AgentActionResult = admitted && !uncertain ? await executeAgentAction(runtime, turnId, action, intent, signal)
        : { kind: 'not-started' as const, reason: uncertain ? 'prior-result-uncertain' : 'batch-not-admitted' }
      await runtime.journal.append(runtime.events.actionSettled, () => ({ action, result }))
      waiting ||= result.kind === 'wait'
      questionLimit ||= result.kind === 'not-started' && intent.route === 'ask-parent' && result.reason === 'question-limit'
      failedAction ||= result.kind === 'not-started' || result.kind === 'communication-not-accepted'
      if (result.kind === 'tool') {
        const tool: import('../tool/projection.js').ToolInvocationSnapshot | undefined = projectToolSession(runtime.session.snapshot()).invocations.find(item => item.state === 'settled' && item.settled.stored.eventId === result.settled)
        if (tool?.state === 'settled') {
          uncertain ||= tool.settled.payload.cleanup.status !== 'complete' || tool.settled.payload.execution === 'may-have-executed'
          failedAction ||= tool.settled.payload.outcome !== 'succeeded'
        }
      }
    }
    const modelCleanupFailed = model !== null && projectModelSession(runtime.session.snapshot()).invocations.some(item => item.state === 'settled'
      && item.invocationId === model.invocationId && item.settled.payload.cleanup.status !== 'complete')
    uncertain ||= modelCleanupFailed
    if (waiting) { await finish('waiting', 'wait-created', null); return }
    if (uncertain) { await finish('result-unknown', modelCleanupFailed ? 'model-cleanup' : 'tool-result-uncertain', 'result-unknown'); return }
    root = rootView()
    if (root.stopControl !== null || signal.aborted) continue
    if (agentRootUsageUnknown(runtime.session.snapshot(), view(), root.id)) { await finish('failed', 'model-usage-unknown', 'failed'); return }
    if (classification.classification === 'final') {
      const state = view()
      const sources = runtime.session.snapshot().history.at(-1)!.events.filter(item => item.kind === 'known')
      if (state.subagents.delegations.filter(item => item.payload.parentRoot === turn.root).some(item => {
        const closure = delegationClosure(state, item.stored.eventId, sources)
        return !closure.businessResolved || !closure.executionReleased || !closure.adopted
      })) { await finish('failed', 'unresolved-delegation', 'failed'); return }
      const unfulfilled = hasUnfulfilledAgentReply(turn.root, state, projectCommunicationFacts(runtime.session.snapshot()))
      if (unfulfilled) { await finish('failed', 'reply-obligation-unsatisfied', 'failed'); return }
      await finish('completed', classification.reason, 'completed', step.stored.eventId); return
    }
    if (classification.classification !== 'actions') {
      await finish('failed', classification.reason, 'failed'); return
    }
    if (!admitted && classification.reason !== 'invalid-control-batch') { await finish('budget-exhausted', 'action-budget', 'budget-exhausted'); return }
    if (questionLimit) { await finish('failed', 'question-limit', 'failed'); return }
    if (failedAction && spec.payload.errorFeedback === 'stop') { await finish('failed', 'action-failed', 'failed'); return }
  }
}
