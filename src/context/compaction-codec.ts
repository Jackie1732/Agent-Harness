import type { ContextCompaction, ContextLoss } from './contract.js'
import { invalidContext } from './errors.js'
import { unitMetadata } from './metadata.js'
import { decodeHistorySelection } from './selection.js'
import { array, choice, contextJson, coverage, digestValue, eventId, exact, integer, record, sourceKey, text, unique, unitReference, unitReferences } from './validation.js'

export function decodeLoss(value: unknown): ContextLoss {
  const input = record(value)
  const kind = choice(input.kind, ['verbatim', 'excerpt', 'structured-only', 'omitted-with-reason'])
  const fields = kind === 'excerpt' ? ['fromByte', 'endByte', 'originalBytes', 'omittedBytes'] : kind === 'omitted-with-reason' ? ['reason'] : []
  exact(input, ['kind', 'reference', ...fields]); unitReference(input.reference)
  if (kind === 'excerpt') {
    if (input.fromByte !== 0) invalidContext('excerpt-start')
    const end = integer(input.endByte); const original = integer(input.originalBytes); const omitted = integer(input.omittedBytes)
    if (end > original || end + omitted !== original) invalidContext('excerpt-range')
  }
  if (kind === 'omitted-with-reason') choice(input.reason, ['model-generated-summary'])
  return input as ContextLoss
}

/** Algorithm name is a version identifier; its closed structural kind remains readable. */
export function decodeContextCompaction(value: unknown): ContextCompaction {
  const input = record(contextJson(value))
  exact(input, ['coverage', 'profileEventId', 'history', 'leaves', 'protectedRefs', 'algorithm', 'rendererVersion', 'summary', 'losses', 'sourceDigest', 'originalRenderedBytes', 'compactedRenderedBytes'])
  coverage(input.coverage); eventId(input.profileEventId); decodeHistorySelection(input.history); unitReferences(input.protectedRefs)
  text(input.rendererVersion, 128); text(input.summary, 8 * 1024 * 1024)
  digestValue(input.sourceDigest); integer(input.originalRenderedBytes, 1); integer(input.compactedRenderedBytes, 1)
  const leaves = array(input.leaves).map(value => {
    const leaf = record(value); exact(leaf, ['reference', 'sourceEventIds', 'sourceDigest', 'metadata'])
    const ref = unitReference(leaf.reference)
    if (ref.selector === 'memory' || ref.selector === 'compacted-history' || ref.selector === 'outbox-message') invalidContext('non-leaf-compaction')
    unique(array(leaf.sourceEventIds).map(eventId)); digestValue(leaf.sourceDigest)
    if (unitMetadata(leaf.metadata).kind === 'compacted-history') invalidContext('nested-compaction-metadata')
    return ref
  })
  if (leaves.length === 0) invalidContext('empty-compaction')
  unique(leaves.map(sourceKey))
  const losses = array(input.losses).map(decodeLoss)
  if (losses.length !== leaves.length || losses.some((loss, index) => {
    const leaf = leaves[index]
    return leaf === undefined || sourceKey(loss.reference) !== sourceKey(leaf)
  })) invalidContext('loss-membership')
  const algorithm = record(input.algorithm)
  text(algorithm.name, 128)
  switch (choice(algorithm.kind, ['excerpt', 'model-text'])) {
    case 'excerpt':
      exact(algorithm, ['kind', 'name', 'maxExcerptBytes']); integer(algorithm.maxExcerptBytes, 0, 1024 * 1024); break
    case 'model-text': {
      exact(algorithm, ['kind', 'name', 'invocationId', 'assemblyEventId', 'preparedEventId', 'settledEventId', 'blockIndices'])
      text(algorithm.invocationId, 36); eventId(algorithm.assemblyEventId); eventId(algorithm.preparedEventId); eventId(algorithm.settledEventId)
      const indices = array(algorithm.blockIndices, 1024).map(value => integer(value))
      if (indices.length === 0 || indices.some((value, index) => {
        const previous = indices[index - 1]
        return previous !== undefined && value <= previous
      })) invalidContext('summary-blocks')
      break
    }
  }
  return input as ContextCompaction
}
