import type { ContextContinuationIdentity, ContextToolOutcomeMetadata, ContextUnitMetadata } from './contract.js'
import { decodeMemoryOrigin } from './memory.js'
import { array, choice, eventId, exact, identifier, integer, record, tags, text, unitReferences } from './validation.js'
import { invalidContext } from './errors.js'

export function continuationIdentity(value: unknown): ContextContinuationIdentity | null {
  if (value === null) return null
  const input = record(value); exact(input, ['namespace', 'version', 'providerId', 'model'])
  text(input.namespace, 128); integer(input.version, 1); text(input.providerId, 128); text(input.model, 256)
  return input as ContextContinuationIdentity
}
export function toolOutcomeMetadata(value: unknown): ContextToolOutcomeMetadata {
  const item = record(value)
  exact(item, ['invocationId', 'requestedEventId', 'settledEventId', 'outcome', 'execution', 'emission', 'cleanup', 'operationClass'])
  text(item.invocationId, 36); eventId(item.requestedEventId); eventId(item.settledEventId)
  choice(item.outcome, ['succeeded', 'rejected', 'failed', 'cancelled', 'incomplete', 'interrupted'])
  choice(item.execution, ['not-started', 'may-have-executed', 'execution-observed'])
  choice(item.emission, ['none', 'may-have-occurred', 'observed'])
  if (item.operationClass !== null) choice(item.operationClass, ['pure', 'read-only', 'external'])
  const cleanup = record(item.cleanup); exact(cleanup, ['status', 'attempted', 'failed'])
  choice(cleanup.status, ['complete', 'incomplete', 'unknown-after-process-loss'])
  if (cleanup.attempted !== null) integer(cleanup.attempted)
  if (cleanup.failed !== null) integer(cleanup.failed)
  return item as ContextToolOutcomeMetadata
}

/** Validate a closed structural metadata vocabulary; body text is never consulted. */
export function unitMetadata(value: unknown): ContextUnitMetadata {
  const item = record(value)
  switch (item.kind) {
    case 'user-input':
      exact(item, ['kind', 'origin', 'originLabel']); choice(item.origin, ['host-authored', 'host-import']); text(item.originLabel, 128); break
    case 'assistant-response':
      exact(item, ['kind', 'invocationId', 'preparedEventId', 'settledEventId', 'continuation'])
      text(item.invocationId, 36); eventId(item.preparedEventId); eventId(item.settledEventId); continuationIdentity(item.continuation); break
    case 'tool-exchange':
      exact(item, ['kind', 'invocationId', 'preparedEventId', 'settledEventId', 'intents', 'continuation'])
      text(item.invocationId, 36); eventId(item.preparedEventId); eventId(item.settledEventId); continuationIdentity(item.continuation)
      for (const value of array(item.intents, 1024)) {
        const intent = record(value); exact(intent, ['outputBlockIndex', 'callId', 'name', 'argumentsStatus', 'result'])
        integer(intent.outputBlockIndex); text(intent.callId, 256); text(intent.name, 64)
        choice(intent.argumentsStatus, ['valid-json', 'invalid-json']); toolOutcomeMetadata(intent.result)
      }
      break
    case 'tool-observation': exact(item, ['kind', 'result']); toolOutcomeMetadata(item.result); break
    case 'peer-message': case 'outbox-message':
      exact(item, ['kind', 'messageId', 'sender', 'recipient', 'channelId', 'channelSequence', 'correlationId', 'causationId', 'replyTo', 'type', 'payloadVersion', 'createdAt', 'status', 'terminalEventId'])
      for (const key of ['messageId', 'channelId', 'correlationId']) text(item[key], 36)
      for (const key of ['sender', 'recipient']) text(item[key], 64)
      for (const key of ['causationId', 'replyTo']) if (item[key] !== null) text(item[key], 36)
      integer(item.channelSequence, 1); integer(item.payloadVersion, 1); text(item.type, 128); text(item.createdAt, 32)
      choice(item.status, item.kind === 'peer-message' ? ['pending', 'processed', 'abandoned'] : ['pending', 'delivered', 'rejected', 'abandoned'])
      if (item.terminalEventId !== null) eventId(item.terminalEventId)
      break
    case 'memory': exact(item, ['kind', 'key', 'tags', 'origin']); identifier(item.key); tags(item.tags); decodeMemoryOrigin(item.origin); break
    case 'legacy':
      exact(item, ['kind', 'preparedEventId', 'fromMessage', 'toMessage', 'omitted']); eventId(item.preparedEventId)
      integer(item.fromMessage); integer(item.toMessage, 1)
      for (const omitted of array(item.omitted, 2)) choice(omitted, ['instructions', 'continuation-text'])
      break
    case 'diagnostic': {
      exact(item, ['kind', 'invocationId', 'outcome', 'protocolComplete', 'stopReason', 'cleanup'])
      text(item.invocationId, 36); choice(item.outcome, ['completed', 'incomplete', 'failed', 'cancelled', 'interrupted'])
      if (typeof item.protocolComplete !== 'boolean') invalidContext('diagnostic-protocol')
      if (item.stopReason !== null) choice(item.stopReason, ['stop', 'tool-calls', 'length', 'refusal', 'content-filter'])
      const cleanup = record(item.cleanup); exact(cleanup, ['status', 'failedResources'])
      choice(cleanup.status, ['complete', 'incomplete', 'unknown-after-process-loss'])
      if (cleanup.failedResources !== null) integer(cleanup.failedResources)
      break
    }
    case 'compacted-history':
      exact(item, ['kind', 'algorithm', 'leafReferences', 'losses', 'structures', 'continuationPolicy']); text(item.algorithm, 128); unitReferences(item.leafReferences)
      choice(item.continuationPolicy, ['not-carried'])
      for (const entry of array(item.structures)) {
        if (record(entry).kind === 'compacted-history') invalidContext('nested-compaction-metadata')
        unitMetadata(entry)
      }
      // Loss fields are decoded in the Compaction codec and then compared with the source record.
      array(item.losses)
      break
    default: invalidContext('unit-metadata-kind')
  }
  return item as ContextUnitMetadata
}
