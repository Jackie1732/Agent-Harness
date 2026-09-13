import type { LocalStoredSession, SessionBackend } from './backend.js'
import type { DurableEventCatalog } from './event-catalog.js'
import { SessionError } from './errors.js'
import { materializeLocalSession } from './history.js'
import type { SessionId } from './ids.js'
import type { SessionHistorySegment } from './types.js'

/** Resolve and validate one root-to-target segmented Session history. */
export async function loadSessionHistory(
  backend: SessionBackend,
  catalog: DurableEventCatalog,
  target: LocalStoredSession,
  maxLineageDepth: number,
): Promise<readonly SessionHistorySegment[]> {
  const seen = new Set<SessionId>()
  const segments: SessionHistorySegment[] = []
  const visit = async (local: LocalStoredSession, depth: number): Promise<void> => {
    const sessionId = local.header.sessionId
    if (seen.has(sessionId)) {
      throw new SessionError('SESSION_LINEAGE_INVALID', 'Session lineage contains a cycle', {
        details: { sessionId },
      })
    }
    seen.add(sessionId)
    const parent = local.header.parent
    if (parent !== undefined) {
      if (depth >= maxLineageDepth) {
        throw new SessionError('SESSION_LINEAGE_LIMIT', 'Session lineage exceeds its configured depth', {
          details: { sessionId, maxLineageDepth },
        })
      }
      let parentLocal: LocalStoredSession
      try {
        parentLocal = await backend.readPrefix(parent.sessionId, parent.through)
      } catch (cause) {
        if (
          cause instanceof SessionError
          && (cause.code === 'SESSION_POSITION_INVALID' || cause.code === 'SESSION_NOT_FOUND')
        ) {
          throw new SessionError('SESSION_LINEAGE_INVALID', 'Session parent reference cannot be resolved', {
            details: { sessionId, parentSessionId: parent.sessionId, through: parent.through },
            cause,
          })
        }
        throw cause
      }
      await visit(parentLocal, depth + 1)
    }
    segments.push(materializeLocalSession(local, catalog))
  }
  await visit(target, 0)
  return Object.freeze(segments)
}
