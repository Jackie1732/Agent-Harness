import { sessionLogPosition } from '../session/ids.js'
import type { AgentControlRequest, AgentControlSettled } from './event-contract.js'
import { inputReference } from './input-codec.js'
import { agentJson, array, choice, eventId, exact, flag, integer, nullableId, record, text, timestamp, unique } from './validation.js'
import { invalidAgent } from './errors.js'

export const rootOutcomes = ['completed', 'failed', 'cancelled', 'budget-exhausted', 'result-unknown', 'timed-out'] as const

export function decodeControlRequest(value: unknown, version: 1 | 2 = 1): AgentControlRequest {
  const input = record(agentJson(value))
  const kind = choice(input.kind, ['cancel-work', 'expire-work', 'abandon-input', 'close-session', 'recovery'])
  switch (kind) {
    case 'cancel-work':
      exact(input, ['kind', 'root', 'reason']); eventId(input.root); text(input.reason, 128); break
    case 'expire-work':
      exact(input, ['kind', 'root', 'reason', 'deadline', 'observedAt'])
      eventId(input.root); text(input.reason, 128); timestamp(input.deadline); timestamp(input.observedAt)
      if (String(input.observedAt) < String(input.deadline)) invalidAgent('deadline-not-observed')
      break
    case 'abandon-input':
      exact(input, ['kind', 'input', 'reason']); inputReference(input.input, version); text(input.reason, 128); break
    case 'close-session': exact(input, ['kind', 'reason']); text(input.reason, 128, true); break
    case 'recovery':
      exact(input, ['kind', 'targetRun', 'controls', 'through', 'predecessorStopped', 'supersedes', 'maxRecoveryWrites'])
      nullableId(input.targetRun); unique(array(input.controls).map(eventId)); sessionLogPosition(integer(input.through))
      if (!flag(input.predecessorStopped)) invalidAgent('predecessor-not-stopped')
      nullableId(input.supersedes); integer(input.maxRecoveryWrites, 3)
      break
  }
  return input as AgentControlRequest
}

export function decodeControlSettled(value: unknown): AgentControlSettled {
  const input = record(agentJson(value))
  exact(input, ['control', 'outcome', 'reason', 'rootOutcome', 'responseDisposition'])
  eventId(input.control); choice(input.outcome, ['completed', 'rejected', 'no-op', 'recovered', 'recovery-incomplete'])
  text(input.reason, 128)
  if (input.rootOutcome !== null) choice(input.rootOutcome, rootOutcomes)
  if (input.responseDisposition !== null) choice(input.responseDisposition, ['release-peer', 'not-adopted'])
  return input as AgentControlSettled
}
