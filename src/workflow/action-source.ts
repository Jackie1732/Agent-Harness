import type { AgentActionReference } from '../agent/contract.js'
import type { AgentProjectionState } from '../agent/projection-state.js'
import { originalAgentActionArguments } from '../agent/model-source.js'
import { referenceKey } from '../agent/input-codec.js'
import { workAcceptanceForRoot } from './work-projection.js'
import { invalidHistory } from './errors.js'

/** New work intents belong to the active admitted action, never to a model-supplied root identity. */
export function workActionSource(state: AgentProjectionState, action: AgentActionReference) {
  const step = [...state.steps.values()].find(item => item.decided?.stored.eventId === action.eventId)
  const intent = step?.decided?.payload.actions[action.index]
  const turn = step === undefined ? undefined : state.turns.get(step.opened.payload.turn)
  const root = turn === undefined ? undefined : state.roots.get(turn.root)
  if (state.spec?.payload.protocolVersion !== 3 || intent === undefined || !step?.decided?.payload.admitted
    || turn === undefined || state.openTurn !== turn.started.stored.eventId || root?.source.kind !== 'workflow'
    || root.outcome !== null || state.actions.has(referenceKey(action))) invalidHistory('work-action-source')
  const input = workAcceptanceForRoot(state, root.id)
  const binding = input.work!
  const names: Partial<Record<typeof intent.route, string>> = { 'work-progress': 'agent_report_work_progress',
    'work-ask': 'agent_ask_work_peer', 'work-receive': 'agent_await_work_message', 'work-answer': 'agent_answer_work_peer' }
  const name = names[intent.route]
  if (binding.value.kind !== 'production' || name === undefined || !binding.value.nativeActions.includes(name)) invalidHistory('work-action-authority')
  return { intent, turn, root, binding, accepted: input.reference.eventId, args: originalAgentActionArguments(state, intent) }
}
