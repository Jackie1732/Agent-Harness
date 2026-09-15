import type { JsonValue } from '../foundation/json.js'
import { snapshotJson } from '../foundation/json.js'
import type { ModelInputMessage } from '../model/contract.js'
import type { ContextSelectedUnit } from './contract.js'
import type { ContextUnit } from './unit.js'
import { canonicalText } from './validation.js'

/** A single data block. A body that imitates sender/role/system fields cannot escape this value. */
export function dataNote(kind: string, source: JsonValue, metadata: JsonValue, body: JsonValue): Extract<ModelInputMessage, { role: 'user' }> {
  return Object.freeze({ role: 'user', content: Object.freeze([Object.freeze({ kind: 'text', text: canonicalText({ kind, source, metadata, body }) })]) })
}
export function withoutContinuation(messages: readonly ModelInputMessage[]): JsonValue {
  return messages.map(message => ({ role: message.role, content: message.content }))
}
export function unitRepresentation(unit: ContextUnit, history: 'raw' | 'historical-note/v1'): ContextSelectedUnit['representation'] {
  return unit.reference.selector === 'assistant-response' || unit.reference.selector === 'tool-exchange' ? history
    : unit.reference.selector === 'user-input' ? 'raw' : 'data-note'
}
export function renderUnit(unit: ContextUnit, representation: ContextSelectedUnit['representation']): readonly ModelInputMessage[] {
  if (representation === 'raw' || unit.reference.selector === 'compacted-history') return unit.rawMessages
  if (representation === 'historical-note/v1') {
    return Object.freeze([dataNote('historical-note', unit.reference, {
      original: unit.metadata, transformation: 'historical-note/v1',
      omitted: unit.rawMessages.some(item => item.role === 'assistant' && item.continuation !== undefined) ? ['continuation-text'] : [],
      protocolAssociation: 'data-only',
    }, withoutContinuation(unit.rawMessages))])
  }
  return Object.freeze([dataNote(unit.reference.selector, unit.reference, unit.metadata, unit.body)])
}
export function frozenMessages(messages: readonly ModelInputMessage[]): readonly ModelInputMessage[] {
  return snapshotJson(messages) as readonly ModelInputMessage[]
}
