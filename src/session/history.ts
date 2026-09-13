import type { JsonValue } from '../foundation/json.js'
import type { LocalStoredSession } from './backend.js'
import type { DurableEventCatalog, DurableEventDefinition } from './event-catalog.js'
import { sessionEndedEvent } from './event-catalog.js'
import { SessionError } from './errors.js'
import { formatSessionEventId, sessionLogPosition } from './ids.js'
import { snapshotJson } from './json.js'
import type {
  CommittedSessionEvent,
  SessionEventRecord,
  SessionHistorySegment,
  SessionLifecycle,
  StoredSessionEvent,
} from './types.js'

function invalidEvent(event: StoredSessionEvent, message: string, cause?: unknown): SessionError {
  return new SessionError('SESSION_EVENT_INVALID', message, {
    details: {
      sessionId: event.sessionId,
      eventId: event.eventId,
      type: event.type,
      payloadVersion: event.payloadVersion,
    },
    ...(cause === undefined ? {} : { cause }),
  })
}

function decodeKnown(
  event: StoredSessionEvent,
  definition: DurableEventDefinition,
): CommittedSessionEvent {
  if (event.ignorable === true !== definition.ignorable) {
    throw invalidEvent(event, 'stored event ignorable policy differs from its Catalog definition')
  }
  try {
    const input = snapshotJson(event.payload, 'stored event payload')
    const payload = snapshotJson(definition.decode(input), 'decoded event payload')
    return Object.freeze({ kind: 'known' as const, stored: event, payload })
  } catch (cause) {
    throw invalidEvent(event, 'stored event payload failed its Catalog decoder', cause)
  }
}

/** Apply Catalog and local lifecycle semantics to one verified physical prefix. */
export function materializeLocalSession(
  local: LocalStoredSession,
  catalog: DurableEventCatalog,
): SessionHistorySegment {
  const records: SessionEventRecord[] = []
  let lifecycle: SessionLifecycle = 'active'
  for (let index = 0; index < local.events.length; index += 1) {
    const event = local.events[index]
    if (event === undefined) continue
    const expectedSequence = index + 1
    if (
      event.sessionId !== local.header.sessionId
      || event.sequence !== expectedSequence
      || event.eventId !== formatSessionEventId(local.header.sessionId, event.sequence)
    ) {
      throw new SessionError('SESSION_LOG_INVALID', 'event does not match its local Session position', {
        details: {
          sessionId: local.header.sessionId,
          eventId: event.eventId,
          expectedSequence,
          actualSequence: event.sequence,
        },
      })
    }
    if (lifecycle === 'ended') {
      throw new SessionError('SESSION_LOG_INVALID', 'local Session log continues after session/ended', {
        details: { sessionId: local.header.sessionId, eventId: event.eventId },
      })
    }
    const definition = catalog.resolve(event.type, event.payloadVersion)
    if (definition === undefined) {
      if (event.ignorable !== true) {
        throw new SessionError(
          'SESSION_EVENT_UNSUPPORTED',
          `required event ${event.type}@${event.payloadVersion} is not registered`,
          {
            details: {
              sessionId: event.sessionId,
              eventId: event.eventId,
              type: event.type,
              payloadVersion: event.payloadVersion,
            },
          },
        )
      }
      records.push(Object.freeze({ kind: 'opaque' as const, stored: event }))
      continue
    }
    const record = decodeKnown(event, definition)
    records.push(record)
    if (definition === sessionEndedEvent) lifecycle = 'ended'
  }
  if (local.position !== local.events.length) {
    throw new SessionError('SESSION_LOG_INVALID', 'Backend position differs from returned event count', {
      details: {
        sessionId: local.header.sessionId,
        position: local.position,
        eventCount: local.events.length,
      },
    })
  }
  return Object.freeze({
    header: local.header,
    through: sessionLogPosition(records.length),
    localLifecycle: lifecycle,
    events: Object.freeze(records),
    ...(local.incompleteTail === undefined ? {} : { incompleteTail: local.incompleteTail }),
  })
}

/** Append one already committed known record to an immutable local history segment. */
export function extendLocalSegment<TPayload extends JsonValue>(
  segment: SessionHistorySegment,
  event: CommittedSessionEvent<TPayload>,
): SessionHistorySegment {
  const events = Object.freeze([...segment.events, event])
  return Object.freeze({
    header: segment.header,
    through: sessionLogPosition(events.length),
    localLifecycle: event.stored.type === sessionEndedEvent.type ? 'ended' : segment.localLifecycle,
    events,
  })
}
