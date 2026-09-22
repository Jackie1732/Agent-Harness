import { effectiveResourceRelease } from './resource-evidence.js'
import type { AgentInputState, AgentTurnState } from '../agent/state.js'
import type { SessionEventId } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { record } from '../agent/validation.js'
import type { SubagentState, SubagentControlState, SubagentRecoveryState, SubagentResourceState } from './state.js'

type Values<T> = { values(): IterableIterator<T> }
type Facts = { readonly [K in Exclude<keyof SubagentState, 'bound' | 'ready' | 'resources' | 'controls' | 'recoveries'>]: Values<SubagentState[K][number]> } & {
  readonly resources: Values<SubagentResourceState>; readonly controls: Values<SubagentControlState>; readonly recoveries: Values<SubagentRecoveryState>
}
export interface DelegationClosureSource {
  readonly subagents: Facts
  readonly inputs: Values<AgentInputState>
  readonly turns: Values<AgentTurnState>
}
export interface DelegationClosure {
  readonly businessResolved: boolean
  readonly executionReleased: boolean
  readonly adopted: boolean
  readonly inputDisposed: boolean
  readonly closed: boolean
}

/** Parent business completion and complete transport/resource closure are distinct predicates. */
export function delegationClosure(state: DelegationClosureSource, delegation: SessionEventId,
  sources: Iterable<CommittedSessionEvent>): DelegationClosure {
  const subagents = state.subagents
  const events = [...sources]
  const provision = [...subagents.provisions.values()].find(item => item.payload.delegation === delegation)?.payload
  const observed = [...subagents.observations.values()].filter(item => item.payload.delegation === delegation).at(-1)?.payload
  const failedBeforeExecution = provision?.outcome === 'failed' && ['not-needed', 'released'].includes(provision.cleanup)
  const inputs = [...state.inputs.values()].filter(item => item.protocol?.delegation === delegation)
  const results = inputs.filter(item => ['result', 'failure'].includes(item.protocol!.kind))
  const result = results.find(item => item.protocol?.kind === 'result')?.message
  const businessResolved = failedBeforeExecution || result != null || observed !== undefined && observed.business.kind !== 'pending'
  const executionReleased = failedBeforeExecution || observed?.business.kind === 'not-started' && observed.resources.every(item => item.outcome === 'released') || result != null && record(record(result.payload).executionRelease).outcome === 'released'
    || observed !== undefined && observed.resources.some(item => item.component === 'execution') && observed.resources.filter(item => item.component === 'execution').every(item => item.outcome === 'released')
  const adopted = results.some(item => item.claimedBy !== null)
  const inputDisposed = results.length > 0 && results.every(item => item.claimedBy !== null || ['handled', 'abandoned', 'not-adopted'].includes(item.status))
  const parentProtocolClosed = protocolSettled(subagents, delegation, events)
  const localResourcesClosed = [...subagents.resources.values()].filter(item => item.opened.payload.delegation === delegation).every(item => effectiveResourceRelease(item, subagents.recoveries.values())?.outcome === 'released')
  const childClosed = failedBeforeExecution || observed !== undefined && observed.resources.every(item => item.outcome === 'released')
    && Object.values(observed.protocol).every(count => count === 0)
  const inputsClosed = inputs.every(item => item.claimedBy !== null || ['handled', 'abandoned', 'not-adopted'].includes(item.status))
  const controlsClosed = [...subagents.controls.values()].filter(item => item.requested.payload.delegation === delegation).every(item => item.settled !== null)
  return { businessResolved, executionReleased, adopted, inputDisposed,
    closed: businessResolved && executionReleased && inputDisposed && parentProtocolClosed && localResourcesClosed && childClosed && inputsClosed && controlsClosed }
}

/** One intent is settled only by its keyed Outbox terminal or a validated permanent failure. */
export function protocolSettled(subagents: Pick<Facts, 'protocol' | 'failures'>, delegation: SessionEventId, events: readonly CommittedSessionEvent[]): boolean {
  const failures = [...subagents.failures.values()]
  const intents = [...subagents.protocol.values()].filter(item => item.payload.delegation === delegation)
  if (!intents.every(intent => {
    if (failures.some(item => item.payload.protocol === intent.stored.eventId)) return true
    const outbox = events.find(item => item.stored.type === 'communication/outbox-accepted' && item.stored.payloadVersion === 2 && record(record(item.payload).sendKey).eventId === intent.stored.eventId)
    if (outbox === undefined) return false
    const messageId = record(record(outbox.payload).envelope).messageId
    return events.some(item => ['communication/outbox-delivered', 'communication/outbox-rejected', 'communication/outbox-abandoned'].includes(item.stored.type)
      && record(item.payload).messageId === messageId)
  })) return false
  const inbox = events.filter(item => item.stored.type === 'communication/inbox-accepted' && String(record(record(item.payload).envelope).type).startsWith('subagent/')
    && record(record(record(item.payload).envelope).payload).delegation === delegation)
  return inbox.every(item => events.some(terminal => ['communication/inbox-processed', 'communication/inbox-abandoned'].includes(terminal.stored.type)
    && record(terminal.payload).messageId === record(record(item.payload).envelope).messageId))
}

/** Session end requires every local generation and retained delegation obligation to be settled. */
export function sessionDelegationsClosed(state: DelegationClosureSource & { readonly subagents: Facts & { readonly bound: SubagentState['bound'] } },
  events: readonly CommittedSessionEvent[]): boolean {
  if (![...state.subagents.delegations.values()].every(item => delegationClosure(state, item.stored.eventId, events).closed)) return false
  const bound = state.subagents.bound
  if (bound === null) return true
  return [...state.subagents.resources.values()].every(item => effectiveResourceRelease(item, state.subagents.recoveries.values())?.outcome === 'released')
    && [...state.subagents.controls.values()].every(item => item.settled !== null)
    && protocolSettled(state.subagents, bound.payload.delegation, events)
}
