import { snapshotModelRequest } from '../model/request.js'
import type { ContextAssembly, ContextProvenance } from './contract.js'
import { invalidContext } from './errors.js'
import { decodeContextSelection } from './selection.js'
import { decodeCapturedFacts } from './surface-codec.js'
import { array, boolean, choice, contextJson, coverage, digestValue, eventId, exact, integer, record, sourceKey, tags, text, unique, unitReference, unitReferences } from './validation.js'

function provenance(value: unknown): ContextProvenance {
  const item = record(value); exact(item, ['location', 'source', 'sourceDigest'])
  const location = text(item.location, 128)
  if (!/^(?:instructions\[\d+\]|tools\[\d+\]|messages\[\d+\]\.(?:content\[\d+\]|continuation)|model|maxOutputTokens|temperature|topP|profile)$/.test(location)) invalidContext('provenance-location')
  digestValue(item.sourceDigest)
  const source = record(item.source)
  switch (choice(source.kind, ['profile-section', 'tool-surface', 'inline-control', 'unit'])) {
    case 'profile-section': exact(source, ['kind', 'eventId', 'name']); eventId(source.eventId); text(source.name, 128); break
    case 'tool-surface': exact(source, ['kind', 'name']); text(source.name, 64); break
    case 'inline-control':
      exact(source, ['kind', 'field']); choice(source.field, ['model', 'maxOutputTokens', 'temperature', 'topP', 'profile']); break
    case 'unit':
      exact(source, ['kind', 'reference', 'eventIds', 'representation']); unitReference(source.reference)
      unique(array(source.eventIds).map(eventId)); choice(source.representation, ['raw', 'historical-note/v1', 'data-note']); break
  }
  return item as ContextProvenance
}
function deferred(value: unknown): void {
  const item = record(value)
  exact(item, ['messageId', 'acceptedEventId', 'sender', 'recipient', 'channelId', 'channelSequence', 'correlationId', 'causationId', 'replyTo', 'status', 'reason'])
  for (const field of ['messageId', 'sender', 'recipient', 'channelId', 'correlationId']) text(item[field], 128)
  for (const field of ['causationId', 'replyTo']) if (item[field] !== null) text(item[field], 36)
  eventId(item.acceptedEventId); integer(item.channelSequence, 1)
  choice(item.status, ['pending']); choice(item.reason, ['not-selected-this-assembly'])
}
function outbox(value: unknown): void {
  const item = record(value)
  exact(item, ['messageId', 'acceptedEventId', 'recipient', 'channelId', 'channelSequence', 'correlationId', 'causationId', 'replyTo', 'attemptCount', 'openAttempt', 'lastFailure', 'outcomeUnknown'])
  for (const field of ['messageId', 'recipient', 'channelId', 'correlationId']) text(item[field], 128)
  for (const field of ['causationId', 'replyTo', 'lastFailure']) if (item[field] !== null) text(item[field], 128)
  eventId(item.acceptedEventId); integer(item.channelSequence, 1); integer(item.attemptCount)
  if (item.openAttempt !== null) integer(item.openAttempt, 1)
  boolean(item.outcomeUnknown)
}

/** Structural decoding only; rebuild performs independent semantic reconstruction. */
export function decodeContextAssembly(value: unknown): ContextAssembly {
  const input = record(contextJson(value))
  exact(input, ['purpose', 'coverage', 'selection', 'captured', 'required', 'selected', 'omitted', 'deferred', 'pendingOutbox', 'memoryCandidates', 'budget', 'request', 'provenance', 'rendererVersion', 'requestDigest'])
  choice(input.purpose, ['generation', 'compaction']); coverage(input.coverage)
  decodeContextSelection(input.selection); decodeCapturedFacts(input.captured); unitReferences(input.required)
  text(input.rendererVersion, 128); digestValue(input.requestDigest)
  // A known envelope with an unfamiliar renderer is still inspectable, but not executable.
  snapshotModelRequest(input.request as ContextAssembly['request'])
  const selected = array(input.selected).map(value => {
    const item = record(value); exact(item, ['reference', 'sourceEventIds', 'placement', 'representation'])
    const reference = unitReference(item.reference); unique(array(item.sourceEventIds).map(eventId))
    choice(item.placement, ['history', 'required', 'memory', 'compaction-source'])
    choice(item.representation, ['raw', 'historical-note/v1', 'data-note'])
    return sourceKey(reference)
  })
  unique(selected)
  const omitted = array(input.omitted).map(value => {
    const item = record(value); exact(item, ['reference', 'reason'])
    const reference = unitReference(item.reference)
    choice(item.reason, ['required-duplicate', 'history-budget', 'outside-suffix', 'memory-top-k', 'memory-budget', 'request-budget', 'compacted'])
    return `${sourceKey(reference)}#${item.reason as string}`
  })
  unique(omitted)
  array(input.deferred).forEach(deferred); array(input.pendingOutbox).forEach(outbox)
  const candidates = array(input.memoryCandidates).map(value => {
    const item = record(value); exact(item, ['reference', 'key', 'score', 'matchedTags', 'rank', 'withinTopK'])
    const reference = unitReference(item.reference)
    if (reference.selector !== 'memory') invalidContext('memory-candidate-kind')
    text(item.key, 128); integer(item.score); tags(item.matchedTags); integer(item.rank); boolean(item.withinTopK)
    return sourceKey(reference)
  })
  unique(candidates)
  const budget = record(input.budget)
  const fields = ['requestBytes', 'estimatedInputTokens', 'availableInputTokens', 'memoryEstimatedTokens', 'assemblyEnvelopeUpperBoundBytes', 'sessionMaxRecordBytes', 'sourceEvents', 'sourceBytes', 'units'] as const
  exact(budget, ['accounting', 'precision', ...fields])
  choice(budget.accounting, ['neutral-json-utf8-estimate/v1']); choice(budget.precision, ['estimate'])
  for (const field of fields) integer(budget[field], 0, Number.MAX_SAFE_INTEGER)
  const entries = array(input.provenance, 100000).map(provenance)
  unique(entries.map(entry => entry.location))
  return input as ContextAssembly
}
