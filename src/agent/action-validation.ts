import { modelSettledEvent } from '../model/session-events.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { AgentActionIntent, AgentActionSettled } from './event-contract.js'
import type { AgentProjectionState } from './projection-state.js'
import { requireEntry, requireSpec, source } from './projection-state.js'
import { decodeAgentCommand, inputKey } from './input-codec.js'
import { agentJson, equal, exact, integer, record, text } from './validation.js'
import { resolveAgentSend } from './command.js'
import { invalidAgent } from './errors.js'
import { rootPeerInputs } from './obligations.js'

function originalArguments(state: AgentProjectionState, intent: AgentActionIntent) {
  const settled = [...state.sources.values()].find(item => item.stored.type === modelSettledEvent.type && record(item.payload).invocationId === intent.source.invocationId)
  if (settled === undefined) return invalidAgent('action-model-missing')
  const cp2 = source(state, settled.stored.eventId, modelSettledEvent)
  const block = cp2.payload.result.blocks.find(item => item.index === intent.source.outputBlockIndex)
  if (block?.kind !== 'tool-call' || Buffer.byteLength(block.argumentsText) > requireSpec(state).payload.limits.maxActionBytes) return invalidAgent('action-model-arguments')
  try { return record(agentJson(JSON.parse(block.argumentsText))) } catch { return invalidAgent('action-model-json') }
}

/** Durable success must prove the exact command and permitted task association. */
export function validateAgentActionSource(state: AgentProjectionState, event: CommittedSessionEvent<AgentActionSettled>, intent: AgentActionIntent | null) {
  const result = event.payload.result
  if (result.kind !== 'outbox' && result.kind !== 'wait') return
  const spec = requireSpec(state).payload
  const step = [...state.steps.values()].find(item => item.decided?.stored.eventId === event.payload.action.eventId)
  const turn = step === undefined ? undefined : state.turns.get(step.opened.payload.turn)
  if (result.kind === 'outbox') {
    const command = intent === null ? requireEntry(state.commands, event.payload.action.eventId, 'command-source').payload.command
      : decodeAgentCommand({ ...originalArguments(state, intent), kind: intent.route })
    if (command.kind === 'reply' && intent !== null) {
      if (turn === undefined || !rootPeerInputs(turn.root, [...state.turns.values()], [...state.inputs.values()]).some(input => input.message!.messageId === command.messageId)) invalidAgent('reply-not-root-claim')
    }
    const outgoing = requireEntry(state.sources, result.accepted, 'action-outbox-source')
    const trigger = turn === undefined ? undefined : state.inputs.get(inputKey(turn.started.payload.input))?.message ?? undefined
    if (!equal(record(outgoing.payload).command, resolveAgentSend(spec, command, trigger))) invalidAgent('action-raw-command-mismatch')
    return
  }
  if (intent === null || turn === undefined) return invalidAgent('wait-source-missing')
  const descriptor = result.descriptor
  const args = originalArguments(state, intent)
  exact(args, descriptor.kind === 'user' ? ['question', 'timeoutMs'] : ['messageId', 'timeoutMs'])
  const timeout = integer(args.timeoutMs, 1, spec.limits.maxWaitMs)
  const root = requireEntry(state.roots, turn.root, 'wait-root')
  const deadline = new Date(Math.min(Date.parse(descriptor.observedAt) + timeout, Date.parse(root.deadline))).toISOString()
  if (descriptor.deadline !== deadline || !equal(descriptor.protectedTurns, [...state.turns.values()].filter(item => item.root === root.id).map(item => item.started.stored.eventId))) invalidAgent('wait-context-or-deadline')
  if (descriptor.kind === 'user' ? descriptor.question !== text(args.question, spec.limits.maxResultBytes) : descriptor.messageId !== args.messageId) invalidAgent('wait-arguments-mismatch')
}
