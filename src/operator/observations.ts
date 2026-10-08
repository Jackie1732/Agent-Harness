import { setTimeout as delay } from 'node:timers/promises'
import type { ControlMethod, Params, SessionEventPage } from '../protocol/index.js'
import { METHOD_CATEGORIES } from '../protocol/index.js'
import type { OperatorResult, OperatorSession } from './types.js'
import { OperatorError } from './errors.js'

/** One polling task awaits its read and consumer before the next interval. Disposal aborts and joins it. */
export function watchOperatorObservation<M extends ControlMethod>(session: OperatorSession, method: M, params: Params<M>,
  onResult: (result: OperatorResult) => void | Promise<void>, options: { readonly signal?: AbortSignal } = {}) {
  if (METHOD_CATEGORIES[method] !== 'observation') throw new OperatorError('OPERATOR_USAGE_OBSERVATION_METHOD', 2)
  const abort = new AbortController(), signal = options.signal === undefined ? abort.signal : AbortSignal.any([options.signal, abort.signal])
  const task = (async () => {
    while (!signal.aborted) {
      const result = await session.execute(method, params, { signal })
      if (signal.aborted) return
      await onResult(result)
      try { await delay(session.profile.observation.pollIntervalMs, undefined, { signal }) }
      catch (error) { if (!signal.aborted) throw error }
    }
  })()
  // Consumers join disposal; observing the promise prevents an unhandled rejection before that join.
  void task.catch(() => undefined)
  return { dispose: () => { abort.abort(); return task } }
}

export interface OperatorFollowSummary {
  readonly type: 'follow-summary'; readonly pages: number; readonly events: number
  readonly lastSessionId: string | null; readonly lastSequence: number | null
  readonly stoppedBy: 'signal' | 'output-failure' | 'read-failure'
}

/** Exhaust one fixed cut, then start the next scan with after; a cursor never tracks future events. */
export async function followOperatorEvents(session: OperatorSession, params: Params<'session.events'>,
  onPage: (result: OperatorResult) => void | Promise<void>, options: { readonly signal?: AbortSignal } = {}): Promise<OperatorFollowSummary> {
  const signal = options.signal, budget = session.profile.observation
  let query = { ...params, maxEvents: Math.min(params.maxEvents, budget.maxPageEvents) }
  let pages = 0, events = 0, lastSessionId: string | null = null, lastSequence: number | null = null
  while (!signal?.aborted) {
    const result = await session.execute('session.events', query, signal === undefined ? {} : { signal })
    if (result.status !== 'ok') return { type: 'follow-summary', pages, events, lastSessionId, lastSequence, stoppedBy: signal?.aborted ? 'signal' : 'read-failure' }
    const page = result.result as SessionEventPage
    if (lastSessionId !== null && lastSessionId !== page.sessionId) throw new OperatorError('OPERATOR_BINDING_CHANGED', 2)
    // Restore only when the caller did not explicitly select a position or cursor.
    const restored = session.eventCheckpoint(page.sessionId)
    if (pages === 0 && query.cursor === undefined && query.after === undefined && restored !== undefined) {
      query = { target: params.target, maxEvents: query.maxEvents, after: restored }; continue
    }
    try { await onPage(result) }
    catch { return { type: 'follow-summary', pages, events, lastSessionId, lastSequence, stoppedBy: 'output-failure' } }
    pages++; events += page.events.length; lastSessionId = page.sessionId
    lastSequence = page.events.at(-1)?.sequence ?? lastSequence ?? (query.cursor === undefined ? query.after ?? 0 : query.cursor.nextSequence - 1)
    // A displayed/drained page is the only acknowledgement that permits advancing the checkpoint.
    try { await session.checkpoint(page.sessionId, page.hasMore ? lastSequence : page.through) }
    catch { return { type: 'follow-summary', pages, events, lastSessionId, lastSequence, stoppedBy: 'read-failure' } }
    if (page.hasMore && page.nextCursor !== null) query = { target: params.target, maxEvents: query.maxEvents, cursor: page.nextCursor }
    else {
      query = { target: params.target, maxEvents: query.maxEvents, after: page.through }
      try { await delay(budget.pollIntervalMs, undefined, signal === undefined ? {} : { signal }) }
      catch (error) { if (!signal?.aborted) throw error }
    }
  }
  return { type: 'follow-summary', pages, events, lastSessionId, lastSequence, stoppedBy: 'signal' }
}
