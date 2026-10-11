import type { HostSlot } from './runtime-types.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import type { MessageCatalog } from '../communication/message-catalog.js'
import { inspectAgentReadiness } from '../agent/readiness.js'
import { projectAgentReport } from '../agent/report.js'
import { projectAgentSession } from '../agent/projection.js'
import type { SessionSnapshot } from '../session/types.js'

/** Discardable projections keyed by slot generation, committed position and UTC time gate. */
export class HostObservations {
  readonly #cache = new WeakMap<HostSlot, { position: number; observedAt: number; value: ReturnType<typeof observe> }>()

  read(slot: HostSlot, now: number, catalog: MessageCatalog) {
    const snapshot = slot.session.snapshot()
    const position = snapshot.localPosition
    const previous = this.#cache.get(slot)
    const deadline = previous?.value.readiness.nextWakeAt
    if (previous !== undefined && previous.position === position && now >= previous.observedAt
      && (deadline === null || deadline !== undefined && now < Date.parse(deadline))) return previous.value
    const value = observe(slot, snapshot, now, catalog)
    this.#cache.set(slot, { position, observedAt: now, value })
    return value
  }
}

function observe(slot: HostSlot, snapshot: SessionSnapshot, now: number, catalog: MessageCatalog) {
  return { readiness: inspectAgentReadiness(snapshot, catalog, new Date(now).toISOString(), slot.selection),
    agent: projectAgentReport(snapshot), roots: projectAgentSession(snapshot).roots,
    communication: projectCommunicationFacts(snapshot) }
}
