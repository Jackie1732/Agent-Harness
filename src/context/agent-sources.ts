import type { JsonValue } from '../foundation/json.js'
import type { ModelInputMessage } from '../model/contract.js'
import type { SessionEventId } from '../session/ids.js'
import type { SessionSnapshot } from '../session/types.js'
import { agentActionHistory } from '../agent/action-history.js'
import { inputKey } from '../agent/input-codec.js'
import type { AgentSessionSnapshot, AgentTurnState } from '../agent/state.js'
import type { ContextUnitReference } from './contract.js'
import { invalidSource } from './errors.js'
import { canonicalText } from './validation.js'

export type AgentContextUnit = {
  readonly reference: ContextUnitReference
  readonly sourceEventIds: readonly SessionEventId[]
  readonly messages: readonly ModelInputMessage[]
}
export function agentDataMessage(kind: string, source: JsonValue, data: JsonValue): ModelInputMessage {
  return { role: 'user', content: [{ kind: 'text', text: canonicalText({ kind, source, data, trust: 'task-data' }) }] }
}

/** Walk turns in their durable causal order. A matched response appears once, at its claim. */
export function agentTurnUnits(snapshot: SessionSnapshot, state: AgentSessionSnapshot, turns: readonly AgentTurnState[]): readonly AgentContextUnit[] {
  const units: AgentContextUnit[] = []
  for (const turn of turns) {
    const input = state.inputs.find(item => inputKey(item.reference) === inputKey(turn.started.payload.input))
    if (input === undefined) invalidSource('agent-claim-source')
    const reference: ContextUnitReference = { eventId: input.reference.eventId, selector: input.reference.kind === 'user' ? 'user-input' : 'peer-message' }
    units.push({ reference, sourceEventIds: [input.reference.eventId, turn.started.stored.eventId, ...(input.protocol === undefined ? [] : [input.protocol.inbox])], messages: [agentDataMessage(
      input.work !== undefined ? 'workflow-task' : input.protocol === undefined ? input.message === null ? 'agent-user-input' : 'agent-peer-input' : `subagent-${input.protocol.kind}`,
      input.reference, input.work === undefined ? input.input ?? input.message ?? snapshot.history.at(-1)!.events.find(item => item.stored.eventId === input.reference.eventId)!.stored.payload : { task: input.input!.text, assignment: input.work.assignment, inputs: input.work.value.inputs, output: input.work.recipe.nodes.find(node => node.nodeKey === input.work!.value.nodeKey)!.output })] })
    for (const step of state.steps.filter(item => item.opened.payload.turn === turn.started.stored.eventId)) {
      const decision = step.decided
      if (decision === null) continue
      if (decision.payload.actions.some((_, index) => !state.actions.some(action => action.payload.action.eventId === decision.stored.eventId && action.payload.action.index === index))) invalidSource('agent-history-open-action')
      const sourceEventIds = [step.opened.stored.eventId, decision.stored.eventId]
      if (decision.payload.model !== null) sourceEventIds.push(decision.payload.model.assembly, decision.payload.model.settled)
      for (const action of state.actions.filter(action => action.payload.action.eventId === decision.stored.eventId)) {
        sourceEventIds.push(action.stored.eventId)
        if (action.payload.result.kind === 'tool') sourceEventIds.push(action.payload.result.settled)
        if (action.payload.result.kind === 'outbox') sourceEventIds.push(action.payload.result.accepted)
      }
      units.push({ reference: { eventId: decision.stored.eventId, selector: decision.payload.classification === 'final' ? 'assistant-response' : 'tool-exchange' },
        sourceEventIds, messages: decision.payload.model === null ? [agentDataMessage('agent-step-diagnostic', decision.stored.eventId, { reason: decision.payload.reason })]
          : agentActionHistory(snapshot, decision.stored.eventId, state) })
    }
  }
  return units
}
