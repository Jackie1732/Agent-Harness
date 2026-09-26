import { clockTimestamp } from '../foundation/clock.js'
import type { Clock } from '../foundation/clock.js'
import type { JsonValue } from '../foundation/json.js'
import { encodeStoredSessionEvent } from '../session/codec.js'
import type { DurableEventDefinition } from '../session/event-catalog.js'
import { SessionError } from '../session/errors.js'
import { extendLocalSegment } from '../session/history.js'
import { formatSessionEventId, sessionLogPosition, sessionSequence } from '../session/ids.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { WorkflowError } from './errors.js'
import { projectWorkflowSession } from './projection.js'
import type { WorkflowSnapshot } from './projection.js'

/** Conditional coordinator transitions validate their complete replay before any append. */
export class WorkflowJournal {
  #faulted = false
  constructor(readonly session: SessionHandle, readonly clock: Clock) {}

  async append<T extends JsonValue>(definition: DurableEventDefinition<T>,
    decide: (state: WorkflowSnapshot) => NoInfer<T>): Promise<CommittedSessionEvent<T>> {
    for (let attempt = 0; ; attempt++) {
      if (this.#faulted || this.session.status !== 'open') throw new WorkflowError('WORKFLOW_ADMISSION_BLOCKED', 'coordinator-journal-closed')
      const snapshot = this.session.snapshot()
      const state = projectWorkflowSession(snapshot)
      const payload = definition.decode(decide(state))
      const sequence = sessionSequence(snapshot.localPosition + 1)
      const event: CommittedSessionEvent<T> = { kind: 'known', payload, stored: { envelopeVersion: 1,
        sessionId: snapshot.header.sessionId, eventId: formatSessionEventId(snapshot.header.sessionId, sequence), sequence,
        recordedAt: clockTimestamp(this.clock), type: definition.type, payloadVersion: definition.payloadVersion, payload } }
      if (encodeStoredSessionEvent(event.stored).byteLength > this.session.maxRecordBytes) throw new WorkflowError('WORKFLOW_ADMISSION_BLOCKED', 'workflow-record-size')
      projectWorkflowSession({ ...snapshot, localPosition: sessionLogPosition(sequence), history: snapshot.history.map(segment =>
        segment.header.sessionId === snapshot.header.sessionId ? extendLocalSegment(segment, event) : segment) })
      try { return await this.session.appendIfPosition(snapshot.localPosition, definition, payload) }
      catch (cause) {
        if (cause instanceof SessionError && cause.code === 'SESSION_PRECONDITION_FAILED'
          && attempt < (state.definition?.payload.limits.maxCommitConflicts ?? 0)) continue
        if (cause instanceof SessionError && cause.code === 'SESSION_APPEND_OUTCOME_UNKNOWN') {
          this.#faulted = true
          throw new WorkflowError('WORKFLOW_COMMIT_UNKNOWN', 'coordinator-commit-unknown')
        }
        throw cause
      }
    }
  }
}
