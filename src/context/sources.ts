import { types as nodeTypes } from 'node:util'
import { snapshotJson } from '../foundation/json.js'
import type { JsonValue } from '../foundation/json.js'
import { inspectBoundedJson, JsonBoundaryError } from '../schema/bounded-json.js'
import { formatSessionAddress, formatSessionEventId, parseSessionEventId, sessionLogPosition, sessionSequence } from '../session/ids.js'
import type { SessionEventId } from '../session/ids.js'
import type { CommittedSessionEvent, SessionEventRecord, SessionHistorySegment, SessionSnapshot } from '../session/types.js'
import type { ContextBudgetLimits, ContextBuildFailure, ContextCut } from './contract.js'
import { invalidSource, invalidState } from './errors.js'
import { contextJson, equalJson, exact, integer, jsonBytes, record, sessionId, text } from './validation.js'

export type SourceLimits = Pick<ContextBudgetLimits, 'maxSourceEvents' | 'maxSourceBytes' | 'maxJsonDepth' | 'maxJsonNodes'>
export const sourceProtocolLimits: SourceLimits = Object.freeze({
  maxSourceEvents: 10000, maxSourceBytes: 128 * 1024 * 1024, maxJsonDepth: 64, maxJsonNodes: 250000,
})
export type SourceLimitResult = Extract<ContextBuildFailure, { kind: 'resource-limit' }>
export interface SourceIndex {
  readonly snapshot: SessionSnapshot
  readonly coverage: ContextCut['coverage']
  readonly records: ReadonlyMap<SessionEventId, SessionEventRecord>
  readonly sourceEvents: number
  readonly sourceBytes: number
}

function own(value: unknown, name: string): unknown {
  if (value === null || typeof value !== 'object' || nodeTypes.isProxy(value)) invalidSource('snapshot-object')
  const field = Object.getOwnPropertyDescriptor(value, name)
  if (field === undefined || !field.enumerable || !('value' in field)) invalidSource('snapshot-data-field')
  return field.value
}
function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || nodeTypes.isProxy(value) || value.length > maximum) invalidSource('snapshot-array')
  if (Object.getOwnPropertySymbols(value).length > 0 || Object.getOwnPropertyNames(value).length !== value.length + 1) invalidSource('snapshot-array-fields')
  return value
}
function limit(kind: SourceLimitResult['limit'], maximum: number): SourceLimitResult {
  return Object.freeze({ kind: 'resource-limit', limit: kind, maximum })
}

/** Single event scan. Limits are checked before a record is decoded, copied, or indexed. */
export function indexSources(input: SessionSnapshot, limits: SourceLimits): SourceIndex | SourceLimitResult {
  const segments = list(own(input, 'history'), 128)
  if (segments.length === 0) invalidSource('empty-history')
  const history: SessionHistorySegment[] = []
  const records = new Map<SessionEventId, SessionEventRecord>()
  let eventCount = 0
  let bytes = 0
  let nodes = 0
  for (let ordinal = 0; ordinal < segments.length; ordinal++) {
    const segment = own(segments, String(ordinal))
    const header = record(contextJson(own(segment, 'header'), 4096))
    exact(header, ['formatVersion', 'sessionId', 'address', 'createdAt'], ['parent'])
    const id = sessionId(header.sessionId)
    if (header.formatVersion !== 1 || header.address !== formatSessionAddress(id)) invalidSource('header-identity')
    text(header.createdAt, 32)
    const through = sessionLogPosition(integer(own(segment, 'through'), 0, Number.MAX_SAFE_INTEGER))
    const rawEvents = own(segment, 'events')
    if (!Array.isArray(rawEvents) || nodeTypes.isProxy(rawEvents) || rawEvents.length !== through) invalidSource('segment-length')
    const previous = history.at(-1)
    if (previous === undefined) { if (header.parent !== undefined) invalidSource('missing-root') }
    else {
      const parent = record(header.parent); exact(parent, ['sessionId', 'through'])
      if (parent.sessionId !== previous.header.sessionId || parent.through !== previous.through) invalidSource('lineage-cut')
    }
    if (history.some(item => item.header.sessionId === id)) invalidSource('lineage-cycle')
    const events: SessionEventRecord[] = []
    let ended = false
    for (let offset = 0; offset < through; offset++) {
      if (eventCount >= limits.maxSourceEvents) return limit('source-events', limits.maxSourceEvents)
      if (bytes >= limits.maxSourceBytes) return limit('source-bytes', limits.maxSourceBytes)
      if (nodes >= limits.maxJsonNodes) return limit('json', limits.maxJsonNodes)
      let copy: JsonValue
      let checkedNodes = 0
      try {
        const raw = own(rawEvents, String(offset))
        checkedNodes = inspectBoundedJson(raw, {
          // A known record contains both stored and decoded payloads. Neither escapes the node bound.
          maxBytes: Math.min(32 * 1024 * 1024, (limits.maxSourceBytes - bytes) * 2 + 1024),
          maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes - nodes,
        }).nodes
        copy = snapshotJson(raw)
      } catch (reason) {
        if (reason instanceof JsonBoundaryError && reason.reason !== 'invalid') {
          const maximum = reason.reason === 'bytes' ? limits.maxSourceBytes
            : reason.reason === 'depth' ? limits.maxJsonDepth : limits.maxJsonNodes
          return limit(reason.reason === 'bytes' ? 'source-bytes' : 'json', maximum)
        }
        return invalidSource('source-json')
      }
      const item = record(copy)
      if (item.kind !== 'known' && item.kind !== 'opaque') invalidSource('event-kind')
      exact(item, item.kind === 'known' ? ['kind', 'stored', 'payload'] : ['kind', 'stored'])
      const stored = record(item.stored)
      exact(stored, ['envelopeVersion', 'sessionId', 'eventId', 'sequence', 'recordedAt', 'type', 'payloadVersion', 'payload'], ['ignorable'])
      const expected = formatSessionEventId(id, sessionSequence(offset + 1))
      if (stored.envelopeVersion !== 1 || stored.eventId !== expected || stored.sessionId !== id || stored.sequence !== offset + 1
        || stored.ignorable !== undefined && stored.ignorable !== true || ended) invalidSource('event-envelope')
      text(stored.type, 128); text(stored.recordedAt, 32); integer(stored.payloadVersion, 1, Number.MAX_SAFE_INTEGER)
      if (item.kind === 'opaque' && stored.ignorable !== true) invalidSource('required-opaque')
      const size = jsonBytes(stored)
      if (bytes + size > limits.maxSourceBytes) return limit('source-bytes', limits.maxSourceBytes)
      bytes += size; nodes += checkedNodes; eventCount++
      ended = stored.type === 'session/ended' && stored.payloadVersion === 1
      const event = item as unknown as SessionEventRecord
      events.push(event); records.set(expected, event)
    }
    const lifecycle = own(segment, 'localLifecycle')
    if (lifecycle !== (ended ? 'ended' : 'active')) invalidSource('local-lifecycle')
    history.push(Object.freeze({ header: header as unknown as SessionHistorySegment['header'], through,
      localLifecycle: lifecycle as SessionHistorySegment['localLifecycle'], events: Object.freeze(events) }))
  }
  const last = history.at(-1)
  if (last === undefined) invalidSource('empty-history')
  const target = record(contextJson(own(input, 'header'), 4096))
  if (!equalJson(target, last.header as unknown as JsonValue) || own(input, 'address') !== last.header.address
    || own(input, 'localPosition') !== last.through || own(input, 'lifecycle') !== last.localLifecycle) invalidSource('target-identity')
  const snapshot: SessionSnapshot = Object.freeze({ header: last.header, address: last.header.address,
    localPosition: last.through, lifecycle: last.localLifecycle, history: Object.freeze(history) })
  return Object.freeze({ snapshot, records, sourceEvents: eventCount, sourceBytes: bytes,
    coverage: Object.freeze(history.map(segment => Object.freeze({ sessionId: segment.header.sessionId, through: segment.through }))) })
}

export function requireSourceIndex(snapshot: SessionSnapshot, limits: SourceLimits = sourceProtocolLimits): SourceIndex {
  const result = indexSources(snapshot, limits)
  if ('kind' in result) invalidSource(`resource-${result.limit}`)
  return result
}
export function knownEvent(index: SourceIndex, id: SessionEventId, type?: string): CommittedSessionEvent {
  const item = index.records.get(id)
  if (item?.kind !== 'known' || type !== undefined && item.stored.type !== type) invalidSource('event-not-visible-or-wrong-kind')
  return item
}

/** Adapt only target identity. Ancestor records retain their original identities and cuts. */
export function segmentSnapshot(snapshot: SessionSnapshot, ordinal: number): SessionSnapshot {
  const segment = snapshot.history[ordinal]
  if (segment === undefined) invalidSource('segment-not-visible')
  return Object.freeze({ header: segment.header, address: segment.header.address, lifecycle: segment.localLifecycle,
    localPosition: segment.through, history: Object.freeze(snapshot.history.slice(0, ordinal + 1)) })
}

/** Select a real inherited prefix, never a newly invented global sequence or altered ancestry. */
export function snapshotAtCut(snapshot: SessionSnapshot, cut: ContextCut['coverage']): SessionSnapshot {
  if (cut.length === 0 || cut.length > snapshot.history.length) invalidSource('cut-length')
  const history = cut.map((entry, ordinal) => {
    const segment = snapshot.history[ordinal]
    if (segment === undefined) invalidSource('cut-membership')
    if (entry.sessionId !== segment.header.sessionId || entry.through > segment.through || entry.through < 0
      || ordinal < cut.length - 1 && entry.through !== segment.through) invalidSource('cut-membership')
    const events = Object.freeze(segment.events.slice(0, entry.through))
    const ended = events.at(-1)?.stored.type === 'session/ended' && events.at(-1)?.stored.payloadVersion === 1
    return Object.freeze({ header: segment.header, through: entry.through, localLifecycle: ended ? 'ended' as const : 'active' as const, events })
  })
  const target = history.at(-1)
  if (target === undefined) invalidSource('empty-history')
  return Object.freeze({ header: target.header, address: target.header.address, lifecycle: target.localLifecycle,
    localPosition: target.through, history: Object.freeze(history) })
}
export function snapshotBefore(snapshot: SessionSnapshot, id: SessionEventId): SessionSnapshot {
  const address = parseSessionEventId(id)
  const ordinal = snapshot.history.findIndex(item => item.header.sessionId === address.sessionId)
  const segment = snapshot.history[ordinal]
  if (segment === undefined || address.sequence > segment.through) invalidSource('event-not-visible')
  return snapshotAtCut(snapshot, snapshot.history.slice(0, ordinal + 1).map((item, index) => ({
    sessionId: item.header.sessionId, through: index === ordinal ? sessionLogPosition(address.sequence - 1) : item.through,
  })))
}
export function assertEventCut(snapshot: SessionSnapshot, event: CommittedSessionEvent, cut: ContextCut['coverage']): void {
  const last = cut.at(-1)
  if (last?.sessionId !== event.stored.sessionId || last.through + 1 !== event.stored.sequence) invalidState('derived-event-cut')
  snapshotAtCut(snapshot, cut)
}
