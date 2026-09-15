import type { JsonValue } from '../foundation/json.js'
import type { SessionEventId } from '../session/ids.js'
import { parseSessionEventId } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { ContextAssembly, ContextCompaction, ContextInput, ContextMemoryHead, ContextMemoryRecord, ContextProfile, ContextSourceReference } from './contract.js'
import { ContextError, invalidSource, invalidState } from './errors.js'
import { contextAssemblyCommittedEvent, contextCompactionCommittedEvent, contextInputRecordedEvent, contextMemoryRecordedEvent, contextMemoryRetractedEvent, contextProfileRecordedEvent, contextSessionEventDefinitions } from './session-events.js'
import { assertEventCut, knownEvent } from './sources.js'
import type { SourceIndex } from './sources.js'
import { compareText, equalJson } from './validation.js'

export interface ContextMaterialState {
  readonly profiles: readonly CommittedSessionEvent<ContextProfile>[]
  readonly profileHeads: ReadonlyMap<string, SessionEventId>
  readonly inputs: readonly CommittedSessionEvent<ContextInput>[]
  readonly memory: readonly ContextMemoryHead[]
  readonly memoryRevisions: readonly CommittedSessionEvent<ContextMemoryRecord>[]
  readonly compactions: readonly CommittedSessionEvent<ContextCompaction>[]
  readonly assemblies: readonly CommittedSessionEvent<ContextAssembly>[]
}

export function assertEarlier(index: SourceIndex, reference: SessionEventId, at: SessionEventId): void {
  knownEvent(index, reference)
  const source = parseSessionEventId(reference); const target = parseSessionEventId(at)
  const sourceOrdinal = index.snapshot.history.findIndex(segment => segment.header.sessionId === source.sessionId)
  const targetOrdinal = index.snapshot.history.findIndex(segment => segment.header.sessionId === target.sessionId)
  if (sourceOrdinal < 0 || sourceOrdinal > targetOrdinal || sourceOrdinal === targetOrdinal && source.sequence >= target.sequence) invalidSource('reference-not-earlier')
}
export function memoryReferences(payload: ContextMemoryRecord): readonly ContextSourceReference[] {
  switch (payload.origin.kind) {
    case 'host-authored':
    case 'host-import': return payload.origin.relatedTo
    case 'verbatim':
    case 'ancestor-adopted': return [payload.origin.source]
  }
}

/** Owns revision heads only. Domain outcome validation is performed once in the source adapters. */
export function projectMaterials(index: SourceIndex): ContextMaterialState {
  const profiles: CommittedSessionEvent<ContextProfile>[] = []
  const profileHeads = new Map<string, SessionEventId>()
  const inputs: CommittedSessionEvent<ContextInput>[] = []
  const memory = new Map<string, ContextMemoryHead>()
  const memoryRevisions: CommittedSessionEvent<ContextMemoryRecord>[] = []
  const compactions: CommittedSessionEvent<ContextCompaction>[] = []
  const assemblies: CommittedSessionEvent<ContextAssembly>[] = []
  const local = index.snapshot.history.at(-1)
  if (local === undefined) invalidSource('empty-history')
  for (const event of local.events) {
    if (!event.stored.type.startsWith('context/')) continue
    const definition = contextSessionEventDefinitions.find(item => item.type === event.stored.type && item.payloadVersion === event.stored.payloadVersion)
    if (definition === undefined) {
      if (event.kind === 'opaque' && event.stored.ignorable === true) continue
      invalidState('context-event-version')
    }
    if (event.kind !== 'known' || event.stored.ignorable === true) invalidState('context-event-version')
    let payload: JsonValue
    try {
      payload = definition.decode(event.payload)
      if (!equalJson(payload, event.payload) || !equalJson(payload, event.stored.payload)) invalidState('noncanonical-context-payload')
    } catch {
      throw new ContextError('CONTEXT_STATE_INVALID', 'context-payload', { eventId: event.stored.eventId })
    }
    const id = event.stored.eventId
    if (definition === contextProfileRecordedEvent) {
      const value = payload as ContextProfile
      if ((profileHeads.get(value.profileKey) ?? null) !== value.previousEventId) invalidState('profile-head')
      const committed = Object.freeze({ ...event, payload: value })
      profiles.push(committed); profileHeads.set(value.profileKey, id)
    } else if (definition === contextInputRecordedEvent) {
      const value = payload as ContextInput
      if (value.kind === 'legacy-model-input') assertEarlier(index, value.preparedEventId, id)
      inputs.push(Object.freeze({ ...event, payload: value }))
    } else if (definition === contextMemoryRecordedEvent) {
      const value = payload as ContextMemoryRecord
      if ((memory.get(value.key)?.headEventId ?? null) !== value.previousEventId) invalidState('memory-head')
      for (const ref of memoryReferences(value)) assertEarlier(index, ref.eventId, id)
      const committed = Object.freeze({ ...event, payload: value })
      memoryRevisions.push(committed)
      memory.set(value.key, Object.freeze({ key: value.key, headEventId: id, record: committed }))
    } else if (definition === contextMemoryRetractedEvent) {
      const value = contextMemoryRetractedEvent.decode(payload)
      const head = memory.get(value.key)
      if (head?.record === undefined || head.record === null || head.headEventId !== value.previousEventId) invalidState('memory-retraction-head')
      memory.set(value.key, Object.freeze({ key: value.key, headEventId: id, record: null }))
    } else if (definition === contextCompactionCommittedEvent) {
      const value = payload as ContextCompaction
      assertEventCut(index.snapshot, event, value.coverage); assertEarlier(index, value.profileEventId, id)
      for (const leaf of value.leaves) {
        assertEarlier(index, leaf.reference.eventId, id)
        for (const source of leaf.sourceEventIds) assertEarlier(index, source, id)
      }
      for (const ref of value.protectedRefs) assertEarlier(index, ref.eventId, id)
      if (value.algorithm.kind === 'model-text') {
        for (const source of [value.algorithm.assemblyEventId, value.algorithm.preparedEventId, value.algorithm.settledEventId]) assertEarlier(index, source, id)
      }
      compactions.push(Object.freeze({ ...event, payload: value }))
    } else if (definition === contextAssemblyCommittedEvent) {
      const value = payload as ContextAssembly
      assertEventCut(index.snapshot, event, value.coverage); assertEarlier(index, value.selection.profileEventId, id)
      for (const ref of [...value.required, ...value.selected.map(item => item.reference), ...value.omitted.map(item => item.reference)]) assertEarlier(index, ref.eventId, id)
      for (const selected of value.selected) for (const source of selected.sourceEventIds) assertEarlier(index, source, id)
      for (const source of value.selection.compactions) assertEarlier(index, source, id)
      for (const entry of value.provenance) {
        if (entry.source.kind === 'profile-section') assertEarlier(index, entry.source.eventId, id)
        if (entry.source.kind === 'unit') for (const source of entry.source.eventIds) assertEarlier(index, source, id)
      }
      assemblies.push(Object.freeze({ ...event, payload: value }))
    }
  }
  return Object.freeze({ profiles: Object.freeze(profiles), profileHeads, inputs: Object.freeze(inputs),
    memory: Object.freeze([...memory.values()].sort((a, b) => compareText(a.key, b.key))), memoryRevisions: Object.freeze(memoryRevisions),
    compactions: Object.freeze(compactions), assemblies: Object.freeze(assemblies) })
}
