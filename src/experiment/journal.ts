import { SerialGate } from '../foundation/serial-gate.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonValue } from '../foundation/json.js'
import type { SessionHandle } from '../session/session-handle.js'
import { formatSessionEventId, sessionSequence } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { DurableEventDefinition } from '../session/event-catalog.js'
import { SessionError } from '../session/errors.js'
import type { ExperimentPlan } from './definition-types.js'
import type { ExperimentEventKind, ExperimentEventPayloads } from './journal-types.js'
import { experimentEvents } from './journal-events.js'
import { applyExperimentJournalEvent, experimentEventKey, projectExperimentJournal } from './journal-projection.js'
import { ExperimentError } from './errors.js'

/** Serial domain admission over one Effect-owned Session Writer. A failed append stops new admission. */
export class ExperimentJournal {
  readonly #handle: SessionHandle
  readonly #gate = new SerialGate()
  #accepting = true
  constructor(handle: SessionHandle) { this.#handle = handle; projectExperimentJournal(handle.snapshot()) }
  get accepting(): boolean { return this.#accepting && this.#handle.status === 'open' }
  snapshot() { return projectExperimentJournal(this.#handle.snapshot()) }
  recordPlan(plan: ExperimentPlan) { return this.append('plan-recorded', { plan: plan as unknown as ExperimentEventPayloads['plan-recorded']['plan'] }) }
  startUnit(payload: ExperimentEventPayloads['unit-started']) { return this.append('unit-started', payload) }
  sealUnit(payload: ExperimentEventPayloads['unit-sealed']) { return this.append('unit-sealed', payload) }
  unresolveUnit(payload: ExperimentEventPayloads['unit-unresolved']) { return this.append('unit-unresolved', payload) }
  recordEvidence(payload: ExperimentEventPayloads['evidence-recorded']) { return this.append('evidence-recorded', payload) }
  settleEvaluation(payload: ExperimentEventPayloads['evaluation-settled']) { return this.append('evaluation-settled', payload) }
  recordReport(payload: ExperimentEventPayloads['report-recorded']) { return this.append('report-recorded', payload) }
  finalize(payload: ExperimentEventPayloads['finalized']) { return this.append('finalized', payload) }

  /** Commit one validated transition, or return its exact already committed fact. */
  append<K extends ExperimentEventKind>(kind: K, payload: ExperimentEventPayloads[K]): Promise<CommittedSessionEvent<ExperimentEventPayloads[K]>> {
    return this.#gate.run(async () => {
      if (!this.accepting) throw new ExperimentError('EXPERIMENT_INACTIVE', 'journal-no-longer-accepting')
      const definition = experimentEvents[kind] as DurableEventDefinition<ExperimentEventPayloads[K]>
      const decoded = definition.decode(payload as JsonValue) as ExperimentEventPayloads[K]
      const snapshot = this.#handle.snapshot()
      const key = experimentEventKey(kind, decoded)
      const existing = snapshot.history[0]!.events.find(event => event.kind === 'known' && event.stored.type === definition.type
        && experimentEventKey(kind, event.payload as ExperimentEventPayloads[K]) === key)
      if (existing?.kind === 'known') {
        if (!Buffer.from(canonicalJsonBytes(existing.payload)).equals(Buffer.from(canonicalJsonBytes(decoded as JsonValue)))) throw new ExperimentError('EXPERIMENT_CONFLICT', 'journal-command-content-changed')
        return existing as CommittedSessionEvent<ExperimentEventPayloads[K]>
      }
      const sequence = sessionSequence(snapshot.localPosition + 1)
      const candidate = { kind: 'known' as const, stored: { envelopeVersion: 1 as const, sessionId: snapshot.header.sessionId,
        eventId: formatSessionEventId(snapshot.header.sessionId, sequence), sequence, recordedAt: '9999-12-31T23:59:59.999Z',
        type: definition.type, payloadVersion: 1, payload: decoded as JsonValue }, payload: decoded }
      applyExperimentJournalEvent(projectExperimentJournal(snapshot), kind, candidate)
      try { return await this.#handle.appendIfPosition(snapshot.localPosition, definition, decoded as JsonValue) as CommittedSessionEvent<ExperimentEventPayloads[K]> }
      catch (cause) {
        this.#accepting = false
        if (cause instanceof SessionError && cause.code !== 'SESSION_APPEND_OUTCOME_UNKNOWN') throw cause
        throw new ExperimentError('EXPERIMENT_COMMIT_UNKNOWN', 'journal-append-failed-admission-closed', { kind }, { cause })
      }
    })
  }
  /** Stop admission and join domain commits; Session release remains with its storage owner. */
  async dispose(): Promise<void> { this.#accepting = false; await this.#gate.drain() }
}
