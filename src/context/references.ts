import type { JsonValue } from '../foundation/json.js'
import { parseSessionEventId } from '../session/ids.js'
import type { SessionEventId } from '../session/ids.js'
import type { ContextMemoryRecord, ContextSourceReference, ContextTextReference, ContextUnitReference } from './contract.js'
import { decodeContextCompaction } from './compaction-codec.js'
import { invalidSource } from './errors.js'
import { resolveUnit } from './history.js'
import type { ContextFacts } from './history.js'
import { assertEarlier, memoryReferences } from './material-state.js'
import { knownEvent } from './sources.js'
import { sourceKey } from './validation.js'

/** Closed text selectors never evaluate arbitrary JSON paths or return private runtime objects. */
export function sourceText(facts: ContextFacts, ref: ContextTextReference): string {
  const original = knownEvent(facts.index, ref.eventId)
  switch (ref.selector) {
    case 'input-text': {
      const input = facts.segments.flatMap(segment => segment.material.inputs).find(item => item.stored.eventId === ref.eventId)
      if (input?.payload.kind !== 'user') invalidSource('input-text-selector')
      return input.payload.text
    }
    case 'model-text': {
      const model = facts.segments.flatMap(segment => segment.models.invocations).find(item => item.state === 'settled' && item.settled.stored.eventId === ref.eventId)
      if (model?.state !== 'settled') invalidSource('model-text-selector')
      const block = model.settled.payload.result.blocks.find(item => item.index === ref.outputBlockIndex)
      if (block?.kind !== 'text' || !block.complete) invalidSource('model-text-block')
      return block.text
    }
    case 'tool-text': {
      const tool = facts.segments.flatMap(segment => segment.tools.invocations).find(item => item.state === 'settled' && item.settled.stored.eventId === ref.eventId)
      if (tool?.state !== 'settled') invalidSource('tool-text-selector')
      const result = tool.settled.payload
      if (result.outcome !== 'succeeded' || result.cleanup.status !== 'complete' || result.cleanup.failed !== 0
        || result.failure !== undefined || result.result.kind !== 'success') invalidSource('tool-text-not-successful')
      return textValue(result.result.value)
    }
    case 'inbox-text': {
      const item = facts.segments.flatMap(segment => segment.communication.inbox).find(item => item.acceptedEventId === ref.eventId)
      if (item === undefined) invalidSource('inbox-text-selector')
      return textValue(item.envelope.payload)
    }
    case 'memory-text': {
      const memory = facts.segments.flatMap(segment => segment.material.memoryRevisions).find(item => item.stored.eventId === ref.eventId)
      if (memory === undefined) invalidSource('memory-text-selector')
      return memory.payload.text
    }
    case 'compaction-text': {
      if (original.stored.type !== 'context/compaction-committed' || original.stored.payloadVersion !== 1) invalidSource('compaction-text-selector')
      return decodeContextCompaction(original.payload).summary
    }
  }
}
/** v1 accepts either a literal payload or the own `text` data field used by read_text. */
function textValue(value: JsonValue): string {
  if (typeof value === 'string') return value
  if (value !== null && !Array.isArray(value) && typeof value === 'object') {
    const object = value as Readonly<Record<string, JsonValue>>
    if (Object.hasOwn(object, 'text') && typeof object.text === 'string') return object.text
  }
  return invalidSource('source-has-no-text')
}
export function assertSourceReference(facts: ContextFacts, ref: ContextSourceReference): void {
  if (['input-text', 'model-text', 'tool-text', 'inbox-text', 'memory-text', 'compaction-text'].includes(ref.selector)) {
    sourceText(facts, ref as ContextTextReference); return
  }
  if (ref.selector === 'compacted-history') {
    const event = knownEvent(facts.index, ref.eventId, 'context/compaction-committed')
    decodeContextCompaction(event.payload); return
  }
  resolveUnit(facts, ref as ContextUnitReference)
}
export function validateMemorySources(facts: ContextFacts, memory: ContextMemoryRecord, at?: SessionEventId): void {
  for (const ref of memoryReferences(memory)) {
    assertSourceReference(facts, ref)
    if (at !== undefined) assertEarlier(facts.index, ref.eventId, at)
  }
  if (memory.origin.kind === 'verbatim' || memory.origin.kind === 'ancestor-adopted') {
    if (memory.text !== sourceText(facts, memory.origin.source)) invalidSource('memory-verbatim-mismatch')
    const owner = at === undefined ? facts.index.snapshot.header.sessionId : parseSessionEventId(at).sessionId
    if (memory.origin.kind === 'ancestor-adopted'
      && (memory.origin.source.selector !== 'memory-text' || parseSessionEventId(memory.origin.source.eventId).sessionId === owner)) invalidSource('ancestor-memory-adoption')
  }
}
export function validateAllMaterialSources(facts: ContextFacts): void {
  for (const segment of facts.segments) for (const memory of segment.material.memoryRevisions) validateMemorySources(facts, memory.payload, memory.stored.eventId)
}
export function activeMemoryReferences(facts: ContextFacts): ReadonlySet<string> {
  return new Set(facts.local.material.memory.flatMap(head => head.record === null ? [] : [sourceKey({ eventId: head.record.stored.eventId, selector: 'memory' })]))
}
