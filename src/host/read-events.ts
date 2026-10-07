import type { SessionSnapshot } from '../session/types.js'
import type { SessionEventCursor } from '../protocol/references.js'
import type { SessionEventPage } from '../protocol/results.js'
import { HostError } from './errors.js'

export interface EventPageQuery { readonly maxEvents: number; readonly after?: number; readonly cursor?: SessionEventCursor; readonly maxBytes?: number }

/** Iterate one fixed local prefix; later appends belong to the next explicit cut. */
export function readEventPage(snapshot: SessionSnapshot, query: EventPageQuery): SessionEventPage {
  if (!Number.isSafeInteger(query.maxEvents) || query.maxEvents < 1 || query.after !== undefined && query.cursor !== undefined) throw new HostError('HOST_PROTOCOL_INVALID', 'event-page-query')
  const through = query.cursor?.through ?? snapshot.localPosition
  const nextSequence = query.cursor?.nextSequence ?? (query.after ?? 0) + 1
  if (query.cursor !== undefined && query.cursor.sessionId !== snapshot.header.sessionId || !Number.isSafeInteger(through) || through < 0 || through > snapshot.localPosition
    || !Number.isSafeInteger(nextSequence) || nextSequence < 1 || nextSequence > through + 1) throw new HostError('HOST_CURSOR_INVALID', 'event-cursor-invalid')
  const remaining = snapshot.history.at(-1)!.events.filter(item => item.stored.sequence >= nextSequence && item.stored.sequence <= through)
  if (remaining.length !== Math.max(0, through - nextSequence + 1) || remaining.some((item, index) => item.stored.sequence !== nextSequence + index)) throw new HostError('HOST_CURSOR_INVALID', 'event-cursor-prefix-missing')
  let count = Math.min(query.maxEvents, remaining.length)
  const page = (): SessionEventPage => ({ sessionId: snapshot.header.sessionId, through, parent: snapshot.header.parent ?? null,
    events: remaining.slice(0, count).map(item => item.stored), hasMore: count < remaining.length,
    nextCursor: count < remaining.length ? { sessionId: snapshot.header.sessionId, through, nextSequence: nextSequence + count } : null })
  if (query.maxBytes !== undefined) {
    let low = 0, high = count
    while (low < high) {
      count = Math.ceil((low + high) / 2)
      if (Buffer.byteLength(JSON.stringify(page())) <= query.maxBytes) low = count
      else high = count - 1
    }
    count = low
    if (count === 0 && remaining.length > 0 || Buffer.byteLength(JSON.stringify(page())) > query.maxBytes) throw new HostError('HOST_LIMIT_EXCEEDED', 'event-page-limit')
  }
  return Object.freeze(page())
}
