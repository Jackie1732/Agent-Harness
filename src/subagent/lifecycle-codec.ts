import { rootOutcomes } from '../agent/control-codec.js'
import { agentJson, array, choice, eventId, exact, integer, nullableId, record, text, timestamp, unique } from '../agent/validation.js'
import { parseSessionAddress, sessionLogPosition } from '../session/ids.js'
import type * as Lifecycle from './lifecycle-contract.js'

const common = ['delegation', 'parentAddress', 'childAddress'] as const
function base(value: unknown, fields: readonly string[]) {
  const input = record(agentJson(value)); exact(input, [...common, ...fields])
  eventId(input.delegation); parseSessionAddress(text(input.parentAddress)); parseSessionAddress(text(input.childAddress))
  if (input.parentAddress === input.childAddress) throw new TypeError('same-session')
  return input
}
export function decodeProvisionSettled(value: unknown): Lifecycle.SubagentProvisionSettled {
  const input = base(value, ['outcome', 'child', 'phase', 'cleanup', 'reasonCode'])
  choice(input.outcome, ['installed', 'failed', 'reconciliation-required'])
  choice(input.phase, ['session', 'installation', 'protocol', 'execution', 'published'])
  choice(input.cleanup, ['not-needed', 'released', 'cleanup-incomplete', 'unknown']); text(input.reasonCode, 128)
  if (input.child !== null) {
    const child = record(input.child); exact(child, ['bound', 'profile', 'spec', 'ready', 'execution', 'protocol'])
    Object.values(child).forEach(eventId)
  }
  if (input.outcome === 'installed' && (input.child === null || input.phase !== 'published' || input.cleanup !== 'not-needed')) throw new TypeError('installed-proof')
  return input as Lifecycle.SubagentProvisionSettled
}
export function decodeDeliveryFailed(value: unknown): Lifecycle.SubagentDeliveryFailed {
  const input = base(value, ['protocol', 'failure', 'terminal', 'reasonCode'])
  eventId(input.protocol); choice(input.failure, ['outbox-terminal', 'cancelled-before-send'])
  nullableId(input.terminal); text(input.reasonCode, 128)
  if ((input.terminal !== null) !== (input.failure === 'outbox-terminal')) throw new TypeError('delivery-failure-source')
  return input as Lifecycle.SubagentDeliveryFailed
}
export function decodeSubagentControlRequested(value: unknown): Lifecycle.SubagentControlRequested {
  const input = base(value, ['kind', 'source', 'reasonCode', 'observedAt'])
  choice(input.kind, ['cancel', 'revoke']); text(input.reasonCode, 128); timestamp(input.observedAt)
  const source = record(input.source)
  if (source.kind === 'parent-stop') { exact(source, ['kind', 'eventId']); eventId(source.eventId) }
  else { exact(source, ['kind', 'requestKey']); choice(source.kind, ['controller']); text(source.requestKey, 128) }
  return input as Lifecycle.SubagentControlRequested
}
export function decodeSubagentControlSettled(value: unknown): Lifecycle.SubagentControlSettled {
  const input = base(value, ['control', 'business', 'root', 'executionRelease', 'reasonCode'])
  eventId(input.control); choice(input.business, ['not-started', 'terminal']); nullableId(input.root); nullableId(input.executionRelease); text(input.reasonCode, 128)
  if ((input.root !== null) !== (input.business === 'terminal')) throw new TypeError('control-root')
  return input as Lifecycle.SubagentControlSettled
}
export function decodeSettlementObserved(value: unknown): Lifecycle.SubagentSettlementObserved {
  const input = base(value, ['childThrough', 'business', 'resources', 'protocol', 'evidence', 'deliveryFailures', 'modelUsage'])
  sessionLogPosition(integer(input.childThrough)); unique(array(input.deliveryFailures).map(eventId))
  const business = record(input.business)
  switch (business.kind) {
    case 'pending': exact(business, ['kind']); break
    case 'not-started': exact(business, ['kind', 'control']); eventId(business.control); break
    case 'terminal': exact(business, ['kind', 'root', 'terminal', 'outcome']); eventId(business.root); eventId(business.terminal); choice(business.outcome, rootOutcomes); break
    default: throw new TypeError('observed-business')
  }
  unique(array(input.resources).map(value => {
    const resource = record(value); exact(resource, ['opened', 'component', 'generation', 'release', 'outcome'])
    choice(resource.component, ['execution', 'protocol']); integer(resource.generation, 1); nullableId(resource.release)
    choice(resource.outcome, ['pending', 'released', 'cleanup-incomplete', 'unknown'])
    if ((resource.release === null) !== (resource.outcome === 'pending')) throw new TypeError('observed-release')
    return eventId(resource.opened)
  }))
  const protocol = record(input.protocol); exact(protocol, ['pendingIntents', 'pendingOutbox', 'pendingInbox', 'pendingControls'])
  Object.values(protocol).forEach(value => integer(value)); unique(array(input.evidence).map(eventId))
  const usage = record(input.modelUsage); exact(usage, ['settled', 'partialOrUnknown', 'inputTokens', 'outputTokens'])
  integer(usage.settled); integer(usage.partialOrUnknown, 0, usage.settled as number)
  for (const field of ['inputTokens', 'outputTokens']) if (usage[field] !== null) integer(usage[field])
  return input as Lifecycle.SubagentSettlementObserved
}
export function decodeRecoveryRequested(value: unknown): Lifecycle.SubagentRecoveryRequested {
  const input = base(value, ['through', 'predecessorStopped', 'supersedes', 'maxWrites'])
  sessionLogPosition(integer(input.through)); nullableId(input.supersedes); integer(input.maxWrites, 2)
  if (input.predecessorStopped !== true) throw new TypeError('predecessor-not-stopped')
  return input as Lifecycle.SubagentRecoveryRequested
}
export function decodeRecoverySettled(value: unknown): Lifecycle.SubagentRecoverySettled {
  const input = base(value, ['recovery', 'writes', 'outcome', 'pending', 'evidence'])
  eventId(input.recovery); integer(input.writes, 1); choice(input.outcome, ['complete', 'incomplete', 'blocked'])
  unique(array(input.pending).map(value => text(value, 128))); unique(array(input.evidence).map(eventId))
  if (input.outcome === 'complete' && array(input.pending).length !== 0) throw new TypeError('complete-has-pending')
  return input as Lifecycle.SubagentRecoverySettled
}
