import type { HostSlot } from './runtime-types.js'
import { projectCommunicationFacts } from '../communication/projection.js'

/** Discardable projections keyed by slot generation, committed position and UTC time gate. */
export class HostObservations {
  readonly #cache = new WeakMap<HostSlot, { position: number; observedAt: number; value: ReturnType<typeof observe> }>()

  read(slot: HostSlot, now: number) {
    const position = slot.session.snapshot().localPosition
    const previous = this.#cache.get(slot)
    const deadline = previous?.value.readiness.nextWakeAt
    if (previous !== undefined && previous.position === position && now >= previous.observedAt
      && (deadline === null || deadline !== undefined && now < Date.parse(deadline))) return previous.value
    const value = observe(slot, now)
    this.#cache.set(slot, { position, observedAt: now, value })
    return value
  }
}

function observe(slot: HostSlot, now: number) {
  return { readiness: slot.agent.readiness(new Date(now).toISOString(), slot.selection), agent: slot.agent.report(), roots: slot.agent.snapshot().roots,
    communication: projectCommunicationFacts(slot.session.snapshot()) }
}
