import { EffectOwner } from '../effect/owner.js'
import { EffectDisposalFailedError } from '../effect/errors.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { ModelExchange, PreparedModelCall } from './contract.js'
import { InvocationControl } from './control.js'
import { ModelError, providerFailureCode } from './errors.js'
import type { ModelErrorCode } from './errors.js'
import { ModelJournal } from './journal.js'
import { ModelResponseAccumulator } from './response.js'
import type { ModelPreparedPayload } from './session-events.js'
import type { ModelFailure, ModelInvocationPhase, ModelSettlement } from './settlement.js'

const journalFailures = new Set<ModelErrorCode>([
  'MODEL_JOURNAL_COMMIT_UNKNOWN', 'MODEL_JOURNAL_WRITE_FAILED', 'MODEL_SESSION_CHANGED', 'MODEL_STATE_INVALID',
])
const assemblyFailures = new Set<ModelErrorCode>([
  'MODEL_PROVIDER_INACTIVE', 'MODEL_PROVIDER_BUSY', 'MODEL_BINDING_MISMATCH', 'MODEL_FEATURE_UNSUPPORTED', 'MODEL_REQUEST_INVALID',
])

/** Single-invocation algorithm. Owns resources, never a Session's total lifetime. */
export async function executeModelInvocation(
  journal: ModelJournal,
  payload: ModelPreparedPayload,
  binding: PreparedModelCall,
  control: InvocationControl,
  signals: readonly AbortSignal[],
): Promise<CommittedSessionEvent<ModelSettlement>> {
  const resources = new EffectOwner('model invocation')
  const response = new ModelResponseAccumulator(payload.submission.request, payload.submission.binding, payload.limits)
  let prepared: CommittedSessionEvent<ModelPreparedPayload> | undefined
  let exchange: ModelExchange | undefined
  let issued = false
  let fatal: ModelError | undefined
  let boundaryFailure: ModelError | undefined
  let failure: ModelFailure | undefined
  let protocolFailureAfterTerminal = false
  let cleanupFailures = 0

  try {
    await resources.run('model cancellation', effect => effect.apply(
      'model abort subscriptions', () => control.subscribe(signals), unsubscribe => unsubscribe(),
    ))
    if (control.isCancelled()) throw new ModelError('MODEL_CALL_CANCELLED', 'model call cancelled before persistent acceptance')
    control.current = 'recording'
    prepared = await journal.prepare(payload)
    if (!control.isCancelled()) {
      control.current = 'acquiring'
      const lease = await resources.run('model exchange', effect => effect.apply(
        'model exchange', () => binding.acquire(preparedPayload(prepared).submission, control.signal), active => active.close(),
      ))
      exchange = lease.value
    }
    if (!control.isCancelled() && exchange !== undefined) {
      control.current = 'recording'
      await journal.start(prepared)
      if (!control.isCancelled()) {
        journal.assertStarted(payload.invocationId)
        control.current = 'starting'
        issued = true
        const stream = await exchange.start()
        control.current = 'streaming'
        const iterator = stream[Symbol.asyncIterator]()
        for (;;) {
          if (control.isCancelled()) break
          const frame = await iterator.next()
          if (frame.done) break
          if (control.isCancelled()) break
          response.accept(frame.value)
          if (response.protocolComplete) control.claim(response.stopReason === 'length' ? 'incomplete' : 'completed')
        }
        if (!control.isCancelled()) response.requireComplete()
      }
    }
  } catch (reason) {
    const code = providerFailureCode(reason)
    if (reason instanceof ModelError && (journalFailures.has(code) || prepared === undefined)) {
      fatal = reason
    } else if (reason instanceof ModelError && code === 'MODEL_CALL_CANCELLED' && control.isCancelled()) {
      // Expected cancellation of an in-flight read is not malformed trailing data.
      // A previously claimed completion survives; a genuine protocol error does not.
      control.claim('cancelled')
    } else {
      failure = normalizeFailure(reason, control.current)
      if (reason instanceof ModelError && assemblyFailures.has(code)) boundaryFailure = reason
      if (response.protocolComplete) protocolFailureAfterTerminal = true
      control.claim(code === 'MODEL_LIMIT_EXCEEDED' ? 'incomplete' : 'failed')
    }
    control.stopReading()
  } finally {
    control.current = 'closing'
    try { await resources.dispose() }
    catch (reason) {
      cleanupFailures = reason instanceof EffectDisposalFailedError ? Math.max(1, reason.cleanupFailures.length) : 1
    }
  }

  if (fatal !== undefined) {
    if (cleanupFailures > 0) {
      throw new ModelError(fatal.code, fatal.message, { ...fatal.details, invocationId: payload.invocationId, cleanupFailed: true })
    }
    throw fatal
  }
  if (prepared === undefined) throw new ModelError('MODEL_STATE_INVALID', 'model driver has no confirmed prepared fact')
  if (cleanupFailures > 0 && failure === undefined) {
    failure = { code: 'MODEL_CLEANUP_FAILED', phase: 'closing', retryable: false }
  }
  const outcome = cleanupFailures > 0 || protocolFailureAfterTerminal ? 'failed' : control.decision ?? control.claim('failed')
  const settlement: ModelSettlement = {
    invocationId: payload.invocationId,
    outcome,
    external: response.responseObserved ? 'response-observed' : issued ? 'may-have-been-issued' : 'not-issued',
    result: response.snapshot(),
    cleanup: { status: cleanupFailures > 0 ? 'incomplete' : 'complete', failedResources: cleanupFailures },
    ...(failure === undefined ? {} : { failure }),
  }
  control.current = 'committing'
  const committed = await journal.settle(settlement)
  control.current = 'settled'
  if (cleanupFailures > 0) {
    throw new ModelError('MODEL_CLEANUP_FAILED', 'model result committed but resource cleanup is incomplete', {
      invocationId: payload.invocationId, eventId: committed.stored.eventId, failedResources: cleanupFailures,
    })
  }
  if (boundaryFailure !== undefined) {
    throw new ModelError(boundaryFailure.code, 'model boundary rejected the call; its settlement is committed', {
      invocationId: payload.invocationId, eventId: committed.stored.eventId,
    })
  }
  return committed
}

function preparedPayload(prepared: CommittedSessionEvent<ModelPreparedPayload> | undefined): ModelPreparedPayload {
  if (prepared === undefined) throw new ModelError('MODEL_STATE_INVALID', 'exchange acquisition lacks committed input')
  return prepared.payload
}

function normalizeFailure(reason: unknown, phase: ModelInvocationPhase): ModelFailure {
  const code = providerFailureCode(reason)
  const status = reason instanceof ModelError ? reason.details?.httpStatus : undefined
  const httpStatus = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined
  const retryable = httpStatus === 429 || httpStatus !== undefined && httpStatus >= 500
  return { code, phase, retryable, ...(httpStatus === undefined ? {} : { httpStatus }) }
}
