import type { AgentProjectionState } from '../agent/projection-state.js'
import { source } from '../agent/projection-state.js'
import type { SessionEventId } from '../session/ids.js'
import { formatSessionAddress, formatSessionEventId, parseSessionEventId, sessionSequence } from '../session/ids.js'
import type { JsonObject } from '../foundation/json.js'
import { WorkflowError, invalidHistory } from './errors.js'
import { workAssignmentAcceptedEvent, sameWorkflowValue } from './work-binding.js'
import { workExecutionReleasedEvent } from './result-events.js'
import type { WorkProposal } from './result-events.js'
import { deriveWorkOutput } from './result.js'
import { assertWorkflowMessageFits } from './message-budget.js'

/** Resolve the actual terminal event, including a stopped or expired waiting root. */
function terminalWork(state: AgentProjectionState, accepted: SessionEventId) {
  const binding = source(state, accepted, workAssignmentAcceptedEvent).payload
  const root = [...state.roots.values()].find(root => root.source.kind === 'workflow' && sameWorkflowValue(root.source.assignment, binding.assignment))
  if (root?.outcome == null) invalidHistory('delivery-root-open')
  const turn = [...state.turns.values()].filter(turn => turn.root === root.id).at(-1)
  if (turn?.settled == null) invalidHistory('delivery-turn-open')
  const control = [...state.controls.values()].find(control => control.settled?.payload.rootOutcome === root.outcome
    && ['cancel-work', 'expire-work'].includes(control.requested.payload.kind) && 'root' in control.requested.payload && control.requested.payload.root === root.id)
  const wait = [...state.waits.values()].find(wait => wait.settled !== null && wait.settled.payload.outcome !== 'matched'
    && wait.created.payload.result.kind === 'wait' && wait.created.payload.result.descriptor.root === root.id)
  const terminal = turn.settled.payload.rootOutcome !== null ? turn.settled.stored.eventId
    : control?.settled?.stored.eventId ?? wait?.settled?.stored.eventId
  if (terminal === undefined) invalidHistory('delivery-terminal-source')
  return { binding, root: root.id, terminal, outcome: root.outcome }
}

/** A failed delivery preserves the Model/Agent outcome and produces only a small failure proposal. */
export function deriveWorkDelivery(state: AgentProjectionState, accepted: SessionEventId, executionRelease: SessionEventId) {
  const terminal = terminalWork(state, accepted)
  const release = source(state, executionRelease, workExecutionReleasedEvent).payload
  if (release.accepted !== accepted || release.root !== terminal.root || !sameWorkflowValue(release.assignment, terminal.binding.assignment)) invalidHistory('delivery-release-source')
  const base = { accepted, root: terminal.root, terminal: terminal.terminal, executionRelease, assignment: terminal.binding.assignment }
  const fail = (outcome: Exclude<WorkProposal['outcome'], 'completed'>, reason: string) => ({ binding: terminal.binding,
    proposal: { ...base, outcome, reason, value: null, artifacts: [] } as WorkProposal,
    artifacts: [] as ReturnType<typeof deriveWorkOutput>['artifacts'] })
  if (release.outcome !== 'released' || terminal.outcome === 'result-unknown') return fail('result-unknown', 'work-result-unknown')
  if (terminal.outcome !== 'completed') return fail(terminal.outcome === 'cancelled' ? 'cancelled' : 'failed', 'root-' + terminal.outcome)
  try {
    const output = deriveWorkOutput(state, accepted)
    const sessionId = parseSessionEventId(accepted).sessionId
    const address = formatSessionAddress(sessionId)
    const ref = (offset: number) => ({ address, eventId: formatSessionEventId(sessionId, sessionSequence(Number.MAX_SAFE_INTEGER - offset)) })
    const proposal: WorkProposal = { ...base, outcome: 'completed', reason: null, value: output.value, artifacts: output.artifacts.map((_, index) => ref(index + 1)) }
    const message = { assignment: base.assignment, proposal: ref(0), value: proposal,
      artifacts: output.artifacts.map((artifact, index) => ({ ref: proposal.artifacts[index]!, value: {
        assignment: base.assignment, accepted, root: base.root, executionRelease, ...artifact,
      } })) }
    assertWorkflowMessageFits(sessionId, { kind: 'send', type: terminal.binding.value.kind === 'review' ? 'workflow/review' : 'workflow/proposal', payloadVersion: 1,
      request: { kind: 'root', recipient: base.assignment.address, channelId: terminal.binding.value.channelId }, payload: message as unknown as JsonObject }, terminal.binding.value.protocolLimits)
    return { binding: terminal.binding, proposal, artifacts: output.artifacts }
  } catch (cause) {
    if (cause instanceof WorkflowError && cause.code === 'WORKFLOW_RESULT_INVALID') return fail('failed', cause.message)
    throw cause
  }
}
