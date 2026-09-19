import { parseModelInvocationId } from '../model/ids.js'
import type { AgentEventPayloads, AgentActionResult, AgentMaintenanceRunSettled, AgentMaintenanceRunStarted } from './event-contract.js'
import { decodeAgentBudget } from './budget.js'
import { rootOutcomes } from './control-codec.js'
import { actionReference, decodeAgentCommand, decodeAgentInput, decodeWaitDescriptor, inputReference } from './input-codec.js'
import { agentJson, array, choice, eventId, exact, flag, integer, nullableId, record, text, timestamp } from './validation.js'

export function decodeInputAccepted(value: unknown): AgentEventPayloads['input-accepted'] {
  const input = record(agentJson(value)); exact(input, ['spec', 'input']); eventId(input.spec)
  return Object.freeze({ spec: eventId(input.spec), input: decodeAgentInput(input.input) })
}
export function decodeRunStarted(value: unknown): AgentEventPayloads['run-started'] {
  const input = record(agentJson(value)); exact(input, ['spec', 'kind']); eventId(input.spec); choice(input.kind, ['drive', 'command'])
  return input as AgentEventPayloads['run-started']
}
export function decodeRunSettled(value: unknown): AgentEventPayloads['run-settled'] {
  const input = record(agentJson(value)); exact(input, ['run', 'stoppedBy', 'reason']); eventId(input.run)
  choice(input.stoppedBy, ['idle', 'paused', 'waiting', 'run-budget', 'cancelled', 'faulted', 'interrupted', 'command-settled', 'command-budget'])
  text(input.reason, 128)
  return input as AgentEventPayloads['run-settled']
}
export function decodeMaintenanceRunStarted(value: unknown): AgentMaintenanceRunStarted {
  const input = record(agentJson(value)); exact(input, ['spec', 'kind']); eventId(input.spec); choice(input.kind, ['maintenance'])
  return input as AgentMaintenanceRunStarted
}
export function decodeMaintenanceRunSettled(value: unknown): AgentMaintenanceRunSettled {
  const input = record(agentJson(value)); exact(input, ['run', 'stoppedBy', 'reason']); eventId(input.run)
  choice(input.stoppedBy, ['idle', 'run-budget', 'cancelled', 'faulted', 'interrupted']); text(input.reason, 128)
  return input as AgentMaintenanceRunSettled
}
export function decodeTurnStarted(value: unknown): AgentEventPayloads['turn-started'] {
  const input = record(agentJson(value)); exact(input, ['run', 'input', 'lane', 'ordinal', 'root', 'predecessor', 'deadline', 'observedAt'])
  timestamp(input.observedAt)
  eventId(input.run); inputReference(input.input); text(input.lane, 256); integer(input.ordinal, 1); nullableId(input.root)
  if (input.predecessor !== null) actionReference(input.predecessor)
  if (input.deadline !== null) timestamp(input.deadline)
  return input as AgentEventPayloads['turn-started']
}
export function decodeStepOpened(value: unknown): AgentEventPayloads['step-opened'] {
  const input = record(agentJson(value)); exact(input, ['turn', 'ordinal', 'outputTokens', 'observedAt'])
  timestamp(input.observedAt)
  eventId(input.turn); integer(input.ordinal, 1); integer(input.outputTokens, 1)
  return input as AgentEventPayloads['step-opened']
}
export function decodeStepDecided(value: unknown): AgentEventPayloads['step-decided'] {
  const input = record(agentJson(value))
  exact(input, ['step', 'model', 'classification', 'reason', 'actions', 'admitted', 'reservation', 'reassemblies', 'observedAt'])
  timestamp(input.observedAt)
  eventId(input.step); choice(input.classification, ['final', 'actions', 'failed', 'cancelled', 'not-issued']); text(input.reason, 128)
  if (input.model !== null) {
    const model = record(input.model); exact(model, ['invocationId', 'assembly', 'settled'])
    parseModelInvocationId(text(model.invocationId)); eventId(model.assembly); eventId(model.settled)
  }
  array(input.actions, 64).forEach(value => {
    const action = record(value); exact(action, ['source', 'route'])
    const source = record(action.source); exact(source, ['invocationId', 'outputBlockIndex'])
    parseModelInvocationId(text(source.invocationId)); integer(source.outputBlockIndex)
    choice(action.route, ['tool', 'send', 'reply', 'wait', 'ask', 'invalid'])
  })
  flag(input.admitted); decodeAgentBudget(input.reservation); integer(input.reassemblies)
  return input as AgentEventPayloads['step-decided']
}
function actionResult(value: unknown): AgentActionResult {
  const input = record(value)
  const kind = choice(input.kind, ['tool', 'outbox', 'wait', 'not-started', 'communication-not-accepted'])
  switch (kind) {
    case 'tool': exact(input, ['kind', 'settled']); eventId(input.settled); break
    case 'outbox': exact(input, ['kind', 'accepted']); eventId(input.accepted); break
    case 'wait': exact(input, ['kind', 'descriptor']); decodeWaitDescriptor(input.descriptor); break
    case 'not-started': exact(input, ['kind', 'reason']); text(input.reason, 128); break
    case 'communication-not-accepted':
      exact(input, ['kind', 'reason', 'basis']); text(input.reason, 128); choice(input.basis, ['observed-rejection', 'recovered-absence']); break
  }
  return input as AgentActionResult
}
export function decodeActionSettled(value: unknown): AgentEventPayloads['action-settled'] {
  const input = record(agentJson(value)); exact(input, ['action', 'result'])
  return Object.freeze({ action: actionReference(input.action), result: actionResult(input.result) })
}
export function decodeTurnSettled(value: unknown): AgentEventPayloads['turn-settled'] {
  const input = record(agentJson(value)); exact(input, ['turn', 'outcome', 'rootOutcome', 'reason', 'disposition', 'finalStep', 'budget'])
  eventId(input.turn); choice(input.outcome, ['completed', 'waiting', 'failed', 'cancelled', 'budget-exhausted', 'result-unknown', 'interrupted'])
  if (input.rootOutcome !== null) choice(input.rootOutcome, rootOutcomes)
  text(input.reason, 128); choice(input.disposition, ['handled', 'review-required', 'abandoned', 'not-adopted'])
  nullableId(input.finalStep); decodeAgentBudget(input.budget)
  return input as AgentEventPayloads['turn-settled']
}
export function decodeWaitSettled(value: unknown): AgentEventPayloads['wait-settled'] {
  const input = record(agentJson(value)); exact(input, ['wait', 'outcome', 'response', 'reason', 'observedAt', 'supportedMessages', 'outboxTerminal'])
  nullableId(input.outboxTerminal)
  array(input.supportedMessages, 256).forEach(value => {
    const kind = record(value); exact(kind, ['type', 'payloadVersion']); text(kind.type, 128); integer(kind.payloadVersion, 1)
  })
  actionReference(input.wait); choice(input.outcome, ['matched', 'timed-out', 'cancelled', 'unavailable'])
  if (input.response !== null) inputReference(input.response)
  text(input.reason, 128); timestamp(input.observedAt)
  return input as AgentEventPayloads['wait-settled']
}
export function decodeCommandAccepted(value: unknown): AgentEventPayloads['command-accepted'] {
  const input = record(agentJson(value)); exact(input, ['run', 'spec', 'root', 'command'])
  eventId(input.run); eventId(input.spec); choice(input.root === null ? 'null' : '', ['null'])
  return Object.freeze({ run: eventId(input.run), spec: eventId(input.spec), root: null, command: decodeAgentCommand(input.command) })
}
