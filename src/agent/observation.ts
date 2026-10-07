import { projectAgentSession } from './projection.js'
import { projectModelSession } from '../model/projection.js'
import { projectToolSession } from '../tool/projection.js'
import { projectWorkRecoveries } from '../workflow/recovery-projection.js'
import { workExecutionReports } from '../workflow/work-report.js'
import { delegationClosure } from '../subagent/closure.js'
import type { AgentActionReference } from './contract.js'
import type { SessionEventId } from '../session/ids.js'
import type { SessionSnapshot } from '../session/types.js'
import type { AgentRootFinal } from './report-data.js'
import { AgentError } from './errors.js'

/** Find only user inputs accepted in this Session's own log. */
export function selectUserInput(snapshot: SessionSnapshot, query: { readonly inputEventId: SessionEventId } | { readonly namespace: string; readonly key: string }) {
  const state = projectAgentSession(snapshot)
  const local = new Set(snapshot.history.at(-1)!.events.filter(item => item.kind === 'known' && item.stored.type === 'agent/input-accepted').map(item => item.stored.eventId))
  const input = state.inputs.find(item => local.has(item.reference.eventId) && item.input !== null && ('inputEventId' in query
    ? item.reference.eventId === query.inputEventId : item.submission?.namespace === query.namespace && item.submission.key === query.key))
  if (input === undefined) return null
  const turn = state.turns.find(item => item.started.stored.eventId === input.claimedBy)
  return { inputEventId: input.reference.eventId, kind: input.input!.kind, submission: input.submission ?? null,
    status: input.status, claimedBy: input.claimedBy, rootId: turn?.root ?? null, reason: input.reason,
    wait: input.input!.kind === 'answer' ? input.input!.wait : null }
}

/** Select one Root and its exact final Turn, Step and Model settlement. */
export function selectAgentRoot(snapshot: SessionSnapshot, id: SessionEventId, textBudget: number) {
  const state = projectAgentSession(snapshot), root = state.roots.find(item => item.id === id)
  if (root === undefined) return null
  const turns = state.turns.filter(item => item.root === id)
  const local = snapshot.history.at(-1)!.events.filter(item => item.kind === 'known')
  const recoveries = projectWorkRecoveries(local)
  const reconciled = (sequence: number) => state.subagents.recoveries.some(item => item.settled?.payload.outcome === 'complete' && item.requested.payload.through >= sequence)
    || recoveries.some(item => item.settled !== null && item.requested.payload.through >= sequence)
  const belongs = (sequence: number) => turns.some(turn => sequence > turn.started.stored.sequence && (turn.settled === null || sequence < turn.settled.stored.sequence))
  const modelPending = projectModelSession(snapshot).invocations.some(item => belongs(item.prepared.stored.sequence)
    && (item.state !== 'settled' || item.settled.payload.cleanup.status !== 'complete' && !reconciled(item.prepared.stored.sequence)))
  const toolPending = projectToolSession(snapshot).invocations.some(item => belongs(item.requested.stored.sequence)
    && (item.state !== 'settled' || item.settled.payload.cleanup.status !== 'complete' && !reconciled(item.requested.stored.sequence)))
  const childPending = state.subagents.delegations.some(item => item.payload.parentRoot === id && !delegationClosure(state, item.stored.eventId, local).executionReleased)
  const workPending = workExecutionReports(snapshot).some(item => item.root === id && item.execution !== 'released')
  let final: AgentRootFinal | null = null
  if (root.outcome === 'completed') {
    const turn = turns.filter(item => item.settled?.payload.outcome === 'completed').at(-1)
    const step = state.steps.find(item => item.opened.stored.eventId === turn?.settled?.payload.finalStep)
    const source = step?.decided?.payload.model
    const model = projectModelSession(snapshot).invocations.find(item => item.invocationId === source?.invocationId)
    if (turn === undefined || step === undefined || source === undefined || source === null || model?.state !== 'settled'
      || model.settled.stored.eventId !== source.settled) throw new AgentError('AGENT_SOURCE_INVALID', 'completed-root-final-missing')
    const text = model.settled.payload.result.blocks.flatMap(block => block.kind === 'text' && block.complete ? [block.text] : []).join('')
    const textBytes = Buffer.byteLength(text), textOmitted = textBytes > Math.min(textBudget, state.spec!.payload.limits.maxResultBytes)
    final = { turnId: turn.started.stored.eventId, stepId: step.opened.stored.eventId, modelSettledId: model.settled.stored.eventId,
      text: textOmitted ? null : text, textBytes, textOmitted }
  }
  return { rootId: root.id, source: root.source, outcome: root.outcome, reason: root.reason, stopControl: root.stopControl,
    waits: state.waits.flatMap(wait => wait.settled === null && wait.created.payload.result.kind === 'wait' && wait.created.payload.result.descriptor.root === id
      ? [{ reference: wait.reference, descriptor: wait.created.payload.result.descriptor }] : []),
    final, executionPending: turns.some(turn => turn.settled === null) || modelPending || toolPending || childPending || workPending }
}

/** User answers retain the exact Wait's Root even after that Wait has settled. */
export function rootForWait(snapshot: SessionSnapshot, reference: AgentActionReference): SessionEventId | null {
  const wait = projectAgentSession(snapshot).waits.find(item => item.reference.eventId === reference.eventId && item.reference.index === reference.index)
  return wait?.created.payload.result.kind === 'wait' ? wait.created.payload.result.descriptor.root : null
}
