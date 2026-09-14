import type { CommittedSessionEvent, SessionProjectionCoverage, SessionSnapshot } from '../session/types.js'
import type { SessionId, SessionLogPosition } from '../session/ids.js'
import { jsonBytes } from './budget.js'
import { ModelError } from './errors.js'
import type { ModelInvocationId } from './ids.js'
import { modelPreparedEvent, modelSettledEvent, modelStartedEvent } from './session-events.js'
import type { ModelPreparedPayload, ModelStartedPayload } from './session-events.js'
import type { ModelSettlement } from './settlement.js'

interface InvocationBase {
  readonly invocationId: ModelInvocationId
  readonly prepared: CommittedSessionEvent<ModelPreparedPayload>
}

/** Durable state only; no live stream, cancellation token, or resource ownership. */
export type ModelInvocationSnapshot = InvocationBase & (
  | { readonly state: 'prepared' }
  | { readonly state: 'started'; readonly started: CommittedSessionEvent<ModelStartedPayload> }
  | { readonly state: 'settled'; readonly started?: CommittedSessionEvent<ModelStartedPayload>; readonly settled: CommittedSessionEvent<ModelSettlement> }
)

export interface ModelSessionSnapshot {
  readonly sessionId: SessionId
  readonly localPosition: SessionLogPosition
  readonly invocations: readonly ModelInvocationSnapshot[]
  readonly pendingInvocationId: ModelInvocationId | null
  /** Only the local segment is consumed; ancestry remains available from SessionSnapshot. */
  readonly coverage: readonly SessionProjectionCoverage[]
}

/** Replay the target's local model state, never adopting an ancestor's pending work. */
export function projectModelSession(snapshot: SessionSnapshot): ModelSessionSnapshot {
  const local = snapshot.history.at(-1)
  if (local === undefined || local.header.sessionId !== snapshot.header.sessionId || local.through !== snapshot.localPosition) {
    throw new ModelError('MODEL_STATE_INVALID', 'model projection requires a complete local Session segment')
  }
  const records = new Map<ModelInvocationId, ModelInvocationSnapshot>()
  let pending: ModelInvocationId | null = null
  for (const event of local.events) {
    const type = event.stored.type
    if (![modelPreparedEvent.type, modelStartedEvent.type, modelSettledEvent.type].includes(type)) continue
    if (event.kind !== 'known' || event.stored.payloadVersion !== 1 || event.stored.ignorable === true) {
      throw new ModelError('MODEL_STATE_INVALID', 'model events must be known required version-one facts')
    }
    try {
      if (type === modelPreparedEvent.type) {
        const payload = modelPreparedEvent.decode(event.payload)
        if (pending !== null || records.has(payload.invocationId)) invalid('duplicate identity or concurrent pending invocation')
        if (payload.retryOf !== undefined && records.get(payload.retryOf)?.state !== 'settled') invalid('retry does not reference local settled work')
        if (jsonBytes(payload) > payload.limits.maxInputBytes) invalid('prepared input exceeds its recorded limit')
        records.set(payload.invocationId, Object.freeze({ invocationId: payload.invocationId, state: 'prepared', prepared: Object.freeze({ ...event, payload }) }))
        pending = payload.invocationId
      } else if (type === modelStartedEvent.type) {
        const payload = modelStartedEvent.decode(event.payload)
        const before = records.get(payload.invocationId)
        if (before === undefined || before.state !== 'prepared' || pending !== payload.invocationId) invalid('started event has no unique prepared predecessor')
        if (before.prepared.stored.eventId !== payload.preparedEventId || before.prepared.payload.submission.fingerprint !== payload.fingerprint) invalid('dispatch intent references different prepared content')
        records.set(payload.invocationId, Object.freeze({ ...before, state: 'started', started: Object.freeze({ ...event, payload }) }))
      } else {
        const payload = modelSettledEvent.decode(event.payload)
        const before = records.get(payload.invocationId)
        if (before === undefined || before.state === 'settled' || pending !== payload.invocationId) invalid('settlement has no unique pending predecessor')
        if (before.state === 'prepared' && payload.external !== 'not-issued') invalid('external invocation lacks committed dispatch intent')
        const { limits, submission } = before.prepared.payload
        if (jsonBytes(payload.result) > limits.maxNormalizedResultBytes || payload.result.blocks.length > limits.maxOutputBlocks) invalid('durable result exceeds its recorded budget')
        const tools = payload.result.blocks.filter(block => block.kind === 'tool-call')
        if (tools.length > limits.maxToolCalls) invalid('durable tool count exceeds its recorded budget')
        for (const block of payload.result.blocks) {
          if (block.kind === 'tool-call') {
            const advertised = submission.request.tools.some(tool => tool.name === block.name)
            if (block.advertisement !== (advertised ? 'advertised' : 'not-advertised')) invalid('tool advertisement differs from prepared definitions')
          } else if (block.kind === 'continuation') {
            const capsule = block.capsule
            if (capsule.providerId !== submission.binding.providerId || capsule.model !== submission.request.model
              || !submission.binding.support.continuations.includes(`${capsule.namespace}@${capsule.version}`)) invalid('result continuation differs from its captured binding')
          }
        }
        records.set(payload.invocationId, Object.freeze({ ...before, state: 'settled', settled: Object.freeze({ ...event, payload }) }))
        pending = null
      }
    } catch (reason) {
      if (reason instanceof ModelError && reason.code === 'MODEL_STATE_INVALID') throw reason
      throw new ModelError('MODEL_STATE_INVALID', 'model durable payload is invalid', { eventId: event.stored.eventId })
    }
  }
  if (snapshot.lifecycle === 'ended' && pending !== null) {
    throw new ModelError('MODEL_STATE_INVALID', 'ended Session contains stranded model work', { sessionId: snapshot.header.sessionId, invocationId: pending })
  }
  return Object.freeze({
    sessionId: snapshot.header.sessionId, localPosition: snapshot.localPosition,
    invocations: Object.freeze([...records.values()]), pendingInvocationId: pending,
    coverage: Object.freeze([Object.freeze({ sessionId: snapshot.header.sessionId, through: snapshot.localPosition })]),
  })
}

function invalid(message: string): never { throw new ModelError('MODEL_STATE_INVALID', message) }
