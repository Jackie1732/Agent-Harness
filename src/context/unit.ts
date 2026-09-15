import type { JsonValue } from '../foundation/json.js'
import type { ModelInputMessage } from '../model/contract.js'
import type { SessionEventId } from '../session/ids.js'
import type { ContextSelectedUnit, ContextUnitMetadata, ContextUnitReference } from './contract.js'
import { compareText, digest, sourceKey } from './validation.js'

/** A whole selectable message or exchange; never a live callback or an execution handle. */
export interface ContextUnit {
  readonly reference: ContextUnitReference
  readonly sourceEventIds: readonly SessionEventId[]
  readonly segmentOrdinal: number
  readonly closureSequence: number
  readonly metadata: ContextUnitMetadata
  readonly body: JsonValue
  readonly canonicalSource: JsonValue
  readonly rawMessages: readonly ModelInputMessage[]
  readonly optionalHistory: boolean
  readonly compactable: boolean
}
const order = ['user-input', 'assistant-response', 'tool-exchange', 'tool-observation', 'peer-message', 'outbox-message', 'memory', 'legacy', 'diagnostic', 'compacted-history'] as const
export function compareUnits(left: ContextUnit, right: ContextUnit): number {
  return left.segmentOrdinal - right.segmentOrdinal || left.closureSequence - right.closureSequence
    || order.indexOf(left.reference.selector) - order.indexOf(right.reference.selector)
    || compareText(sourceKey(left.reference), sourceKey(right.reference))
}
export function sourceContent(unit: ContextUnit): JsonValue {
  return { selector: unit.reference, content: unit.canonicalSource }
}
export function unitDigest(unit: ContextUnit): string { return digest(sourceContent(unit)) }
export function selectedUnit(unit: ContextUnit, placement: ContextSelectedUnit['placement'], representation: ContextSelectedUnit['representation']): ContextSelectedUnit {
  return Object.freeze({ reference: unit.reference, sourceEventIds: unit.sourceEventIds, placement, representation })
}
