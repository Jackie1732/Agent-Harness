import { decodeProviderDescriptor } from '../model/submission.js'
import { parseMessageId } from '../communication/ids.js'
import type { ContextHistorySelection, ContextModelTarget, ContextSelectionSpec, RuleCompactionRequest } from './contract.js'
import { decodeMemoryQuery } from './memory.js'
import { invalidContext } from './errors.js'
import { array, choice, contextJson, eventId, exact, integer, record, sessionId, text, unique, unitReferences } from './validation.js'

export function decodeHistorySelection(value: unknown): ContextHistorySelection {
  const input = record(value)
  const mode = choice(input.mode, ['local-suffix', 'lineage-suffix'])
  exact(input, mode === 'local-suffix' ? ['mode', 'representation'] : ['mode', 'representation', 'ancestorSessionIds'])
  choice(input.representation, ['raw', 'historical-note/v1'])
  if (mode === 'lineage-suffix') unique(array(input.ancestorSessionIds, 127).map(sessionId))
  return input as ContextHistorySelection
}

export function decodeModelTarget(value: unknown): ContextModelTarget {
  const input = record(value)
  exact(input, ['model', 'maxOutputTokens', 'provider'], ['temperature', 'topP', 'profile'])
  text(input.model, 256); integer(input.maxOutputTokens, 1)
  for (const name of ['temperature', 'topP'] as const) {
    const item = input[name]
    if (item !== undefined && (typeof item !== 'number' || !Number.isFinite(item)
      || item < 0 || item > (name === 'temperature' ? 2 : 1))) invalidContext('sampling-control')
  }
  if (input.profile !== undefined) {
    const profile = record(input.profile)
    exact(profile, ['namespace', 'version', 'options'])
    text(profile.namespace, 128); integer(profile.version, 1)
    // Model's closed namespace decoder remains the authority at final Request validation.
    record(profile.options)
  }
  if (input.provider === undefined) invalidContext('provider-descriptor')
  try { decodeProviderDescriptor(input.provider) } catch { invalidContext('provider-descriptor') }
  return input as ContextModelTarget
}

/** Copy all selection data before invoking any external surface or awaiting a commit. */
export function decodeContextSelection(value: unknown): ContextSelectionSpec {
  const input = record(contextJson(value))
  exact(input, ['profileEventId', 'target', 'requiredInputs', 'observations', 'history', 'compactions', 'memory', 'inbox', 'outboxPayloads', 'compactionSource'])
  eventId(input.profileEventId); decodeModelTarget(input.target)
  unitReferences(input.requiredInputs); unitReferences(input.observations); unitReferences(input.outboxPayloads)
  decodeHistorySelection(input.history)
  unique(array(input.compactions).map(eventId))
  const memory = record(input.memory); exact(memory, ['required', 'query'])
  unitReferences(memory.required); decodeMemoryQuery(memory.query)
  const inbox = array(input.inbox).map(value => {
    const item = record(value); exact(item, ['messageId', 'action'])
    const messageId = text(item.messageId, 36)
    try { parseMessageId(messageId) } catch { invalidContext('message-identity') }
    choice(item.action, ['include-full', 'defer'])
    return messageId
  })
  unique(inbox)
  if (input.compactionSource !== null) {
    const source = record(input.compactionSource); exact(source, ['units', 'protectedRefs'])
    if (unitReferences(source.units).length === 0) invalidContext('empty-compaction')
    unitReferences(source.protectedRefs)
  }
  return input as ContextSelectionSpec
}

export function decodeRuleCompactionRequest(value: unknown): RuleCompactionRequest {
  const input = record(contextJson(value))
  exact(input, ['profileEventId', 'history', 'units', 'protectedRefs', 'maxExcerptBytes'])
  eventId(input.profileEventId); decodeHistorySelection(input.history)
  if (unitReferences(input.units).length === 0) invalidContext('empty-compaction')
  unitReferences(input.protectedRefs); integer(input.maxExcerptBytes, 0, 1024 * 1024)
  return input as RuleCompactionRequest
}
