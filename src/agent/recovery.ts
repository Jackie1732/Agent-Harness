import type { Clock } from '../foundation/clock.js'
import { clockTimestamp } from '../foundation/clock.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { SessionEventId } from '../session/ids.js'
import { projectModelSession } from '../model/projection.js'
import { recoverModelInvocation } from '../model/recovery.js'
import { projectToolSession } from '../tool/projection.js'
import { recoverToolSession } from '../tool/recovery.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import { AgentJournal } from './journal.js'
import { AgentError } from './errors.js'
import { projectAgentSession } from './projection.js'
import { projectAgentReport } from './report.js'
import { classifyAgentModel } from './decision.js'
import { emptyAgentBudget } from './budget.js'
import type { AgentActionResult } from './event-contract.js'
import { referenceKey } from './input-codec.js'
import { hasUnfulfilledAgentReply } from './obligations.js'
import * as events from './session-events.js'

export interface AgentRecoveryOptions {
  readonly predecessorStopped: true
  readonly supersedes: SessionEventId | null
  readonly maxRecoveryWrites: number
  readonly maxJournalConflicts: number
  readonly clock: Clock
}

/** Administrative local reconciliation. No provider, catalog decoder, policy, mailbox or transport is available here. */
export async function recoverAgentSession(session: SessionHandle, options: AgentRecoveryOptions) {
  if (options.predecessorStopped !== true || !Number.isSafeInteger(options.maxRecoveryWrites) || options.maxRecoveryWrites < 3) {
    throw new AgentError('AGENT_INPUT_INVALID', 'recovery-requires-stop-and-write-budget')
  }
  if (session.snapshot().lifecycle !== 'active') return { kind: 'already-ended' as const, report: projectAgentReport(session.snapshot()) }
  const journal = new AgentJournal(session, options.maxJournalConflicts, options.clock)
  const before = projectAgentSession(session.snapshot())
  if (before.openRecovery !== options.supersedes) throw new AgentError('AGENT_RECOVERY_BUSY', 'recovery-predecessor-mismatch')
  const pendingControls = before.controls.filter(item => item.settled === null && item.supersededBy === null && item.requested.payload.kind !== 'recovery')
  if (before.openRun === null && pendingControls.length === 0 && before.openRecovery === null) return { kind: 'nothing-to-recover' as const, report: projectAgentReport(session.snapshot()) }
  const owner = await journal.append(events.agentControlRequestedEvent, (state, snapshot) => {
    if (state.openRecovery !== options.supersedes) throw new AgentError('AGENT_RECOVERY_BUSY', 'recovery-owner-changed')
    return { kind: 'recovery' as const, targetRun: state.openRun,
    controls: state.controls.filter(item => item.settled === null && item.supersededBy === null && item.requested.payload.kind !== 'recovery').map(item => item.requested.stored.eventId),
    through: snapshot.localPosition, predecessorStopped: true, supersedes: options.supersedes, maxRecoveryWrites: options.maxRecoveryWrites }
  })
  let writes = 1
  while (writes < options.maxRecoveryWrites - 1) {
    const snapshot = session.snapshot()
    const state = projectAgentSession(snapshot)
    if (state.openRecovery !== owner.stored.eventId) throw new AgentError('AGENT_RECOVERY_BUSY', 'recovery-owner-replaced')
    const models = projectModelSession(snapshot)
    const tools = projectToolSession(snapshot)
    if (models.pendingInvocationId !== null) {
      await recoverModelInvocation(session, { invocationId: models.pendingInvocationId, predecessorStopped: true, maxJournalConflicts: options.maxJournalConflicts }); writes++; continue
    }
    if (tools.pendingInvocationId !== null) {
      await recoverToolSession(session, { predecessorStopped: true, maxJournalConflicts: options.maxJournalConflicts }); writes++; continue
    }
    const undecided = state.steps.find(item => item.decided === null)
    if (undecided !== undefined) {
      const candidate = models.invocations.find(item => item.prepared.stored.sequence > undecided.opened.stored.sequence)
      const assembly = candidate === undefined ? undefined : snapshot.history.at(-1)!.events[candidate.prepared.stored.sequence - 2]
      const model = candidate?.state === 'settled' && assembly?.stored.type === 'context/assembly-committed' && assembly.stored.payloadVersion === 2
        ? { invocationId: candidate.invocationId, assembly: assembly.stored.eventId, settled: candidate.settled.stored.eventId } : null
      const classified = model !== null && candidate?.state === 'settled' ? classifyAgentModel(candidate.settled.payload, state.spec!.payload, candidate.prepared.payload.submission.request.tools.map(tool => tool.name))
        : { classification: 'not-issued' as const, reason: 'recovery-before-model', actions: [] }
      await journal.append(events.agentStepDecidedEvent, () => ({ step: undecided.opened.stored.eventId, model, ...classified, admitted: false,
        reservation: emptyAgentBudget, reassemblies: 0, observedAt: clockTimestamp(options.clock) })); writes++; continue
    }
    const pending = state.steps.flatMap(step => step.decided === null ? [] : step.decided.payload.actions.map((intent, index) => ({
      intent, action: { eventId: step.decided!.stored.eventId, index },
    }))).find(item => !state.actions.some(action => referenceKey(action.payload.action) === referenceKey(item.action)))
    if (pending !== undefined) {
      let result: AgentActionResult = { kind: 'not-started', reason: 'recovery-unstarted-action' }
      const tool = tools.invocations.find(item => item.requested.payload.source.kind === 'model'
        && item.requested.payload.source.intent.invocationId === pending.intent.source.invocationId
        && item.requested.payload.source.intent.outputBlockIndex === pending.intent.source.outputBlockIndex)
      const outbox = projectCommunicationFacts(snapshot).outbox.find(item => item.sendKey !== undefined && referenceKey(item.sendKey) === referenceKey(pending.action))
      if (tool?.state === 'settled') result = { kind: 'tool', settled: tool.settled.stored.eventId }
      else if (outbox !== undefined) result = { kind: 'outbox', accepted: outbox.acceptedEventId }
      await journal.append(events.agentActionSettledEvent, () => ({ action: pending.action, result })); writes++; continue
    }
    const command = state.commands.find(item => !state.actions.some(action => action.payload.action.eventId === item.stored.eventId))
    if (command !== undefined) {
      const action = { eventId: command.stored.eventId, index: 0 }
      const outbox = projectCommunicationFacts(snapshot).outbox.find(item => item.sendKey !== undefined && referenceKey(item.sendKey) === referenceKey(action))
      const result: AgentActionResult = outbox === undefined ? { kind: 'communication-not-accepted', reason: 'recovery-no-acceptance', basis: 'recovered-absence' }
        : { kind: 'outbox', accepted: outbox.acceptedEventId }
      await journal.append(events.agentActionSettledEvent, () => ({ action, result })); writes++; continue
    }
    if (state.openTurn !== null) {
      const turn = state.turns.find(item => item.started.stored.eventId === state.openTurn)!
      const root = state.roots.find(root => root.id === turn.root)!
      const wait = state.waits.find(wait => wait.turn === state.openTurn && wait.settled === null)
      const uncertain = models.invocations.some(item => item.state === 'settled' && item.prepared.stored.sequence > turn.started.stored.sequence && item.settled.payload.cleanup.status !== 'complete')
        || tools.invocations.some(item => item.state === 'settled' && item.requested.stored.sequence > turn.started.stored.sequence
          && (item.settled.payload.cleanup.status !== 'complete' || item.settled.payload.execution === 'may-have-executed'))
      const stop = state.controls.find(item => item.requested.stored.eventId === root.stopControl)
      const final = state.steps.filter(step => step.opened.payload.turn === turn.started.stored.eventId).at(-1)
      const model = models.invocations.find(item => item.invocationId === final?.decided?.payload.model?.invocationId)
      const complete = wait === undefined && !uncertain && root.stopControl === null && final?.decided?.payload.classification === 'final'
        && !hasUnfulfilledAgentReply(root.id, state, projectCommunicationFacts(snapshot))
        && (state.spec!.payload.usagePolicy !== 'stop-on-unknown' || model?.state === 'settled' && model.settled.payload.result.usage.completeness === 'complete')
      await journal.append(events.agentTurnSettledEvent, () => ({ turn: turn.started.stored.eventId,
        outcome: wait !== undefined ? 'waiting' as const : complete ? 'completed' as const : uncertain ? 'result-unknown' as const : 'interrupted' as const,
        rootOutcome: wait !== undefined ? null : complete ? 'completed' as const : uncertain ? 'result-unknown' as const : stop?.requested.payload.kind === 'cancel-work' ? 'cancelled' as const
          : stop?.requested.payload.kind === 'expire-work' ? 'timed-out' as const : 'failed' as const,
        reason: complete ? 'recovered-final-result' : 'driver-interrupted', disposition: wait !== undefined || complete ? 'handled' as const : 'review-required' as const,
        finalStep: complete ? final!.opened.stored.eventId : null, budget: root.budget })); writes++; continue
    }
    if (state.openRun !== null) {
      await journal.append(events.agentRunSettledEvent, () => ({ run: state.openRun!, stoppedBy: 'interrupted' as const, reason: 'driver-interrupted' })); writes++; continue
    }
    const control = state.controls.find(item => item.requested.stored.eventId !== owner.stored.eventId && item.settled === null && item.supersededBy === null)
    if (control === undefined) break
    const request = control.requested.payload
    if (request.kind === 'cancel-work' || request.kind === 'expire-work') {
      const wait = state.waits.find(wait => wait.settled === null && wait.created.payload.result.kind === 'wait' && wait.created.payload.result.descriptor.root === request.root)
      if (wait !== undefined) {
        await journal.append(events.agentWaitSettledEvent, () => ({ wait: wait.reference, outcome: 'cancelled' as const, response: null, reason: request.reason, observedAt: clockTimestamp(options.clock), supportedMessages: [], outboxTerminal: null })); writes++; continue
      }
      const root = state.roots.find(root => root.id === request.root)!
      const response = state.inputs.find(input => input.reservedBy !== null && state.waits.some(wait => referenceKey(wait.reference) === referenceKey(input.reservedBy!) && wait.created.payload.result.kind === 'wait' && wait.created.payload.result.descriptor.root === root.id))
      await journal.append(events.agentControlSettledEvent, () => ({ control: control.requested.stored.eventId, outcome: 'completed' as const, reason: request.reason,
        rootOutcome: root.outcome ?? (request.kind === 'expire-work' ? 'timed-out' as const : 'cancelled' as const), responseDisposition: response === undefined ? null : response.message === null ? 'not-adopted' as const : 'release-peer' as const }))
    } else {
      await journal.append(events.agentControlSettledEvent, () => ({ control: control.requested.stored.eventId,
        outcome: request.kind === 'abandon-input' ? 'completed' as const : 'rejected' as const, reason: 'recovery-control', rootOutcome: null, responseDisposition: null }))
    }
    writes++
  }
  const state = projectAgentSession(session.snapshot())
  const incomplete = state.openRun !== null || state.controls.some(item => item.requested.stored.eventId !== owner.stored.eventId && item.settled === null && item.supersededBy === null)
  await journal.append(events.agentControlSettledEvent, () => ({ control: owner.stored.eventId, outcome: incomplete ? 'recovery-incomplete' as const : 'recovered' as const,
    reason: incomplete ? 'recovery-write-budget' : 'local-facts-reconciled', rootOutcome: null, responseDisposition: null }))
  return { kind: incomplete ? 'recovery-incomplete' as const : 'recovered' as const, writes: writes + 1, report: projectAgentReport(session.snapshot()) }
}
