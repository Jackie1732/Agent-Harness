import type { ContextMemoryCandidate, ContextMemoryHead, ContextMemoryQuery, ContextMemoryRecord, ContextMemoryRetraction, MemoryOrigin } from './contract.js'
import { invalidContext } from './errors.js'
import { array, choice, compareText, contextJson, eventId, exact, identifier, integer, previous, record, sourceKey, sourceReference, tags, text, textReference, unique } from './validation.js'

export function decodeContextMemory(value: unknown): ContextMemoryRecord {
  const input = record(contextJson(value)); exact(input, ['key', 'previousEventId', 'text', 'tags', 'origin'])
  identifier(input.key); previous(input.previousEventId); text(input.text); tags(input.tags)
  decodeMemoryOrigin(input.origin)
  return input as ContextMemoryRecord
}
export function decodeMemoryOrigin(value: unknown): MemoryOrigin {
  const origin = record(value)
  switch (choice(origin.kind, ['host-authored', 'host-import', 'verbatim', 'ancestor-adopted'])) {
    case 'host-authored': case 'host-import': {
      exact(origin, ['kind', 'originLabel', 'relatedTo']); text(origin.originLabel, 128)
      const refs = array(origin.relatedTo, 128).map(sourceReference); unique(refs.map(sourceKey))
      break
    }
    case 'verbatim': case 'ancestor-adopted': exact(origin, ['kind', 'source']); textReference(origin.source); break
  }
  return origin as MemoryOrigin
}
export function decodeMemoryRetraction(value: unknown): ContextMemoryRetraction {
  const input = record(contextJson(value)); exact(input, ['key', 'previousEventId', 'reasonCode'])
  identifier(input.key); eventId(input.previousEventId); choice(input.reasonCode, ['caller-requested', 'superseded', 'incorrect'])
  return input as ContextMemoryRetraction
}
export function decodeMemoryQuery(value: unknown): ContextMemoryQuery {
  const input = record(contextJson(value, 16384)); exact(input, ['requiredTags', 'queryTags', 'topK'])
  tags(input.requiredTags); tags(input.queryTags); integer(input.topK, 0, 10000)
  return input as ContextMemoryQuery
}
export type ContextMemorySearchCandidate = ContextMemoryCandidate & { readonly text: string }

/** session-tags/v1: stable ranking over local active revisions, never a remote search. */
export function retrieveSessionMemory(
  heads: readonly ContextMemoryHead[], queryInput: ContextMemoryQuery,
): readonly ContextMemorySearchCandidate[] {
  const query = decodeMemoryQuery(queryInput)
  if (query.topK === 0) return Object.freeze([])
  const keys = new Set<string>()
  const matches: { key: string; record: NonNullable<ContextMemoryHead['record']>; score: number; matchedTags: readonly string[] }[] = []
  for (const head of heads) {
    if (keys.has(head.key)) invalidContext('memory-head-duplicate')
    keys.add(head.key)
    if (head.record === null) continue
    const record = head.record.payload
    if (!query.requiredTags.every(tag => record.tags.includes(tag))) continue
    const matchedTags = query.queryTags.filter(tag => record.tags.includes(tag))
    matches.push({ key: head.key, record: head.record, score: matchedTags.length, matchedTags })
  }
  matches.sort((a, b) => b.score - a.score || b.record.stored.sequence - a.record.stored.sequence || compareText(a.key, b.key))
  return Object.freeze(matches.map((candidate, rank) => Object.freeze({
    reference: Object.freeze({ eventId: candidate.record.stored.eventId, selector: 'memory' as const }),
    key: candidate.key, score: candidate.score, matchedTags: Object.freeze([...candidate.matchedTags]),
    rank, withinTopK: rank < query.topK, text: candidate.record.payload.text,
  })))
}
