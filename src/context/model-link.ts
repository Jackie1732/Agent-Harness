import type { CommittedSessionEvent, SessionSnapshot } from '../session/types.js'
import { modelPreparedEvent } from '../model/session-events.js'
import type { ModelPreparedPayload } from '../model/session-events.js'
import type { ContextAdoption, ContextAssembly } from './contract.js'
import { decodeContextAssembly } from './assembly-codec.js'
import { equalJson } from './validation.js'

/** Position, complete neutral content and complete safe binding must all agree. */
export function contextModelAdoption(snapshot: SessionSnapshot, assembly: CommittedSessionEvent<ContextAssembly>): ContextAdoption {
  const local = snapshot.history.find(segment => segment.header.sessionId === assembly.stored.sessionId)
  const next = local?.events[assembly.stored.sequence]
  if (next === undefined) return { kind: 'not-yet-adopted' }
  const notAdopted: ContextAdoption = { kind: 'not-adopted-at-next-event', eventId: next.stored.eventId }
  if (next.kind !== 'known' || next.stored.type !== modelPreparedEvent.type || next.stored.payloadVersion !== 1 || next.stored.ignorable === true) return notAdopted
  const payload = modelPreparedEvent.decode(next.payload)
  if (!equalJson(payload.submission.request, assembly.payload.request)
    || !equalJson(payload.submission.binding, assembly.payload.selection.target.provider)) return notAdopted
  return { kind: 'adopted', preparedEventId: next.stored.eventId, invocationId: payload.invocationId }
}
/** A nonmatching independent model call remains legal; it simply has no Context adoption relation. */
export function precedingContextAssembly(snapshot: SessionSnapshot, prepared: CommittedSessionEvent<ModelPreparedPayload>): CommittedSessionEvent<ContextAssembly> | undefined {
  const local = snapshot.history.find(segment => segment.header.sessionId === prepared.stored.sessionId)
  const previous = local?.events[prepared.stored.sequence - 2]
  if (previous?.kind !== 'known' || previous.stored.type !== 'context/assembly-committed' || previous.stored.payloadVersion !== 1 || previous.stored.ignorable === true) return undefined
  const assembly = { ...previous, payload: decodeContextAssembly(previous.payload) }
  const adoption = contextModelAdoption(snapshot, assembly)
  return adoption.kind === 'adopted' && adoption.preparedEventId === prepared.stored.eventId ? Object.freeze(assembly) : undefined
}
