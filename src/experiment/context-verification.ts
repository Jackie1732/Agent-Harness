import { projectAgentSession } from '../agent/projection.js'
import { projectContextSession, readAssembly, rebuildAssembly } from '../context/projection.js'
import { equalJson } from '../context/validation.js'
import { modelPreparedEvent } from '../model/session-events.js'
import type { SessionEventId } from '../session/ids.js'
import type { SessionSnapshot } from '../session/types.js'
import type { WorkflowEventRef } from '../workflow/types.js'
import { experimentJsonDigest } from './parsing.js'

/** Context reconstruction and adoption observations over the supplied immutable local cuts. */
export interface ExperimentContextVerification {
  readonly complete: boolean
  readonly reasons: readonly string[]
  readonly refs: readonly WorkflowEventRef[]
}

/**
 * Rebuild saved neutral requests without a Host, Writer, Provider, or current Tool registry.
 * @param snapshots Immutable snapshots at the selected local evidence cuts.
 * @returns Reconstruction failures, unsupported renderers and the inspected event identities.
 */
export function verifyExperimentContexts(snapshots: readonly SessionSnapshot[]): ExperimentContextVerification {
  const reasons: string[] = []
  const refs = new Map<string, WorkflowEventRef>()
  const inspected = new Set<string>()
  const addRef = (snapshot: SessionSnapshot, eventId: SessionEventId) => {
    const ref = { address: snapshot.address, eventId }
    refs.set(`${ref.address}\u0000${ref.eventId}`, ref)
  }
  for (const snapshot of snapshots) {
    const cutKey = `${snapshot.address}\u0000${snapshot.localPosition}`
    if (inspected.has(cutKey)) continue
    inspected.add(cutKey)
    const events = snapshot.history.at(-1)!.events
    try {
      // Agent decisions carry an explicit assembly claim; independent Model calls need no claim.
      if (events.some(event => event.stored.type === 'agent/spec-recorded')) projectAgentSession(snapshot)
      const context = projectContextSession(snapshot)
      for (const assembly of context.assemblies) {
        const eventId = assembly.committed.stored.eventId
        addRef(snapshot, eventId)
        try {
          const read = readAssembly(snapshot, eventId)
          const rebuilt = rebuildAssembly(snapshot, eventId)
          if (rebuilt.kind === 'unsupported') {
            reasons.push(`context-renderer-unsupported:${rebuilt.version}:${eventId}`)
            continue
          }
          if (experimentJsonDigest(rebuilt.request) !== read.committed.payload.requestDigest) {
            reasons.push(`context-request-digest-mismatch:${eventId}`)
            continue
          }
          if (read.adoption.kind !== 'adopted') continue
          const preparedId = read.adoption.preparedEventId
          addRef(snapshot, preparedId)
          const prepared = events.find(event => event.stored.eventId === preparedId)!
          const payload = modelPreparedEvent.decode(prepared.stored.payload)
          if (payload.invocationId !== read.adoption.invocationId
            || !equalJson(payload.submission.request, rebuilt.request)
            || !equalJson(payload.submission.binding, read.committed.payload.selection.target.provider)) {
            reasons.push(`context-model-source-mismatch:${eventId}`)
          }
        } catch (cause) {
          reasons.push(`context-rebuild-failed:${failureCode(cause)}:${eventId}`)
        }
      }
    } catch (cause) {
      reasons.push(`context-projection-failed:${failureCode(cause)}:${snapshot.address}`)
    }
  }
  return { complete: reasons.length === 0, reasons: [...new Set(reasons)], refs: [...refs.values()] }
}

function failureCode(cause: unknown): string {
  return cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? cause.code : 'invalid-saved-context'
}
