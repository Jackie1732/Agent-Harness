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
import type { AgentInput } from './contract.js'
import { decodeAgentInput } from './input-codec.js'
import { agentInputAcceptedEvent } from './session-events.js'
import { agentKeyedInputAcceptedEvent } from './session-events.js'
import { decodeInputSubmission } from './input-submission.js'
import type { AgentInputSubmission, AgentKeyedInputAccepted } from './input-submission.js'
import { equal } from './validation.js'

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

  /** Input acceptance survives replacement of Model and Tool execution resources. */
  acceptInput(value: AgentInput) {
    const input = decodeAgentInput(value)
    return this.append(agentInputAcceptedEvent, state => ({ spec: state.spec!.stored.eventId, input }))
  }

  /** Reuse an identical local submission before checking mutable Wait disposition. */
  async acceptKeyedInput(value: AgentInput, identity: AgentInputSubmission): Promise<{ readonly event: CommittedSessionEvent<AgentKeyedInputAccepted>; readonly reused: boolean }> {
    const input = decodeAgentInput(value); const submission = decodeInputSubmission(identity)
    if (!this.session.supportsEventDefinition(agentKeyedInputAcceptedEvent)) throw new AgentError('AGENT_CATALOG_INCOMPATIBLE', 'keyed-input-events-required')
    for (let attempt = 0; attempt <= this.conflicts; attempt++) {
      const snapshot = this.session.snapshot(); const state = projectAgentSession(snapshot)
      const prior = state.inputs.find(item => item.submission?.namespace === submission.namespace && item.submission.key === submission.key)
      if (prior !== undefined) {
        if (!equal(prior.input, input)) throw new AgentError('AGENT_KEY_CONFLICT', 'submission-content-conflict')
        const local = snapshot.history.find(segment => segment.header.sessionId === snapshot.header.sessionId)!
        const event = local.events.find(item => item.stored.eventId === prior.reference.eventId)!
        return { event: { kind: 'known', stored: event.stored, payload: agentKeyedInputAcceptedEvent.decode(event.stored.payload) }, reused: true }
      }
      if (this.faulted) throw new AgentError('AGENT_RECOVERY_REQUIRED', 'submission-absence-not-certified')
      const payload = agentKeyedInputAcceptedEvent.decode({ spec: state.spec!.stored.eventId, input, submission })
      this.#preflight(snapshot, agentKeyedInputAcceptedEvent, payload)
      try { return { event: await this.session.appendIfPosition(snapshot.localPosition, agentKeyedInputAcceptedEvent, payload), reused: false } }
      catch (error) {
        if (error instanceof SessionError && error.code === 'SESSION_PRECONDITION_FAILED') continue
        this.#faulted = true
        throw new AgentError(error instanceof SessionError && error.code === 'SESSION_APPEND_OUTCOME_UNKNOWN' ? 'AGENT_COMMIT_UNKNOWN' : 'AGENT_WRITE_FAILED', 'agent-event-not-confirmed')
      }
    }
    throw new AgentError('AGENT_JOURNAL_CONFLICT', 'local-conflict-budget')
  }

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
