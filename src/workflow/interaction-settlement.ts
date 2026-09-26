import type { AgentProjectionState } from '../agent/projection-state.js'
import { inputKey } from '../agent/input-codec.js'
import type { WorkflowSnapshot } from './projection.js'
import { sameWorkflowValue } from './work-binding.js'
import { workGroupRequestedEvent, workGroupResultEvent } from './group-events.js'
import { workQuestionRequestedEvent, workflowAnswerMessage, workflowInteractionSettledEvent } from './interaction-events.js'

/** Relation outcomes cite local wait, group result or root termination; they never create a response. */
export function workInteractionSettlement(state: AgentProjectionState, interaction: WorkflowSnapshot['interactions'][number]):
  ReturnType<typeof workflowInteractionSettledEvent.decode> | undefined {
  const admitted = interaction.admitted.payload, request = state.sources.get(admitted.request.eventId)!
  const question = admitted.kind === 'question' ? workQuestionRequestedEvent.decode(request.payload) : undefined
  const action = question?.action ?? workGroupRequestedEvent.decode(request.payload).action
  const rootId = question?.root ?? workGroupRequestedEvent.decode(request.payload).root
  const wait = [...state.waits.values()].find(wait => sameWorkflowValue(wait.reference, action))
  let outcome: ReturnType<typeof workflowInteractionSettledEvent.decode>['outcome'] | undefined
  let source: import('../session/ids.js').SessionEventId | undefined
  if (admitted.kind === 'group') {
    const result = [...state.sources.values()].find(event => event.stored.type === workGroupResultEvent.type
      && workGroupResultEvent.decode(event.payload).request === request.stored.eventId)
    if (result !== undefined) { outcome = workGroupResultEvent.decode(result.payload).outcome; source = result.stored.eventId }
  } else if (wait?.settled != null) {
    source = wait.settled.stored.eventId
    if (wait.settled.payload.outcome === 'matched') {
      const input = state.inputs.get(inputKey(wait.settled.payload.response!))!
      outcome = workflowAnswerMessage.decode(input.message!.payload).outcome === 'answered' ? 'answered' : 'declined'
    } else outcome = wait.settled.payload.outcome === 'timed-out' ? 'timed-out' : 'cancelled'
  }
  if (source === undefined && state.roots.get(rootId)!.outcome !== null) {
    const turn = [...state.turns.values()].find(turn => turn.root === rootId && turn.settled?.payload.rootOutcome != null)?.settled
    const control = [...state.controls.values()].find(item => 'root' in item.requested.payload && item.requested.payload.root === rootId
      && item.settled?.payload.rootOutcome != null)?.settled
    source = turn?.stored.eventId ?? control?.stored.eventId ?? wait?.settled?.stored.eventId
    outcome = 'interrupted'
  }
  return source === undefined ? undefined : { interaction: interaction.admitted.stored.eventId, outcome: outcome!,
    source: { address: admitted.request.address, eventId: source } }
}
