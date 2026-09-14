import { HarnessError } from '../foundation/error.js'
import type { JsonValue } from '../foundation/json.js'
import type { DurableEventDefinition } from '../session/event-catalog.js'
import { formatSessionEventId, sessionLogPosition, sessionSequence } from '../session/ids.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { CommittedSessionEvent, SessionSnapshot } from '../session/types.js'
import { assertRecordCapacity } from './budget.js'
import type { ToolRequestedPayload, ToolSettlement } from './contract.js'
import { ToolError } from './errors.js'
import type { ToolInvocationId } from './ids.js'
import { projectToolSession } from './projection.js'
import type { ToolInvocationSnapshot } from './projection.js'
import { toolAuthorizationEvent, toolRequestedEvent, toolSettledEvent, toolStartedEvent } from './session-events.js'
import { sourceKey } from './source.js'
import { equalJson } from './validation.js'

/** Local conditional log work only. Policy/acquire/start never enter its retry loop. */
export class ToolJournal {
  constructor(readonly handle: SessionHandle, readonly maxConflicts: number) {}

  async request(payload: ToolRequestedPayload): Promise<
    { readonly kind: 'created'; readonly event: CommittedSessionEvent<ToolRequestedPayload> }
    | { readonly kind: 'existing'; readonly invocation: Extract<ToolInvocationSnapshot, { state: 'settled' }> }
  > {
    for (let conflicts = 0; ; conflicts++) {
      const snapshot = this.handle.snapshot()
      const view = projectToolSession(snapshot)
      if (view.invocations.some(item => item.invocationId === payload.invocationId)) throw new ToolError('TOOL_ID_CONFLICT', 'identity source reused a tool invocation')
      const key = sourceKey(payload.source)
      const previous = key === null ? undefined : view.invocations.find(item => sourceKey(item.requested.payload.source) === key)
      if (previous?.state === 'settled') return { kind: 'existing', invocation: previous }
      if (view.pendingInvocationId !== null || previous !== undefined) throw new ToolError('TOOL_SESSION_BUSY', 'Session has pending tool work')
      this.preview(snapshot, toolRequestedEvent, payload)
      try { return { kind: 'created', event: await this.handle.appendIfPosition(snapshot.localPosition, toolRequestedEvent, payload) } }
      catch (reason) { if (this.conflict(reason, conflicts, payload.invocationId, toolRequestedEvent.type)) continue; throw reason }
    }
  }

  async transition<T extends JsonValue>(id: ToolInvocationId, definition: DurableEventDefinition<T>, payload: T): Promise<CommittedSessionEvent<T>> {
    for (let conflicts = 0; ; conflicts++) {
      const snapshot = this.handle.snapshot()
      const before = projectToolSession(snapshot).invocations.find(item => item.invocationId === id)
      if (before === undefined) throw new ToolError('TOOL_STATE_INVALID', 'tool transition has no local request')
      const vocabulary: DurableEventDefinition = definition
      const existing = vocabulary === toolAuthorizationEvent ? ('authorization' in before ? before.authorization : undefined)
        : vocabulary === toolStartedEvent ? ('started' in before ? before.started : undefined)
          : vocabulary === toolSettledEvent && before.state === 'settled' ? before.settled : undefined
      if (existing !== undefined) {
        if (!equalJson(existing.payload, payload)) throw new ToolError('TOOL_STATE_INVALID', 'conflicting duplicate tool transition')
        return Object.freeze({ ...existing, payload: definition.decode(existing.payload) })
      }
      this.preview(snapshot, definition, payload)
      try { return await this.handle.appendIfPosition(snapshot.localPosition, definition, payload) }
      catch (reason) { if (this.conflict(reason, conflicts, id, definition.type)) continue; throw reason }
    }
  }

  /** Recovery recomputes evidence after each conflict rather than retrying a stale settlement. */
  async recover(make: (pending: Exclude<ToolInvocationSnapshot, { state: 'settled' }>) => ToolSettlement): Promise<CommittedSessionEvent<ToolSettlement> | null> {
    let target: ToolInvocationId | undefined
    for (let conflicts = 0; ; conflicts++) {
      const snapshot = this.handle.snapshot()
      const view = projectToolSession(snapshot)
      if (target === undefined) target = view.pendingInvocationId ?? undefined
      const pending = view.invocations.find(item => item.invocationId === target)
      if (pending === undefined) return null
      if (pending.state === 'settled') return pending.settled
      const payload = make(pending)
      this.preview(snapshot, toolSettledEvent, payload)
      try { return await this.handle.appendIfPosition(snapshot.localPosition, toolSettledEvent, payload) }
      catch (reason) { if (this.conflict(reason, conflicts, pending.invocationId, toolSettledEvent.type)) continue; throw reason }
    }
  }

  private preview<T extends JsonValue>(snapshot: SessionSnapshot, definition: DurableEventDefinition<T>, payload: T): void {
    assertRecordCapacity(this.handle, definition.type, payload)
    const sequence = sessionSequence(snapshot.localPosition + 1)
    const event: CommittedSessionEvent<T> = Object.freeze({ kind: 'known', payload: definition.decode(payload), stored: Object.freeze({
      envelopeVersion: 1, sessionId: snapshot.header.sessionId,
      eventId: formatSessionEventId(snapshot.header.sessionId, sequence), sequence,
      recordedAt: '2000-01-01T00:00:00.000Z', type: definition.type, payloadVersion: definition.payloadVersion, payload,
    }) })
    const local = snapshot.history.at(-1)!
    // A private candidate, never a published fact. Actual time and commit belong to Handle.
    projectToolSession({ ...snapshot, localPosition: sessionLogPosition(sequence), history: [
      ...snapshot.history.slice(0, -1), { ...local, through: sessionLogPosition(sequence), events: [...local.events, event] },
    ] })
  }

  private conflict(reason: unknown, count: number, invocationId: ToolInvocationId, type: string): boolean {
    if (reason instanceof HarnessError && reason.code === 'SESSION_PRECONDITION_FAILED') {
      if (count < this.maxConflicts) return true
      throw new ToolError('TOOL_SESSION_CHANGED', 'tool journal conflict budget exhausted', { invocationId, type })
    }
    if (reason instanceof HarnessError && reason.code === 'SESSION_APPEND_OUTCOME_UNKNOWN') {
      throw new ToolError('TOOL_JOURNAL_COMMIT_UNKNOWN', 'tool commit confirmation is unknown; release and reopen the Session', { invocationId, type })
    }
    throw new ToolError('TOOL_JOURNAL_WRITE_FAILED', 'tool journal did not confirm the transition', { invocationId, type })
  }
}
