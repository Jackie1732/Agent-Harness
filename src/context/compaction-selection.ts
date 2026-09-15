import type { ContextCompaction, ContextHistorySelection, ContextProfile, ContextUnitReference } from './contract.js'
import { invalidSource } from './errors.js'
import type { ContextFacts } from './history.js'
import { historyOrdinals, resolveUnit } from './history.js'
import { assertSourceReference } from './references.js'
import { compareUnits } from './unit.js'
import type { ContextUnit } from './unit.js'
import { equalJson, sourceKey } from './validation.js'

/** Exact closed leaves, never a numeric interval, summary-of-summary, or protected work. */
export function resolveCompactionLeaves(facts: ContextFacts, profile: ContextProfile, history: ContextHistorySelection,
  references: readonly ContextUnitReference[], protectedRefs: readonly ContextUnitReference[]): readonly ContextUnit[] {
  if (references.length === 0) invalidSource('empty-compaction-leaves')
  const allowed = historyOrdinals(facts, profile, history)
  const protectedEvents = new Set<string>()
  for (const ref of protectedRefs) {
    assertSourceReference(facts, ref)
    const unit = resolveUnit(facts, ref)
    protectedEvents.add(ref.eventId)
    for (const eventId of unit.sourceEventIds) protectedEvents.add(eventId)
  }
  const keys = new Set<string>()
  const leaves = references.map(ref => {
    const key = sourceKey(ref)
    if (keys.has(key)) invalidSource('duplicate-compaction-leaf')
    keys.add(key)
    const unit = resolveUnit(facts, ref)
    if (!allowed.has(unit.segmentOrdinal) || !unit.compactable
      || unit.sourceEventIds.some(eventId => protectedEvents.has(eventId))) invalidSource('protected-or-unclosed-compaction-leaf')
    return unit
  })
  const sorted = [...leaves].sort(compareUnits)
  if (!equalJson(sorted.map(unit => unit.reference), references)) invalidSource('compaction-leaf-order')
  return Object.freeze(leaves)
}
export interface ResolvedCompaction {
  readonly value: ContextCompaction
  readonly leaves: readonly ContextUnit[]
  readonly unit: ContextUnit
}
/** Across selected summaries, original membership can be consumed at most once. */
export function assertUnambiguousCompactions(compactions: readonly ResolvedCompaction[]): void {
  const leaves = new Set<string>()
  for (const item of compactions) for (const leaf of item.leaves) {
    const key = sourceKey(leaf.reference)
    if (leaves.has(key)) invalidSource('ambiguous-compaction')
    leaves.add(key)
  }
}
