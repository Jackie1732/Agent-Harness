import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import { clockTimestamp } from '../foundation/clock.js'
import type { Clock } from '../foundation/clock.js'
import type { JsonValue } from '../foundation/json.js'
import type { DurableEventDefinition } from '../session/event-catalog.js'
import { SessionError } from '../session/errors.js'
import { extendLocalSegment } from '../session/history.js'
import { formatSessionEventId, sessionLogPosition, sessionSequence } from '../session/ids.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { CommittedSessionEvent, SessionSnapshot } from '../session/types.js'
import { AgentError } from './errors.js'
import { projectAgentSession } from './projection.js'
import { legacyAgentSessionEventDefinitions } from './session-events.js'
import type { AgentSessionSnapshot } from './state.js'

/** Conditional local writes only; callbacks cannot invoke providers or policy. */
export class AgentJournal {
  #faulted = false
  constructor(readonly session: SessionHandle, readonly conflicts: number, readonly clock: Clock) {
    if (legacyAgentSessionEventDefinitions.some(definition => !session.supportsEventDefinition(definition))) {
      throw new AgentError('AGENT_CATALOG_INCOMPATIBLE', 'agent-events-required')
    }
    if (!Number.isSafeInteger(conflicts) || conflicts < 0) throw new AgentError('AGENT_INPUT_INVALID', 'conflict-budget')
  }
  get faulted(): boolean { return this.#faulted || this.session.status !== 'open' }

  async append<T extends JsonValue>(definition: DurableEventDefinition<T>, decide: (state: AgentSessionSnapshot, snapshot: SessionSnapshot) => NoInfer<T>): Promise<CommittedSessionEvent<T>> {
    for (let attempt = 0; attempt <= this.conflicts; attempt++) {
      if (this.faulted) throw new AgentError('AGENT_INACTIVE', 'journal-not-writable')
      const snapshot = this.session.snapshot()
      const payload = definition.decode(decide(projectAgentSession(snapshot), snapshot))
      this.#preflight(snapshot, definition, payload)
      try { return await this.session.appendIfPosition(snapshot.localPosition, definition, payload) }
      catch (error) {
        if (error instanceof SessionError && error.code === 'SESSION_PRECONDITION_FAILED') continue
        this.#faulted = true
        throw new AgentError(error instanceof SessionError && error.code === 'SESSION_APPEND_OUTCOME_UNKNOWN' ? 'AGENT_COMMIT_UNKNOWN' : 'AGENT_WRITE_FAILED', 'agent-event-not-confirmed')
      }
    }
    throw new AgentError('AGENT_JOURNAL_CONFLICT', 'local-conflict-budget')
  }

  #preflight<T extends JsonValue>(snapshot: SessionSnapshot, definition: DurableEventDefinition<T>, payload: T): void {
    const sequence = sessionSequence(snapshot.localPosition + 1)
    const event: CommittedSessionEvent<T> = { kind: 'known', payload, stored: { envelopeVersion: 1, sessionId: snapshot.header.sessionId,
      eventId: formatSessionEventId(snapshot.header.sessionId, sequence), sequence, recordedAt: clockTimestamp(this.clock),
      type: definition.type, payloadVersion: definition.payloadVersion, payload } }
    if (canonicalJsonBytes({ ...event.stored }).byteLength > this.session.maxRecordBytes) throw new AgentError('AGENT_LIMIT_EXCEEDED', 'event-record-bytes')
    const history = snapshot.history.map(segment => segment.header.sessionId === snapshot.header.sessionId ? extendLocalSegment(segment, event) : segment)
    projectAgentSession({ ...snapshot, localPosition: sessionLogPosition(sequence), history })
  }
}
