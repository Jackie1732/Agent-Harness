import type { CommittedSessionEvent, SessionSnapshot } from '../session/types.js'
import { parseSessionEventId } from '../session/ids.js'
import type { HostSessionPlanned, HostSessionReady, HostAgentPlannedV2, HostAgentReadyV2 } from './session-events.js'
import { hostSessionPlannedEvent, hostSessionReadyEvent, hostSessionPlannedV2Event, hostSessionReadyV2Event } from './session-events.js'
import { HostError } from './errors.js'

export interface HostSessionBinding {
  readonly planned: CommittedSessionEvent<HostSessionPlanned | HostAgentPlannedV2> | null
  readonly ready: CommittedSessionEvent<HostSessionReady | HostAgentReadyV2> | null
}
/** Interpret only the target Session's local Host binding facts. */
export function projectHostSession(snapshot: SessionSnapshot): HostSessionBinding {
  if (snapshot.header.parent !== undefined) throw new HostError('HOST_BINDING_CONFLICT', 'fork-session-not-supported')
  const local = snapshot.history.at(-1)
  if (local?.header.sessionId !== snapshot.header.sessionId) throw new HostError('HOST_BINDING_CONFLICT', 'missing-local-history')
  let planned: CommittedSessionEvent<HostSessionPlanned> | null = null
  let ready: CommittedSessionEvent<HostSessionReady> | null = null
  const sources = new Map<string, CommittedSessionEvent>()
  for (const record of local.events) {
    if (record.kind !== 'known') continue
    if (record.stored.type === hostSessionPlannedEvent.type) {
      if (planned !== null) throw new HostError('HOST_BINDING_CONFLICT', 'duplicate-host-plan')
      let payload: HostSessionPlanned | HostAgentPlannedV2
      if (record.stored.payloadVersion === 1) payload = hostSessionPlannedEvent.decode(record.payload)
      else if (record.stored.payloadVersion === 2) {
        const decoded = hostSessionPlannedV2Event.decode(record.payload)
        if (decoded.kind !== 'agent') throw new HostError('HOST_BINDING_CONFLICT', 'host-plan-kind')
        payload = decoded
      } else throw new HostError('HOST_BINDING_CONFLICT', 'host-plan-version')
      planned = { ...record, payload }
    } else if (record.stored.type === hostSessionReadyEvent.type) {
      if (ready !== null) throw new HostError('HOST_BINDING_CONFLICT', 'duplicate-host-ready')
      let payload: HostSessionReady | HostAgentReadyV2
      if (record.stored.payloadVersion === 1) payload = hostSessionReadyEvent.decode(record.payload)
      else if (record.stored.payloadVersion === 2) {
        const decoded = hostSessionReadyV2Event.decode(record.payload)
        if (decoded.kind !== 'agent') throw new HostError('HOST_BINDING_CONFLICT', 'host-ready-kind')
        payload = decoded
      } else throw new HostError('HOST_BINDING_CONFLICT', 'host-ready-version')
      if (payload.through !== record.stored.sequence - 1) throw new HostError('HOST_BINDING_CONFLICT', 'ready-cut')
      const profile = sources.get(payload.profile); const spec = sources.get(payload.spec)
      if (profile?.stored.type !== 'context/profile-recorded' || profile.stored.payloadVersion !== (spec === undefined ? 0 : spec.stored.payloadVersion + 1)
        || spec?.stored.type !== 'agent/spec-recorded' || ![1, 2, 3].includes(spec.stored.payloadVersion)) throw new HostError('HOST_BINDING_CONFLICT', 'ready-source')
      if (parseSessionEventId(payload.profile).sessionId !== snapshot.header.sessionId
        || parseSessionEventId(payload.spec).sessionId !== snapshot.header.sessionId) throw new HostError('HOST_BINDING_CONFLICT', 'ready-foreign-source')
      if (payload.mode === 'initialized' && (planned === null || planned.stored.payloadVersion !== record.stored.payloadVersion
        || payload.planned !== planned.stored.eventId
        || payload.hostKey !== planned.payload.hostKey || payload.agentKey !== planned.payload.agentKey)) {
        throw new HostError('HOST_BINDING_CONFLICT', 'ready-plan-mismatch')
      }
      ready = { ...record, payload }
    }
    sources.set(record.stored.eventId, record)
  }
  if (ready !== null && planned !== null && ready.payload.mode === 'adopted') throw new HostError('HOST_BINDING_CONFLICT', 'adopted-with-plan')
  return Object.freeze({ planned, ready })
}
