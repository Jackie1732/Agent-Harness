import { inputKey } from '../agent/input-codec.js'
import type { AgentProjectionState } from '../agent/projection-state.js'
import { requireEntry } from '../agent/projection-state.js'
import { equal, record } from '../agent/validation.js'
import { formatSessionAddress, parseSessionEventId } from '../session/ids.js'
import type { SessionEventId } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { SubagentError } from './errors.js'
import { requireDelegationBinding } from './state.js'
import * as events from './session-events.js'
import { hasPendingLowerExecution } from './execution-evidence.js'
import { effectiveResourceRelease } from './resource-evidence.js'

/** Installation, public observations and controls never carry the other Agent's business text. */
export function applySubagentLifecycle(state: AgentProjectionState, event: CommittedSessionEvent): void {
  const p = record(event.payload)
  switch (event.stored.type) {
    case 'subagent/provision-settled': {
      const value = events.subagentProvisionSettledEvent.decode(p); const request = requireDelegationBinding(state.subagents, value)
      if (formatSessionAddress(event.stored.sessionId) !== value.parentAddress || state.subagents.provisions.has(value.delegation)) invalid('provision-owner')
      if (value.child !== null) {
        const refs = value.child
        Object.values(refs).forEach(id => childReference(id, request.childSessionId))
        if (!(sequence(refs.bound) < sequence(refs.profile) && sequence(refs.profile) < sequence(refs.spec) && sequence(refs.spec) < sequence(refs.ready)
          && sequence(refs.ready) < sequence(refs.execution) && sequence(refs.ready) < sequence(refs.protocol))) invalid('provision-install-order')
      }
      state.subagents.provisions.set(value.delegation, { ...event, payload: value })
      if (value.outcome === 'failed' && ['not-needed', 'released'].includes(value.cleanup)) localFailureInput(state, event, value.delegation)
      break
    }
    case 'subagent/delivery-failed': {
      const value = events.subagentDeliveryFailedEvent.decode(p); const request = requireDelegationBinding(state.subagents, value)
      const protocol = requireEntry(state.subagents.protocol, value.protocol, 'missing-failed-protocol')
      if (protocol.payload.delegation !== value.delegation || state.subagents.failures.has(value.protocol)) invalid('delivery-failure-owner')
      const outbox = [...state.sources.values()].find(item => item.stored.type === 'communication/outbox-accepted'
        && equal(record(item.payload).sendKey, { eventId: value.protocol, index: 0 }))
      if (value.failure === 'outbox-terminal') {
        const terminal = requireEntry(state.sources, value.terminal!, 'missing-delivery-terminal')
        if (outbox === undefined || !['communication/outbox-rejected', 'communication/outbox-abandoned'].includes(terminal.stored.type)
          || record(terminal.payload).messageId !== record(record(outbox.payload).envelope).messageId) invalid('delivery-terminal-mismatch')
      } else {
        if (outbox !== undefined) invalid('presend-failure-after-outbox')
        if (value.failure === 'cancelled-before-send' && state.roots.get(request.parentRoot)?.stopControl == null
          && ![...state.subagents.controls.values()].some(item => item.requested.payload.delegation === value.delegation)) invalid('presend-cancel-source')
      }
      state.subagents.failures.set(value.protocol, { ...event, payload: value })
      if (event.stored.sessionId === parseSessionEventId(value.delegation).sessionId) localFailureInput(state, event, value.delegation)
      break
    }
    case 'subagent/control-requested': {
      const value = events.subagentControlRequestedEvent.decode(p); requireDelegationBinding(state.subagents, value)
      if (state.subagents.bound?.payload.delegation !== value.delegation && !state.subagents.delegations.has(value.delegation)) invalid('control-owner')
      if (value.source.kind === 'parent-stop') childReference(value.source.eventId, parseSessionEventId(value.delegation).sessionId)
      if ([...state.subagents.controls.values()].some(item => equal(item.requested.payload.source, value.source))) invalid('duplicate-subagent-control')
      state.subagents.controls.set(event.stored.eventId, { requested: { ...event, payload: value }, settled: null }); break
    }
    case 'subagent/control-settled': {
      const value = events.subagentControlSettledEvent.decode(p); requireDelegationBinding(state.subagents, value)
      const control = requireEntry(state.subagents.controls, value.control, 'missing-subagent-control')
      if (control.settled !== null || control.requested.payload.delegation !== value.delegation) invalid('control-already-settled')
      if (state.subagents.delegations.has(value.delegation)) {
        const provision = state.subagents.provisions.get(value.delegation)?.payload
        if (provision?.outcome === 'failed' && ['not-needed', 'released'].includes(provision.cleanup) && value.business === 'not-started' && value.root === null && value.executionRelease === null) { control.settled = { ...event, payload: value }; break }
        const observed = [...state.subagents.observations.values()].filter(item => item.payload.delegation === value.delegation).at(-1)?.payload
        if (observed === undefined || observed.business.kind === 'pending' || value.business !== (observed.business.kind === 'terminal' ? 'terminal' : 'not-started')
          || value.root !== (observed.business.kind === 'terminal' ? observed.business.root : null)
          || value.executionRelease !== (observed.resources.filter(item => item.component === 'execution').at(-1)?.release ?? null)) invalid('parent-control-public-source')
        control.settled = { ...event, payload: value }; break
      }
      const root = [...state.roots.values()][0]
      if (value.business === 'not-started' ? root !== undefined : root?.id !== value.root || root.outcome === null) invalid('control-business-not-settled')
      if ([...state.inputs.values()].some(input => input.protocol?.delegation === value.delegation && ['queued', 'reserved', 'claimed'].includes(input.status))) invalid('control-pending-input')
      const resource = [...state.subagents.resources.values()].filter(item => item.opened.payload.component === 'execution').at(-1)
      const release = resource === undefined ? null : effectiveResourceRelease(resource, state.subagents.recoveries.values())
      if (value.executionRelease !== (release?.eventId ?? null) || resource !== undefined && release === null) invalid('control-execution-open')
      control.settled = { ...event, payload: value }; break
    }
    case 'subagent/settlement-observed': {
      const value = events.subagentSettlementObservedEvent.decode(p); const request = requireDelegationBinding(state.subagents, value)
      if (formatSessionAddress(event.stored.sessionId) !== value.parentAddress) invalid('observation-parent-owner')
      const refs = [...value.evidence, ...value.deliveryFailures, ...value.resources.flatMap(item => [item.opened, ...(item.release === null ? [] : [item.release])]),
        ...(value.business.kind === 'terminal' ? [value.business.root, value.business.terminal] : value.business.kind === 'not-started' ? [value.business.control] : [])]
      if (refs.length === 0 || refs.some(id => { childReference(id, request.childSessionId); return sequence(id) > value.childThrough })) invalid('observation-source-cut')
      const previous = [...state.subagents.observations.values()].filter(item => item.payload.delegation === value.delegation).at(-1)
      if (previous !== undefined && (previous.payload.childThrough > value.childThrough || equal(previous.payload, value))) invalid('observation-not-new')
      if (previous !== undefined && previous.payload.business.kind !== 'pending' && !equal(previous.payload.business, value.business)) invalid('observed-business-overwrite')
      state.subagents.observations.set(event.stored.eventId, { ...event, payload: value })
      if (value.business.kind === 'not-started' && previous?.payload.business.kind !== 'not-started' || value.deliveryFailures.length > 0 && (previous?.payload.deliveryFailures.length ?? 0) === 0) localFailureInput(state, event, value.delegation)
      break
    }
    case 'subagent/recovery-requested': {
      const value = events.subagentRecoveryRequestedEvent.decode(p); requireDelegationBinding(state.subagents, value)
      const open = [...state.subagents.recoveries.values()].filter(item => item.requested.payload.delegation === value.delegation && item.settled === null && item.supersededBy === null).at(-1)
      if (value.through !== event.stored.sequence - 1 || value.supersedes !== (open?.requested.stored.eventId ?? null)) invalid('subagent-recovery-cut')
      if (open !== undefined) open.supersededBy = event.stored.eventId
      state.subagents.recoveries.set(event.stored.eventId, { requested: { ...event, payload: value }, settled: null, supersededBy: null }); break
    }
    case 'subagent/recovery-settled': {
      const value = events.subagentRecoverySettledEvent.decode(p); requireDelegationBinding(state.subagents, value)
      const recovery = requireEntry(state.subagents.recoveries, value.recovery, 'missing-subagent-recovery')
      if (recovery.settled !== null || recovery.supersededBy !== null || recovery.requested.payload.delegation !== value.delegation
        || value.writes !== event.stored.sequence - recovery.requested.payload.through || value.writes > recovery.requested.payload.maxWrites) invalid('subagent-recovery-settlement')
      value.evidence.forEach(id => requireEntry(state.sources, id, 'missing-recovery-evidence'))
      if (value.outcome === 'complete' && (state.openRun !== null || state.openTurn !== null || state.openRecovery !== null
        || hasPendingLowerExecution(state.sources.values())
        || [...state.controls.values()].some(item => item.settled === null && item.supersededBy === null)
        || [...state.subagents.resources.values()].some(item => item.opened.payload.delegation === value.delegation
          && item.opened.stored.sequence <= recovery.requested.payload.through && !value.evidence.includes(item.opened.stored.eventId))
        || value.evidence.some(id => state.subagents.resources.get(id)?.opened.payload.delegation !== value.delegation
          || state.subagents.resources.get(id)!.opened.stored.sequence > recovery.requested.payload.through))) invalid('recovery-evidence-incomplete')
      recovery.settled = { ...event, payload: value }; break
    }
    default: invalid('unsupported-subagent-event')
  }
}
function localFailureInput(state: AgentProjectionState, event: CommittedSessionEvent, delegation: SessionEventId): void {
  if ([...state.inputs.values()].some(input => input.protocol?.delegation === delegation && input.protocol.kind === 'failure')) return
  const reference = { kind: 'subagent' as const, eventId: event.stored.eventId }
  state.inputs.set(inputKey(reference), { reference, protocol: { kind: 'failure', delegation, inbox: event.stored.eventId },
    input: null, message: null, acceptedAt: event.stored.recordedAt, sequence: event.stored.sequence,
    lane: 'subagent:' + delegation, status: 'queued', claimedBy: null, reservedBy: null, everMatched: false, reason: null })
}
function childReference(id: SessionEventId, sessionId: string): void { if (parseSessionEventId(id).sessionId !== sessionId) invalid('cross-session-reference') }
function sequence(id: SessionEventId): number { return parseSessionEventId(id).sequence }
function invalid(reason: string): never { throw new SubagentError('SUBAGENT_STATE_INVALID', reason) }
