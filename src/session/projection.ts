import { snapshotJson } from '../foundation/json.js'
import type { JsonValue } from '../foundation/json.js'
import { SessionError } from './errors.js'
import type {
  IgnoredSessionEvent,
  SessionProjection,
  SessionProjectionCoverage,
  SessionProjectionResult,
  SessionSnapshot,
} from './types.js'

/** Replay an immutable Session Snapshot through one pure JSON Projection. */
export function projectSession<TState extends JsonValue>(
  snapshot: SessionSnapshot,
  projection: SessionProjection<TState>,
): SessionProjectionResult<TState> {
  if (projection.name.length === 0) throw new TypeError('projection name must not be empty')
  let state: TState
  try {
    state = snapshotJson(projection.initial(snapshot.header), 'projection initial state') as TState
  } catch (cause) {
    throw new SessionError('SESSION_PROJECTION_FAILED', `Projection ${projection.name} failed to initialize`, {
      details: { projection: projection.name },
      cause,
    })
  }
  const ignored: IgnoredSessionEvent[] = []
  const coverage: SessionProjectionCoverage[] = []
  for (const segment of snapshot.history) {
    coverage.push(Object.freeze({ sessionId: segment.header.sessionId, through: segment.through }))
    for (const event of segment.events) {
      if (event.kind === 'opaque') {
        ignored.push(Object.freeze({
          sessionId: event.stored.sessionId,
          eventId: event.stored.eventId,
          sequence: event.stored.sequence,
          type: event.stored.type,
          payloadVersion: event.stored.payloadVersion,
        }))
        continue
      }
      try {
        state = snapshotJson(projection.apply(state, event), 'projection state') as TState
      } catch (cause) {
        throw new SessionError('SESSION_PROJECTION_FAILED', `Projection ${projection.name} failed`, {
          details: {
            projection: projection.name,
            sessionId: event.stored.sessionId,
            eventId: event.stored.eventId,
          },
          cause,
        })
      }
    }
  }
  return Object.freeze({
    state,
    coverage: Object.freeze(coverage),
    ignoredEvents: Object.freeze(ignored),
  })
}
