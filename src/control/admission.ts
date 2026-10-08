import { METHOD_CATEGORIES } from '../protocol/index.js'
import type { ControlMethod, MethodCategory } from '../protocol/index.js'
import type { AtomicHost } from '../host/runtime.js'
import type { ControlAdmissionLimits } from './types.js'
import { ControlRejection } from './errors.js'

/**
 * Existing business activity rejects new drive requests before consuming category admission.
 * @param host Current Host business activity.
 * @param method Requested control method.
 */
export function assertControlActivity(host: AtomicHost, method: ControlMethod): void {
  if (METHOD_CATEGORIES[method] === 'business' && host.activity !== 'idle') throw new ControlRejection('API_BUSY')
}

/** Class quotas cover domain settlement; each consumer owns its remaining output work. */
export class ControlAdmission {
  readonly #counts: Record<MethodCategory, number> = { business: 0, input: 0, control: 0, observation: 0, management: 0 }
  readonly #maximum: Record<MethodCategory, number>
  constructor(limits: ControlAdmissionLimits) {
    this.#maximum = { business: 1, input: limits.maxPendingInputs, control: limits.maxPendingControls,
      observation: limits.maxObservers, management: limits.maxPendingShutdowns }
  }
  /**
   * Reserve one category slot without queuing and release it at domain settlement.
   * @param method Requested control method.
   * @param operation Domain operation whose settlement releases the slot.
   * @returns The original domain result or failure.
   */
  async run<T>(method: ControlMethod, operation: () => Promise<T>): Promise<T> {
    const category = METHOD_CATEGORIES[method]
    if (this.#counts[category] >= this.#maximum[category]) throw new ControlRejection('API_CAPACITY_EXCEEDED', category === 'observation' ? 'not-applicable' : 'not-accepted')
    this.#counts[category]++
    try { return await operation() } finally { this.#counts[category]-- }
  }
}
