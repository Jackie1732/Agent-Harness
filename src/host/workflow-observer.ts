import type { HostWorkflows } from './workflows.js'
import type { HostTimer } from './timer.js'
import { HostError } from './errors.js'

export interface WorkflowWaitQuery {
  readonly until: 'settled' | 'closed'
  readonly timeoutMs: number
  readonly signal?: AbortSignal
}

/** Observation owns a finite timer and Host task; it never drives or cancels the durable workflow. */
export function workflowObserver(domain: HostWorkflows, key: string, timer: HostTimer, scanIntervalMs: number,
  owner: { readonly stopSignal: AbortSignal; trackObservation<T>(task: () => Promise<T>): Promise<T> },
  assertExternalWait: () => void) {
  return (query: WorkflowWaitQuery) => {
    assertExternalWait()
    if (!['settled', 'closed'].includes(query.until) || !Number.isSafeInteger(query.timeoutMs) || query.timeoutMs < 1 || query.timeoutMs > 2_147_483_647) {
      throw new HostError('HOST_PROTOCOL_INVALID', 'workflow-wait-query')
    }
    const deadline = timer.now() + query.timeoutMs
    const signal = query.signal === undefined ? owner.stopSignal : AbortSignal.any([owner.stopSignal, query.signal])
    return owner.trackObservation(async () => {
      let report = domain.report(key)
      while (true) {
        if (owner.stopSignal.aborted) return { status: 'host-closed' as const, report }
        signal.throwIfAborted()
        report = domain.report(key)
        if (query.until === 'closed' ? report.closed : report.settled) return { status: 'condition-met' as const, report }
        const remaining = deadline - timer.now()
        if (remaining <= 0) return { status: 'timeout' as const, report }
        await timer.wait(Math.min(scanIntervalMs, remaining), signal)
      }
    })
  }
}
