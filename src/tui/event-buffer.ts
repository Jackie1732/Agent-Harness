/** Bounded event display is separate from the durable Session prefix and observation checkpoint. */
import type { SessionEventPage } from '../protocol/index.js'
import type { StoredSessionEvent } from '../session/types.js'

export interface EventBuffer { readonly sessionId: string | null; readonly events: readonly StoredSessionEvent[]; readonly omitted: number; readonly through: number }
export const EMPTY_EVENT_BUFFER: EventBuffer = Object.freeze({ sessionId: null, events: [], omitted: 0, through: 0 })

/**
 * Keep the newest delivered records within both display limits.
 * @param previous Existing target buffer.
 * @param page Fully delivered original event page.
 * @param limits Explicit profile item and byte limits.
 * @returns A new display buffer with a visible omitted-history count.
 */
export function appendEventPage(previous: EventBuffer, page: SessionEventPage, limits: { readonly maxBufferedEvents: number; readonly maxBufferedBytes: number }): EventBuffer {
  const same = previous.sessionId === page.sessionId
  const events = [...(same ? previous.events : []), ...page.events]
  let omitted = same ? previous.omitted : 0, bytes = events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event)), 0)
  while (events.length > limits.maxBufferedEvents || bytes > limits.maxBufferedBytes) {
    const removed = events.shift()
    if (removed === undefined) break
    bytes -= Buffer.byteLength(JSON.stringify(removed)); omitted++
  }
  return { sessionId: page.sessionId, events, omitted, through: page.through }
}
