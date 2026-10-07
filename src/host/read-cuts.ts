import type { SessionProjectionCoverage, SessionSnapshot } from '../session/types.js'

/** Prefixes actually consumed by a Session projection. */
export function snapshotCuts(snapshot: SessionSnapshot): readonly SessionProjectionCoverage[] {
  return snapshot.history.map(segment => ({ sessionId: segment.header.sessionId, through: segment.through }))
}

/** A longer consumed prefix includes every shorter prefix of the same immutable log. */
export function mergeCuts(cuts: readonly SessionProjectionCoverage[]): readonly SessionProjectionCoverage[] {
  const result = new Map<string, SessionProjectionCoverage>()
  for (const cut of cuts) {
    const previous = result.get(cut.sessionId)
    if (previous === undefined || previous.through < cut.through) result.set(cut.sessionId, cut)
  }
  return Object.freeze([...result.values()])
}
