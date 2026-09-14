import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonValue } from '../foundation/json.js'
import type { DurableEventDefinition } from '../session/event-catalog.js'
import { SessionError } from '../session/errors.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { emptyModelResult, jsonBytes, modelEnvelopeBytes } from './budget.js'
import { ModelError } from './errors.js'
import type { ModelInvocationId } from './ids.js'
import { projectModelSession } from './projection.js'
import type { ModelSessionSnapshot } from './projection.js'
import { modelPreparedEvent, modelSessionEventDefinitions, modelSettledEvent, modelStartedEvent } from './session-events.js'
import type { ModelPreparedPayload, ModelStartedPayload } from './session-events.js'
import type { ModelSettlement } from './settlement.js'

export function assertModelCatalog(handle: SessionHandle): void {
  if (modelSessionEventDefinitions.some(definition => !handle.supportsEventDefinition(definition))) {
    throw new ModelError('MODEL_SESSION_CATALOG_INCOMPATIBLE', 'Session Catalog must contain all three exact model definitions')
  }
}

/** Owns only conditional durable transitions. It never starts or retries provider I/O. */
export class ModelJournal {
  readonly #handle: SessionHandle
  readonly #conflicts: number

  constructor(handle: SessionHandle, maxJournalConflicts: number) {
    assertModelCatalog(handle)
    this.#handle = handle
    this.#conflicts = maxJournalConflicts
  }

  prepare(payload: ModelPreparedPayload): Promise<CommittedSessionEvent<ModelPreparedPayload>> {
    if (jsonBytes(payload) > payload.limits.maxInputBytes
      || modelEnvelopeBytes(modelPreparedEvent.type, payload) > this.#handle.maxRecordBytes) {
      throw new ModelError('MODEL_REQUEST_INVALID', 'complete prepared submission cannot fit its durable input budget')
    }
    return this.#append(modelPreparedEvent, payload, state => {
      if (state.pendingInvocationId !== null) throw new ModelError('MODEL_SESSION_BUSY', 'Session already owns an unsettled model invocation')
      if (state.invocations.some(item => item.invocationId === payload.invocationId)) throw new ModelError('MODEL_STATE_INVALID', 'model invocation identity was already used')
      if (payload.retryOf !== undefined && !state.invocations.some(item => item.invocationId === payload.retryOf && item.state === 'settled')) {
        throw new ModelError('MODEL_STATE_INVALID', 'retry reference is not a local settled model invocation')
      }
      return undefined
    })
  }

  start(prepared: CommittedSessionEvent<ModelPreparedPayload>): Promise<CommittedSessionEvent<ModelStartedPayload>> {
    const payload: ModelStartedPayload = {
      invocationId: prepared.payload.invocationId,
      preparedEventId: prepared.stored.eventId,
      fingerprint: prepared.payload.submission.fingerprint,
    }
    return this.#append(modelStartedEvent, payload, state => {
      const entry = state.invocations.find(item => item.invocationId === payload.invocationId)
      if (entry === undefined || entry.prepared.stored.eventId !== payload.preparedEventId || entry.state === 'settled') {
        throw new ModelError('MODEL_STATE_INVALID', 'invocation is no longer eligible to start')
      }
      if (entry.state === 'started') {
        if (!same(entry.started.payload, payload)) throw new ModelError('MODEL_STATE_INVALID', 'conflicting model start fact')
        return entry.started
      }
      return undefined
    })
  }

  settle(payload: ModelSettlement): Promise<CommittedSessionEvent<ModelSettlement>> {
    return this.#append(modelSettledEvent, payload, state => {
      const entry = state.invocations.find(item => item.invocationId === payload.invocationId)
      if (entry === undefined) throw new ModelError('MODEL_STATE_INVALID', 'model settlement has no prepared invocation')
      if (entry.state === 'settled') {
        if (!same(entry.settled.payload, payload)) throw new ModelError('MODEL_STATE_INVALID', 'conflicting model settlement')
        return entry.settled
      }
      if (entry.state === 'prepared' && payload.external !== 'not-issued') throw new ModelError('MODEL_STATE_INVALID', 'unstarted invocation cannot claim an external effect')
      return undefined
    })
  }

  /** Re-derive external uncertainty on every CAS retry, including recovery races. */
  interrupt(invocationId: ModelInvocationId): Promise<CommittedSessionEvent<ModelSettlement>> {
    return this.#append<ModelSettlement>(modelSettledEvent, state => {
      const entry = state.invocations.find(item => item.invocationId === invocationId)
      if (entry === undefined) throw new ModelError('MODEL_STATE_INVALID', 'recovery can address only local prepared work')
      if (entry.state === 'settled') return entry.settled.payload
      return {
        invocationId, outcome: 'interrupted',
        external: entry.state === 'started' ? 'may-have-been-issued' : 'not-issued',
        result: emptyModelResult(),
        cleanup: { status: 'unknown-after-process-loss', failedResources: null },
      }
    }, state => {
      const entry = state.invocations.find(item => item.invocationId === invocationId)
      return entry?.state === 'settled' ? entry.settled : undefined
    })
  }

  /** No asynchronous gap between this check and the driver's call to exchange.start. */
  assertStarted(invocationId: ModelInvocationId): void {
    const current = projectModelSession(this.#handle.snapshot()).invocations.find(item => item.invocationId === invocationId)
    if (current?.state !== 'started') throw new ModelError('MODEL_STATE_INVALID', 'model invocation is no longer pending at emission')
  }

  async #append<T extends JsonValue>(
    definition: DurableEventDefinition<T>, payload: T | ((state: ModelSessionSnapshot) => T),
    decide: (state: ModelSessionSnapshot) => CommittedSessionEvent<T> | undefined,
  ): Promise<CommittedSessionEvent<T>> {
    for (let conflicts = 0; ; conflicts += 1) {
      const state = projectModelSession(this.#handle.snapshot())
      const currentPayload = typeof payload === 'function' ? payload(state) : payload
      const existing = decide(state)
      if (existing !== undefined) return existing
      try {
        return await this.#handle.appendIfPosition(state.localPosition, definition, currentPayload)
      } catch (reason) {
        if (reason instanceof SessionError && reason.code === 'SESSION_PRECONDITION_FAILED') {
          if (conflicts < this.#conflicts) continue
          throw new ModelError('MODEL_SESSION_CHANGED', 'model journal exhausted its local conflict budget', { eventType: definition.type, maxJournalConflicts: this.#conflicts })
        }
        const unknown = !(reason instanceof SessionError) || reason.code === 'SESSION_APPEND_OUTCOME_UNKNOWN'
        throw new ModelError(unknown ? 'MODEL_JOURNAL_COMMIT_UNKNOWN' : 'MODEL_JOURNAL_WRITE_FAILED', unknown ? 'model journal commit is unknown; release and reopen the Session' : 'model journal write did not commit', {
          eventType: definition.type,
          ...(reason instanceof SessionError ? { sessionCode: reason.code } : {}),
        })
      }
    }
  }
}

function same(left: JsonValue, right: JsonValue): boolean {
  return Buffer.from(canonicalJsonBytes(left)).equals(Buffer.from(canonicalJsonBytes(right)))
}
