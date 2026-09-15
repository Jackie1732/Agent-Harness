import type { JsonValue } from '../foundation/json.js'
import type { SessionEventId } from '../session/ids.js'
import type { ContextCompaction, ContextCompactionAlgorithm, ContextCompactionLeaf, ContextCompactionResult, ContextCut, ContextHistorySelection, ContextLoss, ContextProfile, ContextUnitReference } from './contract.js'
import { invalidSource } from './errors.js'
import { dataNote, renderUnit, unitRepresentation, withoutContinuation } from './render.js'
import type { ContextUnit } from './unit.js'
import { sourceContent, unitDigest } from './unit.js'
import { canonicalText, digest, jsonBytes } from './validation.js'

/** UTF-8 ranges always end between Unicode code points; malformed UTF-16 is not silently repaired. */
export function excerptUtf8(value: string, maximum: number): { readonly text: string; readonly originalBytes: number; readonly endByte: number } {
  if (!Number.isSafeInteger(maximum) || maximum < 0) invalidSource('excerpt-limit')
  for (const point of value) {
    const first = point.charCodeAt(0)
    if (point.length === 1 && first >= 0xd800 && first <= 0xdfff) invalidSource('ill-formed-text-compaction')
  }
  const bytes = Buffer.from(value, 'utf8')
  let end = Math.min(bytes.length, maximum)
  while (end > 0 && end < bytes.length) {
    const next = bytes[end]
    if (next === undefined || (next & 0xc0) !== 0x80) break
    end--
  }
  return Object.freeze({ text: bytes.subarray(0, end).toString('utf8'), originalBytes: bytes.length, endByte: end })
}
export function compactionBodyText(unit: ContextUnit): string {
  // Capsules are never moved into ordinary summary prose. Their identities remain structural metadata.
  if (unit.reference.selector === 'tool-exchange') return canonicalText(withoutContinuation(unit.rawMessages))
  return typeof unit.body === 'string' ? unit.body : canonicalText(unit.body)
}
export function compactionLeaf(unit: ContextUnit): ContextCompactionLeaf {
  if (!unit.compactable || unit.metadata.kind === 'compacted-history') invalidSource('non-leaf-compaction')
  return { reference: unit.reference, sourceEventIds: unit.sourceEventIds, sourceDigest: unitDigest(unit), metadata: unit.metadata }
}
export function compactedMetadata(value: ContextCompaction): Extract<import('./contract.js').ContextUnitMetadata, { kind: 'compacted-history' }> {
  return { kind: 'compacted-history', algorithm: value.algorithm.name, leafReferences: value.leaves.map(leaf => leaf.reference),
    losses: value.losses, structures: value.leaves.map(leaf => leaf.metadata), continuationPolicy: 'not-carried' }
}
/** The note cites original leaves rather than guessing the future Compaction EventId. */
export function renderCompaction(value: ContextCompaction) {
  return dataNote('compacted-history', value.leaves.map(leaf => leaf.reference), compactedMetadata(value), value.summary)
}
export function compactionRenderedBytes(value: ContextCompaction): number { return jsonBytes([renderCompaction(value)]) }
export function originalRenderedBytes(units: readonly ContextUnit[], history: ContextHistorySelection): number {
  return jsonBytes(units.flatMap(unit => renderUnit(unit, unitRepresentation(unit, history.representation))))
}
export function compactionSourceDigest(units: readonly ContextUnit[]): string { return digest(units.map(sourceContent)) }

export interface CompactionBase {
  readonly cut: ContextCut
  readonly profileEventId: SessionEventId
  readonly profile: ContextProfile
  readonly history: ContextHistorySelection
  readonly units: readonly ContextUnit[]
  readonly protectedRefs: readonly ContextUnitReference[]
}
export function finishCompaction(base: CompactionBase, algorithm: ContextCompactionAlgorithm, summary: string, losses: readonly ContextLoss[]): ContextCompactionResult {
  if (summary.trim().length === 0) invalidSource('empty-summary')
  const candidate: ContextCompaction = { coverage: base.cut.coverage, profileEventId: base.profileEventId,
    history: base.history, leaves: base.units.map(compactionLeaf), protectedRefs: base.protectedRefs, algorithm,
    rendererVersion: 'context-neutral/v1', summary, losses, sourceDigest: compactionSourceDigest(base.units),
    originalRenderedBytes: originalRenderedBytes(base.units, base.history), compactedRenderedBytes: 0 }
  const size = compactionRenderedBytes(candidate)
  const maximum = Math.min(base.profile.budget.maxRequestBytes, 8 * 1024 * 1024)
  if (size > maximum) return { kind: 'too-large', maximum }
  const originalBytes = candidate.originalRenderedBytes
  if (size >= originalBytes || originalBytes - size < base.profile.budget.minSavingsBytes) {
    return { kind: 'not-beneficial', originalBytes, compactedBytes: size, minSavingsBytes: base.profile.budget.minSavingsBytes }
  }
  return { kind: 'ready', compaction: { ...candidate, compactedRenderedBytes: size } }
}
/** Rule baseline is pure, deterministic, and incapable of starting a Model or Tool. */
export function excerptHistory(base: CompactionBase, maxExcerptBytes: number): ContextCompactionResult {
  const losses: ContextLoss[] = []
  const parts: JsonValue[] = []
  for (const unit of base.units) {
    const original = compactionBodyText(unit)
    const excerpt = excerptUtf8(original, maxExcerptBytes)
    const hasProtocolLoss = unit.reference.selector === 'tool-exchange'
      || unit.rawMessages.some(message => message.role === 'assistant' && message.continuation !== undefined)
    losses.push(excerpt.endByte === 0 ? { kind: 'structured-only', reference: unit.reference }
      : excerpt.endByte === excerpt.originalBytes && !hasProtocolLoss ? { kind: 'verbatim', reference: unit.reference }
      : { kind: 'excerpt', reference: unit.reference, fromByte: 0, endByte: excerpt.endByte,
        originalBytes: excerpt.originalBytes, omittedBytes: excerpt.originalBytes - excerpt.endByte })
    parts.push({ source: unit.reference, excerpt: excerpt.text })
  }
  return finishCompaction(base, { kind: 'excerpt', name: 'excerpt-history/v1', maxExcerptBytes }, canonicalText(parts), losses)
}
export function asCompactionUnit(eventId: SessionEventId, value: ContextCompaction, units: readonly ContextUnit[]): ContextUnit {
  const anchor = units.at(-1)
  if (anchor === undefined) invalidSource('empty-compaction-leaves')
  const metadata = compactedMetadata(value)
  return { reference: { eventId, selector: 'compacted-history' }, sourceEventIds: [eventId, ...new Set(value.leaves.flatMap(leaf => leaf.sourceEventIds))],
    // A noncontiguous source set replaces its leaves at the last covered closure position.
    segmentOrdinal: anchor.segmentOrdinal, closureSequence: anchor.closureSequence, metadata, body: value.summary,
    canonicalSource: value, rawMessages: [renderCompaction(value)], optionalHistory: true, compactable: false }
}
