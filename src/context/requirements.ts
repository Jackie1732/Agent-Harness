import type { JsonValue } from '../foundation/json.js'
import type { ContextCapturedFacts, ContextDeferredInbox, ContextPendingOutbox, ContextProfile, ContextSelectionSpec, ContextUnitReference, ContextBuildFailure } from './contract.js'
import { invalidSource } from './errors.js'
import type { ContextFacts } from './history.js'
import { historyOrdinals, messageKinds, resolveUnit } from './history.js'
import { activeMemoryReferences } from './references.js'
import { compareUnits } from './unit.js'
import type { ContextUnit } from './unit.js'
import { equalJson, sourceKey } from './validation.js'

export interface ContextRequirements {
  readonly units: readonly ContextUnit[]
  readonly references: readonly ContextUnitReference[]
  readonly deferred: readonly ContextDeferredInbox[]
  readonly pendingOutbox: readonly ContextPendingOutbox[]
  readonly allowedOrdinals: ReadonlySet<number>
}
/** Validate exactly the observations used by this cut; no unrelated plugin state enters an Assembly. */
export function capturedSurfaceBlock(facts: ContextFacts, profile: ContextProfile, captured: ContextCapturedFacts): Extract<ContextBuildFailure, { kind: 'blocked' }> | undefined {
  const names = captured.tools.map(tool => tool.definition.name)
  if (names.some(name => !profile.toolNames.includes(name))) invalidSource('unrequested-tool-surface')
  if (profile.toolNames.some(name => !names.includes(name))) return { kind: 'blocked', reason: 'tool-unavailable', references: [] }
  if (!equalJson(names, profile.toolNames)) invalidSource('tool-surface-order')
  if (!equalJson(messageKinds(facts), captured.messageSupport.map(item => ({ type: item.type, payloadVersion: item.payloadVersion })))) invalidSource('message-support-observation-set')
  return undefined
}
/** Every pending Inbox has one explicit disposition. This function performs no communication write. */
export function resolveRequirements(facts: ContextFacts, profile: ContextProfile, selection: ContextSelectionSpec, captured: ContextCapturedFacts): ContextRequirements | Extract<ContextBuildFailure, { kind: 'blocked' }> {
  const allowedOrdinals = historyOrdinals(facts, profile, selection.history)
  const localOrdinal = facts.segments.length - 1
  const input: ContextUnit[] = []
  const inbox: ContextUnit[] = []
  const other: ContextUnit[] = []
  const activeMemory = activeMemoryReferences(facts)
  const selected = new Set<string>()
  const take = (ref: ContextUnitReference, selectors: readonly string[], destination: ContextUnit[], localOnly = false): void => {
    if (!selectors.includes(ref.selector)) invalidSource('required-selector')
    const unit = resolveUnit(facts, ref)
    if (!allowedOrdinals.has(unit.segmentOrdinal) || localOnly && unit.segmentOrdinal !== localOrdinal) invalidSource('required-source-scope')
    if (selected.has(sourceKey(ref))) invalidSource('duplicate-required-unit')
    selected.add(sourceKey(ref)); destination.push(unit)
  }
  for (const ref of selection.requiredInputs) take(ref, ['user-input'], input)
  for (const ref of selection.observations) take(ref, ['legacy', 'diagnostic', 'tool-observation'], other)
  for (const ref of selection.memory.required) {
    if (!activeMemory.has(sourceKey(ref))) invalidSource('inactive-memory-pin')
    take(ref, ['memory'], other, true)
  }
  for (const ref of selection.outboxPayloads) take(ref, ['outbox-message'], other, true)
  const pending = facts.local.communication.inbox.filter(item => item.status === 'pending')
  if (pending.length !== selection.inbox.length) invalidSource('pending-inbox-disposition-count')
  const deferred: ContextDeferredInbox[] = []
  for (const decision of selection.inbox) {
    const item = pending.find(item => item.messageId === decision.messageId)
    if (item === undefined) invalidSource('inbox-disposition-not-pending')
    const e = item.envelope
    if (decision.action === 'defer') {
      deferred.push({ messageId: item.messageId, acceptedEventId: item.acceptedEventId, sender: e.sender, recipient: e.recipient,
        channelId: e.channelId, channelSequence: e.channelSequence, correlationId: e.correlationId,
        causationId: e.causationId ?? null, replyTo: e.replyTo ?? null, status: 'pending', reason: 'not-selected-this-assembly' })
    } else {
      const support = captured.messageSupport.find(observation => observation.type === e.type && observation.payloadVersion === e.payloadVersion)
      if (support?.supported !== true) return { kind: 'blocked', reason: 'unsupported-message', references: [{ eventId: item.acceptedEventId, selector: 'peer-message' }] }
      take({ eventId: item.acceptedEventId, selector: 'peer-message' }, ['peer-message'], inbox, true)
    }
  }
  const previouslyUnknown = new Set<string>()
  const localHistory = facts.local.snapshot.history.at(-1)
  if (localHistory === undefined) invalidSource('empty-history')
  for (const event of localHistory.events) {
    if (event.kind !== 'known' || event.stored.type !== 'communication/outbox-attempt-failed' || event.stored.payloadVersion !== 1) continue
    const payload = event.payload
    if (payload !== null && !Array.isArray(payload) && typeof payload === 'object') {
      const object = payload as Readonly<Record<string, JsonValue>>
      if ((object.code === 'transport-outcome-unknown' || object.code === 'receiver-outcome-unknown')
        && typeof object.messageId === 'string') previouslyUnknown.add(object.messageId)
    }
  }
  const pendingOutbox: ContextPendingOutbox[] = facts.local.communication.outbox.filter(item => item.status === 'pending').map(item => {
    const e = item.envelope
    return { messageId: item.messageId, acceptedEventId: item.acceptedEventId, recipient: e.recipient, channelId: e.channelId,
      channelSequence: e.channelSequence, correlationId: e.correlationId, causationId: e.causationId ?? null, replyTo: e.replyTo ?? null,
      attemptCount: item.attemptCount, openAttempt: item.openAttempt ?? null, lastFailure: item.lastFailure?.code ?? null,
      outcomeUnknown: item.openAttempt !== undefined || previouslyUnknown.has(item.messageId) }
  })
  const units = [...input.sort(compareUnits), ...inbox.sort(compareUnits), ...other.sort(compareUnits)]
  deferred.sort((a, b) => resolveUnit(facts, { eventId: a.acceptedEventId, selector: 'peer-message' }).closureSequence
    - resolveUnit(facts, { eventId: b.acceptedEventId, selector: 'peer-message' }).closureSequence)
  return { units, references: units.map(unit => unit.reference), deferred, pendingOutbox, allowedOrdinals }
}
