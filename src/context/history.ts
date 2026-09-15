import { projectCommunicationFacts } from '../communication/projection.js'
import type { CommunicationFacts } from '../communication/types.js'
import { projectModelSession } from '../model/projection.js'
import type { ModelSessionSnapshot } from '../model/projection.js'
import type { ModelIntentReference, ModelInputMessage } from '../model/contract.js'
import type { SessionEventId } from '../session/ids.js'
import type { SessionSnapshot } from '../session/types.js'
import { projectToolSession } from '../tool/projection.js'
import type { ToolSessionSnapshot } from '../tool/projection.js'
import type { ContextBuildFailure, ContextBudgetLimits, ContextHistorySelection, ContextProfile, ContextUnitReference } from './contract.js'
import { communicationHistoryUnits } from './communication-history.js'
import { invalidSource, invalidState } from './errors.js'
import { projectMaterials } from './material-state.js'
import type { ContextMaterialState } from './material-state.js'
import { modelHistoryUnits } from './model-history.js'
import { precedingContextAssembly } from './model-link.js'
import { dataNote, withoutContinuation } from './render.js'
import { segmentSnapshot } from './sources.js'
import type { SourceIndex, SourceLimitResult } from './sources.js'
import { compareUnits } from './unit.js'
import type { ContextUnit } from './unit.js'
import { compareText, equalJson, sourceKey } from './validation.js'

export interface SegmentFacts {
  readonly snapshot: SessionSnapshot
  readonly material: ContextMaterialState
  readonly models: ModelSessionSnapshot
  readonly tools: ToolSessionSnapshot
  readonly communication: CommunicationFacts
}
export interface ContextFacts {
  readonly index: SourceIndex
  readonly segments: readonly SegmentFacts[]
  readonly local: SegmentFacts
  readonly units: readonly ContextUnit[]
  readonly byReference: ReadonlyMap<string, ContextUnit>
  readonly pending: readonly ContextUnitReference[]
  readonly missingExchanges: readonly ContextUnitReference[]
  readonly missingIntents: readonly ModelIntentReference[]
}

/** Domain projectors retain their own validation and local-ownership rules. */
export function collectContextFacts(index: SourceIndex, limits: Pick<ContextBudgetLimits, 'maxUnits'>): ContextFacts | SourceLimitResult {
  const segments: SegmentFacts[] = []
  const units: ContextUnit[] = []
  const pending: ContextUnitReference[] = []
  let missingExchanges: readonly ContextUnitReference[] = []
  let missingIntents: readonly ModelIntentReference[] = []
  const add = (unit: ContextUnit): boolean => {
    if (units.length >= limits.maxUnits) return false
    units.push(unit); return true
  }
  for (let ordinal = 0; ordinal < index.snapshot.history.length; ordinal++) {
    const snapshot = segmentSnapshot(index.snapshot, ordinal)
    const part = { ...index, snapshot, coverage: index.coverage.slice(0, ordinal + 1) }
    let facts: SegmentFacts
    try {
      facts = { snapshot, material: projectMaterials(part), models: projectModelSession(snapshot),
        tools: projectToolSession(snapshot), communication: projectCommunicationFacts(snapshot) }
    } catch (reason) {
      // Do not expose arbitrary payloads or provider/plugin diagnostics through Context errors.
      if (reason instanceof Error && reason.name === 'ContextError') throw reason
      invalidState('domain-history')
    }
    segments.push(facts)
    const summaryInvocations = new Set(facts.models.invocations.filter(model => precedingContextAssembly(snapshot, model.prepared)?.payload.purpose === 'compaction').map(model => model.invocationId))
    const modelUnits = modelHistoryUnits(snapshot, facts.models, facts.tools, ordinal, summaryInvocations)
    if (ordinal === index.snapshot.history.length - 1) {
      missingExchanges = modelUnits.missing
      missingIntents = modelUnits.missingIntents
      for (const model of facts.models.invocations) if (model.state !== 'settled') {
        pending.push({ eventId: model.prepared.stored.eventId, selector: 'diagnostic' })
      }
      for (const tool of facts.tools.invocations) if (tool.state !== 'settled') {
        pending.push({ eventId: tool.requested.stored.eventId, selector: 'tool-observation' })
      }
    }
    for (const unit of modelUnits.units) if (!add(unit)) return unitLimit(limits.maxUnits)
    for (const unit of communicationHistoryUnits(facts.communication, ordinal)) if (!add(unit)) return unitLimit(limits.maxUnits)
    for (const event of facts.material.inputs) {
      const reference = { eventId: event.stored.eventId, selector: event.payload.kind === 'user' ? 'user-input' as const : 'legacy' as const }
      const payload = event.payload
      let unit: ContextUnit
      if (payload.kind === 'user') {
        const metadata = { kind: 'user-input' as const, origin: payload.origin, originLabel: payload.originLabel }
        const message: ModelInputMessage = { role: 'user', content: [{ kind: 'text', text: payload.text }] }
        unit = { reference, sourceEventIds: [event.stored.eventId], segmentOrdinal: ordinal,
          closureSequence: event.stored.sequence, metadata, body: payload.text, canonicalSource: payload,
          rawMessages: [message], optionalHistory: true, compactable: true }
      } else {
        const original = segments.flatMap(segment => segment.models.invocations).find(model => model.prepared.stored.eventId === payload.preparedEventId)
        if (original === undefined || payload.toMessage > original.prepared.payload.submission.request.messages.length) invalidSource('legacy-message-range')
        const selected = original.prepared.payload.submission.request.messages.slice(payload.fromMessage, payload.toMessage)
        const metadata = { kind: 'legacy' as const, preparedEventId: payload.preparedEventId, fromMessage: payload.fromMessage,
          toMessage: payload.toMessage, omitted: ['instructions', 'continuation-text'] as const }
        const body = withoutContinuation(selected)
        unit = { reference, sourceEventIds: [payload.preparedEventId, event.stored.eventId], segmentOrdinal: ordinal,
          closureSequence: event.stored.sequence, metadata, body,
          canonicalSource: { input: payload, originalRequest: original.prepared.payload.submission.request },
          rawMessages: [dataNote('legacy', reference, metadata, body)], optionalHistory: false, compactable: false }
      }
      if (!add(unit)) return unitLimit(limits.maxUnits)
    }
    // Historical revisions remain resolvable evidence, but only local active heads are eligible memory.
    for (const event of facts.material.memoryRevisions) {
      const reference = { eventId: event.stored.eventId, selector: 'memory' as const }
      const metadata = { kind: 'memory' as const, key: event.payload.key, tags: event.payload.tags, origin: event.payload.origin }
      if (!add({ reference, sourceEventIds: [event.stored.eventId], segmentOrdinal: ordinal, closureSequence: event.stored.sequence,
        metadata, body: event.payload.text, canonicalSource: event.payload,
        rawMessages: [dataNote('memory', reference, metadata, event.payload.text)], optionalHistory: false, compactable: false })) return unitLimit(limits.maxUnits)
    }
  }
  units.sort(compareUnits)
  const byReference = new Map<string, ContextUnit>()
  for (const unit of units) {
    const key = sourceKey(unit.reference)
    if (byReference.has(key)) invalidState('unit-identity')
    byReference.set(key, Object.freeze(unit))
  }
  const local = segments.at(-1)
  if (local === undefined) invalidSource('empty-history')
  return Object.freeze({ index, segments: Object.freeze(segments), local,
    units: Object.freeze(units), byReference, pending: Object.freeze(pending), missingExchanges, missingIntents })
}
function unitLimit(maximum: number): SourceLimitResult { return { kind: 'resource-limit', limit: 'units', maximum } }
export function resolveUnit(facts: ContextFacts, ref: ContextUnitReference): ContextUnit {
  const unit = facts.byReference.get(sourceKey(ref))
  if (unit === undefined) invalidSource('unit-not-visible-or-not-closed')
  return unit
}
export function historyOrdinals(facts: ContextFacts, profile: ContextProfile, selection: ContextHistorySelection): ReadonlySet<number> {
  const localOrdinal = facts.segments.length - 1
  const ordinals = new Set<number>([localOrdinal])
  if (selection.mode === 'lineage-suffix') {
    if (profile.historyScope !== 'allow-lineage') invalidSource('lineage-not-permitted')
    let previous = -1
    for (const id of selection.ancestorSessionIds) {
      const ordinal = facts.segments.findIndex(segment => segment.snapshot.header.sessionId === id)
      if (ordinal <= previous || ordinal >= localOrdinal || ordinal < 0) invalidSource('ancestor-selection-order')
      ordinals.add(ordinal); previous = ordinal
    }
  }
  return ordinals
}
export function assertLocalProfile(facts: ContextFacts, id: SessionEventId, profile: ContextProfile): void {
  const event = facts.local.material.profiles.find(item => item.stored.eventId === id)
  if (event === undefined || !equalJson(event.payload, profile)) invalidSource('profile-pin')
}
/** Rendering obligations are separate from transport processing and resource ownership. */
export function executionBlock(facts: ContextFacts): Extract<ContextBuildFailure, { kind: 'blocked' }> | undefined {
  if (facts.pending.length > 0) return { kind: 'blocked', reason: 'unsettled-execution', references: facts.pending }
  if (facts.missingExchanges.length > 0) return { kind: 'blocked', reason: 'incomplete-tool-exchange',
    references: facts.missingExchanges, missingIntents: facts.missingIntents }
  return undefined
}
/** Only current pending Inbox kinds need a live decoder observation for include-full. */
export function messageKinds(facts: ContextFacts): readonly { type: string; payloadVersion: number }[] {
  const kinds = new Map<string, { type: string; payloadVersion: number }>()
  for (const item of facts.local.communication.inbox) {
    if (item.status !== 'pending') continue
    const { type, payloadVersion } = item.envelope
    kinds.set(`${type}@${payloadVersion}`, { type, payloadVersion })
  }
  return Object.freeze([...kinds.values()].sort((a, b) => compareText(a.type, b.type) || a.payloadVersion - b.payloadVersion))
}
