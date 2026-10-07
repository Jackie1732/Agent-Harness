import type { HostTimer } from './timer.js'
import { HostError } from './errors.js'
import type { WaitResult } from '../protocol/results.js'

export interface FiniteObservationQuery { readonly timeoutMs: number; readonly scanIntervalMs: number; readonly signal?: AbortSignal }
export interface ObservationOwner { readonly stopSignal: AbortSignal; trackObservation<T>(task: () => Promise<T>): Promise<T> }

/** A finite observer owns its timer and returns the last certified data when its Host stops. */
export function observeFinite<T extends { readonly recoveryRequired: boolean }>(owner: ObservationOwner, timer: HostTimer,
  read: () => T, condition: (value: T) => boolean, query: FiniteObservationQuery): Promise<WaitResult<T>> {
  if (!Number.isSafeInteger(query.timeoutMs) || query.timeoutMs < 1 || query.timeoutMs > 2_147_483_647
    || !Number.isSafeInteger(query.scanIntervalMs) || query.scanIntervalMs < 1 || query.scanIntervalMs > 2_147_483_647) throw new HostError('HOST_PROTOCOL_INVALID', 'observation-timeout')
  const deadline = timer.now() + query.timeoutMs
  const signal = query.signal === undefined ? owner.stopSignal : AbortSignal.any([owner.stopSignal, query.signal])
  if (owner.stopSignal.aborted) throw new HostError('HOST_INACTIVE', 'observation-before-host-stop')
  query.signal?.throwIfAborted()
  let observation = read()
  return owner.trackObservation(async () => {
    let initial = true
    while (true) {
      if (owner.stopSignal.aborted) return { status: 'host-closed', observation }
      signal.throwIfAborted()
      if (!initial) observation = read()
      initial = false
      if (condition(observation)) return { status: 'condition-met', observation }
      if (observation.recoveryRequired) throw new HostError('HOST_RECOVERY_REQUIRED', 'observation-recovery-blocked')
      const remaining = deadline - timer.now()
      if (remaining <= 0) return { status: 'timeout', observation }
      await timer.wait(Math.min(query.scanIntervalMs, remaining), signal)
    }
  })
}
