import { METHOD_CATEGORIES } from '../protocol/index.js'
import type { ControlMethod, MethodCategory } from '../protocol/index.js'
import type { ApiLimits } from './config.js'
import { ApiRejection } from './errors.js'

/** Class quotas cover domain settlement; bounded HTTP output has its own owner. */
export class ApiAdmission {
  readonly #counts: Record<MethodCategory, number> = { business: 0, input: 0, control: 0, observation: 0, management: 0 }
  readonly #maximum: Record<MethodCategory, number>
  constructor(limits: ApiLimits) {
    this.#maximum = { business: 1, input: limits.maxPendingInputs, control: limits.maxPendingControls,
      observation: limits.maxObservers, management: limits.maxPendingShutdowns }
  }
  async run<T>(method: ControlMethod, operation: () => Promise<T>): Promise<T> {
    const category = METHOD_CATEGORIES[method]
    if (this.#counts[category] >= this.#maximum[category]) throw new ApiRejection('API_CAPACITY_EXCEEDED', category === 'observation' ? 'not-applicable' : 'not-accepted')
    this.#counts[category]++
    try { return await operation() } finally { this.#counts[category]-- }
  }
}
