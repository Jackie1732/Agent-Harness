import type { HostTimer } from './timer.js'
import { HostError } from './errors.js'
import type { WorkflowObservation } from '../protocol/results.js'
import { observeFinite } from './finite-observer.js'

export interface WorkflowWaitQuery {
  readonly until: 'settled' | 'closed'
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

/** Observation owns a finite timer and Host task; it never drives or cancels the durable workflow. */
export function workflowObserver(timer: HostTimer, scanIntervalMs: number,
  owner: { readonly stopSignal: AbortSignal; trackObservation<T>(task: () => Promise<T>): Promise<T> },
  assertExternalWait: () => void, observe: () => WorkflowObservation) {
  return (query: WorkflowWaitQuery) => {
    assertExternalWait()
    if (!['settled', 'closed'].includes(query.until) || !Number.isSafeInteger(query.timeoutMs) || query.timeoutMs < 1 || query.timeoutMs > 2_147_483_647) {
      throw new HostError('HOST_PROTOCOL_INVALID', 'workflow-wait-query')
    }
    return observeFinite(owner, timer, observe, report => query.until === 'closed' ? report.closed : report.settled,
      { timeoutMs: query.timeoutMs, scanIntervalMs, ...(query.signal === undefined ? {} : { signal: query.signal }) }).then(result => {
      const { instanceId: _instanceId, cuts: _cuts, recoveryRequired: _recoveryRequired, ...report } = result.observation
      return { ...result, report }
    })
  }
}
