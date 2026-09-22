import { EffectOwner } from '../effect/owner.js'
import { HostError } from './errors.js'
import type { HostSlot } from './runtime-types.js'

/** Owns every generation of one member; incomplete cleanup permanently closes acquisition. */
export class HostSlotOwner {
  readonly #effects: EffectOwner
  readonly #acquire: () => Promise<HostSlot>
  readonly #agentKey: string
  #generation = 0
  #state: 'offline-clean' | 'starting' | 'online' | 'stopping' | 'cleanup-incomplete' = 'offline-clean'
  #failure: unknown
  #dispose: Promise<void> | undefined

  constructor(agentKey: string, acquire: () => Promise<HostSlot>) {
    this.#effects = new EffectOwner(`host-slot:${agentKey}`)
    this.#acquire = acquire
    this.#agentKey = agentKey
  }

  async open(): Promise<HostSlot> {
    if (this.#failure !== undefined) throw new HostError('HOST_CLEANUP_FAILED', 'slot-cleanup-incomplete',
      { agentKey: this.#agentKey, generation: this.#generation }, { cause: this.#failure })
    if (this.#dispose !== undefined || this.#state !== 'offline-clean') throw new HostError('HOST_NOT_READY', 'slot-generation-unavailable')
    this.#state = 'starting'
    const generation = ++this.#generation
    try {
      const lease = await this.#effects.run(`slot generation ${generation}`, effect => effect.apply('Agent slot', this.#acquire, async slot => {
        this.#state = 'stopping'
        try { await slot.dispose(); this.#state = 'offline-clean' }
        catch (cause) {
          this.#state = 'cleanup-incomplete'
          this.#failure = new HostError('HOST_CLEANUP_FAILED', 'slot-generation-cleanup-failed',
            { agentKey: this.#agentKey, generation }, { cause })
          throw this.#failure
        }
      }))
      this.#state = 'online'
      return Object.freeze({ ...lease.value, dispose: () => lease.dispose() })
    } catch (cause) {
      if (cause instanceof HostError && cause.code === 'HOST_CLEANUP_FAILED') {
        this.#state = 'cleanup-incomplete'; this.#failure = cause
      } else if (this.#failure === undefined) this.#state = 'offline-clean'
      throw cause
    }
  }

  dispose(): Promise<void> {
    this.#dispose ??= Promise.resolve().then(async () => {
      await this.#effects.dispose()
      if (this.#failure !== undefined) throw this.#failure
    })
    return this.#dispose
  }
}
