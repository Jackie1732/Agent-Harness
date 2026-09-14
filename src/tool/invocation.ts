import { EffectOwner } from '../effect/owner.js'
import type { JsonValue } from '../foundation/json.js'
import { snapshotJson } from '../foundation/json.js'
import { boundedJson, JsonBoundaryError } from '../schema/bounded-json.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { assertMinimalSettlementCapacity, assertRecordCapacity, assertSettlementCapacity } from './budget.js'
import type {
  ToolAuthorizationPayload, ToolExecution, ToolExecutionResult, ToolInvocationLimits,
  ToolPhase, ToolPolicy, ToolPolicyIdentity, ToolRequestedPayload, ToolSettlement,
} from './contract.js'
import { ToolError } from './errors.js'
import { ToolJournal } from './journal.js'
import { assertPlanBinding, decodePlan } from './plan.js'
import type { ToolBorrow } from './registry.js'
import { decodeDecision, toolAuthorizationEvent, toolRequestedEvent, toolSettledEvent, toolStartedEvent } from './session-events.js'
import { requestedArguments, selectionRejection, validateRequestSource } from './source.js'
import { argumentBudget, choice, effectiveLimits, exact, jsonBytes, object, safeCode, text } from './validation.js'

export interface ToolInvocationContext {
  readonly session: SessionHandle
  readonly request: ToolRequestedPayload
  readonly borrow: ToolBorrow | undefined
  readonly policy: Pick<ToolPolicy, 'decide'>
  readonly policyIdentity: ToolPolicyIdentity
  readonly signal: AbortSignal
  /** Stops residual provider work even after a result has already been claimed. */
  readonly stop: () => void
  readonly phase: (phase: ToolPhase) => void
}

function isJournalFailure(reason: unknown): reason is ToolError {
  return reason instanceof ToolError && [
    'TOOL_JOURNAL_COMMIT_UNKNOWN', 'TOOL_JOURNAL_WRITE_FAILED', 'TOOL_SESSION_CHANGED', 'TOOL_STATE_INVALID',
  ].includes(reason.code)
}

/** Validate a returned value before consulting cancellation; no late data bypasses the boundary. */
function executionResult(value: unknown, limits: ToolInvocationLimits, borrow: ToolBorrow): ToolExecutionResult {
  let copy: ReturnType<typeof object>
  try {
    copy = object(boundedJson(value, {
      maxBytes: limits.maxResultBytes + 256,
      maxDepth: Math.min(128, limits.maxJsonDepth + 1), maxNodes: limits.maxJsonNodes + 4,
    }))
  } catch (reason) {
    throw new ToolError(reason instanceof JsonBoundaryError && reason.reason !== 'invalid'
      ? 'TOOL_RESULT_LIMIT' : 'TOOL_RESULT_INVALID', 'tool returned an invalid or oversized result')
  }
  try {
    const kind = choice(copy.kind, ['success', 'error'])
    exact(copy, kind === 'success' ? ['kind', 'value'] : ['kind', 'code'], ['receipt'])
    if (copy.receipt !== undefined) {
      const receipt = text(copy.receipt, 128)
      if (!/^[A-Za-z0-9._/-]+$/.test(receipt) || borrow.definition.operationClass !== 'external') {
        throw new ToolError('TOOL_RESULT_INVALID', 'receipt is incompatible with the operation class')
      }
    }
    if (kind === 'error') safeCode(copy.code)
    const canonical = kind === 'success' ? { kind, value: copy.value! } : { kind, code: copy.code! }
    if (jsonBytes(canonical) > limits.maxResultBytes) throw new ToolError('TOOL_RESULT_LIMIT', 'canonical tool result exceeds its ceiling')
    if (kind === 'success') {
      const data = boundedJson(copy.value, { maxBytes: limits.maxResultBytes, maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes })
      if (!borrow.compiled.output(data)) throw new ToolError('TOOL_RESULT_INVALID', 'tool success does not satisfy its output schema')
    }
    return copy as ToolExecutionResult
  } catch (reason) {
    if (reason instanceof ToolError && ['TOOL_RESULT_LIMIT', 'TOOL_RESULT_INVALID'].includes(reason.code)) throw reason
    throw new ToolError(reason instanceof JsonBoundaryError && reason.reason !== 'invalid'
      ? 'TOOL_RESULT_LIMIT' : 'TOOL_RESULT_INVALID', 'tool result does not satisfy its closed contract')
  }
}

/** One request, one decision, one execution. The journal retries only local conditional appends. */
export async function runToolInvocation(context: ToolInvocationContext): Promise<CommittedSessionEvent<ToolSettlement>> {
  const { session, request, borrow, signal } = context
  const journal = new ToolJournal(session, request.limits.maxJournalConflicts)
  const owner = new EffectOwner()
  const progress: { current: ToolPhase } = { current: 'selection' }
  const phase = (next: ToolPhase): void => { progress.current = next; context.phase(next) }
  let accepted = false
  let execution: ToolExecution | undefined
  let closeExecution: (() => Promise<void>) | undefined
  let startExecution: (() => ReturnType<ToolExecution['start']>) | undefined
  let cleanupAttempts = 0
  let cleanupFailures = 0
  let unattributedCleanupFailure = false
  let cancellationClaimed = signal.aborted
  let resultClaimed = false
  let infrastructure: ToolError | undefined
  let journalFailure: unknown
  let settlement: ToolSettlement = {
    invocationId: request.invocationId, outcome: 'cancelled', execution: 'not-started', emission: 'none',
    result: { kind: 'none' }, cleanup: { status: 'complete', attempted: 0, failed: 0 },
  }
  const cancel = (): void => { if (!resultClaimed) cancellationClaimed = true }
  signal.addEventListener('abort', cancel, { once: true })
  const cancelled = (): boolean => cancellationClaimed || signal.aborted
  const reject = (code: string): void => {
    settlement = { ...settlement, outcome: 'rejected', result: { kind: 'error', code } }
    resultClaimed = true
  }
  const fail = (reason: unknown, fallback: ToolError['code']): void => {
    const failure = reason instanceof ToolError ? reason : new ToolError(fallback, 'tool infrastructure did not satisfy its contract')
    settlement = { ...settlement, outcome: cancelled() && !resultClaimed ? 'cancelled' : 'failed',
      result: { kind: 'error', code: failure.code }, failure: { code: failure.code, phase: progress.current } }
    if (['TOOL_POLICY_INVALID', 'TOOL_BINDING_MISMATCH', 'TOOL_PROVIDER_INVALID', 'TOOL_PROVIDER_INACTIVE', 'TOOL_PROVIDER_BUSY'].includes(failure.code)) {
      infrastructure = failure
    }
    resultClaimed = true
  }

  try {
    if (cancelled()) throw new ToolError('TOOL_CANCELLED', 'tool request was cancelled before durable acceptance')
    assertRecordCapacity(session, toolRequestedEvent.type, request)
    assertMinimalSettlementCapacity(session, request.invocationId)
    const cp0 = await journal.request(request)
    if (cp0.kind === 'existing') return cp0.invocation.settled
    accepted = true
    const committedRequest = cp0.event.payload

    // Each early return below exits this local pipeline, not the cleanup/commit path.
    const perform = async (): Promise<void> => {
      if (cancelled()) return
      phase('validation')
      const rejection = selectionRejection(committedRequest, validateRequestSource(committedRequest, session.snapshot(), cp0.event.stored.sequence))
      if (rejection !== null) { reject(rejection); return }
      if (borrow === undefined || committedRequest.selection.kind !== 'resolved') {
        throw new ToolError('TOOL_BINDING_MISMATCH', 'resolved request has no current registered binding')
      }
      if (!borrow.active()) return
      let input: JsonValue
      try { input = requestedArguments(committedRequest) }
      catch { reject('invalid-arguments'); return }
      if (!borrow.compiled.input(input)) { reject('invalid-arguments'); return }
      if (cancelled()) return

      const limits = effectiveLimits(committedRequest.limits, borrow.descriptor)
      try { input = boundedJson(input, argumentBudget(limits)) }
      catch { reject('invalid-arguments'); return }
      if (cancelled()) return

      phase('preparing')
      assertSettlementCapacity(session, request.invocationId, limits, borrow.definition.operationClass)
      const prepared = borrow.provider.prepare(borrow.definition, input, limits)
      if (prepared === null || typeof prepared !== 'object' || typeof prepared.acquire !== 'function') {
        throw new ToolError('TOOL_PROVIDER_INVALID', 'provider prepare did not return an execution binding')
      }
      let plan
      try { plan = decodePlan(prepared.plan, limits) }
      catch { throw new ToolError('TOOL_BINDING_MISMATCH', 'provider plan does not satisfy the bounded execution contract') }
      assertPlanBinding(plan, borrow.definition, borrow.descriptor, input, limits)
      const acquire = prepared.acquire.bind(prepared)
      if (cancelled() || !borrow.active()) return

      phase('authorizing')
      // Preflight the larger allow/deny alternatives before invoking external policy code.
      const draft: ToolAuthorizationPayload = { invocationId: request.invocationId,
        requestedEventId: cp0.event.stored.eventId, policy: context.policyIdentity,
        decision: { kind: 'allow', reasonCode: 'X'.repeat(64) }, plan }
      assertRecordCapacity(session, toolAuthorizationEvent.type, draft)
      const policyInput = snapshotJson({ sessionId: session.header.sessionId, address: session.header.address,
        invocationId: request.invocationId, source: committedRequest.source, plan })
      let decision
      try {
        const raw = await context.policy.decide(policyInput as Parameters<ToolPolicy['decide']>[0], { signal })
        // Late decisions are not audit facts and cannot resurrect an abandoned permission.
        if (cancelled() || !borrow.active()) return
        decision = decodeDecision(raw)
      } catch {
        if (cancelled() || !borrow.active()) return
        throw new ToolError('TOOL_POLICY_INVALID', 'policy failed or returned a malformed decision')
      }
      const authorization = await journal.transition(request.invocationId, toolAuthorizationEvent, { ...draft, decision })
      if (decision.kind === 'deny') { reject('policy-denied'); return }
      if (cancelled() || !borrow.active()) return

      phase('acquiring')
      await owner.run('tool-invocation', async effect => {
        execution = await effect.apply('tool-execution',
          () => acquire(authorization.payload.plan, signal),
          async value => {
            cleanupAttempts++
            try {
              const close = closeExecution ?? (typeof value?.close === 'function' ? value.close.bind(value) : undefined)
              if (close === undefined) throw new ToolError('TOOL_PROVIDER_INVALID', 'execution supplied no close operation')
              await close()
            } catch { cleanupFailures++; throw new ToolError('TOOL_CLEANUP_FAILED', 'execution close failed') }
          })
        if (execution === null || typeof execution !== 'object' || typeof execution.start !== 'function' || typeof execution.close !== 'function') {
          throw new ToolError('TOOL_PROVIDER_INVALID', 'acquired execution has an invalid runtime contract')
        }
        closeExecution = execution.close.bind(execution)
        startExecution = execution.start.bind(execution)
      })
      if (cancelled() || !borrow.active()) return
      phase('starting')
      await journal.transition(request.invocationId, toolStartedEvent, {
        invocationId: request.invocationId, authorizationEventId: authorization.stored.eventId,
      })
      if (cancelled() || !borrow.active()) return
      if (startExecution === undefined) throw new ToolError('TOOL_PROVIDER_INVALID', 'execution was not acquired')
      phase('executing')
      settlement = { ...settlement, execution: 'may-have-executed',
        emission: borrow.definition.operationClass === 'external' ? 'may-have-occurred' : 'none' }
      const raw = await startExecution()
      settlement = { ...settlement, execution: 'execution-observed' }
      const result = executionResult(raw, limits, borrow)
      // Validation completes before this synchronous result/cancel arbitration point.
      if (result.receipt !== undefined) settlement = { ...settlement, emission: 'observed', receipt: result.receipt }
      if (cancelled()) return
      settlement = { ...settlement, outcome: result.kind === 'success' ? 'succeeded' : 'failed',
        result: result.kind === 'success' ? { kind: 'success', value: result.value } : { kind: 'error', code: result.code } }
      resultClaimed = true
    }
    try { await perform() }
    catch (reason) {
      if (isJournalFailure(reason)) journalFailure = reason
      else if (reason instanceof ToolError && reason.code === 'TOOL_PATH_INVALID' && progress.current === 'preparing') reject('invalid-arguments')
      else if (cancelled() && (progress.current === 'acquiring' || progress.current === 'executing') && !(reason instanceof ToolError)) {
        settlement = { ...settlement, outcome: 'cancelled', result: { kind: 'none' } }
      } else fail(reason, progress.current === 'authorizing' ? 'TOOL_POLICY_INVALID' : 'TOOL_PROVIDER_INVALID')
    }
  } catch (reason) { journalFailure = reason }
  finally {
    phase('closing')
    // Result certainty does not mean all residual work is gone. Always request stop.
    context.stop()
    try { await owner.dispose() }
    catch {
      // Never invent a failed-resource count from an unclassified Owner error.
      if (cleanupFailures === 0) unattributedCleanupFailure = true
    }
    signal.removeEventListener('abort', cancel)
  }

  if (unattributedCleanupFailure) {
    const error = new ToolError(journalFailure instanceof ToolError ? journalFailure.code : 'TOOL_CLEANUP_FAILED',
      'tool ownership did not confirm cleanup; no resource count or settlement is fabricated',
      { invocationId: request.invocationId, cleanupIncomplete: true })
    borrow?.markUnsafe(error)
    throw error
  }
  if (cleanupFailures > 0) {
    const error = new ToolError('TOOL_CLEANUP_FAILED', 'tool invocation has incomplete resource cleanup', { invocationId: request.invocationId })
    borrow?.markUnsafe(error)
    infrastructure = error
  }
  if (journalFailure !== undefined) {
    if (cleanupFailures > 0 && journalFailure instanceof ToolError) {
      throw new ToolError(journalFailure.code, 'tool journal failed and cleanup is incomplete', {
        ...journalFailure.details, invocationId: request.invocationId, cleanupIncomplete: true,
      })
    }
    throw journalFailure
  }
  if (!accepted) throw new ToolError('TOOL_STATE_INVALID', 'tool result has no accepted request')
  settlement = { ...settlement, cleanup: { status: cleanupFailures === 0 ? 'complete' : 'incomplete', attempted: cleanupAttempts, failed: cleanupFailures } }
  phase('committing')
  let committed: CommittedSessionEvent<ToolSettlement>
  try {
    committed = await journal.transition(request.invocationId, toolSettledEvent, settlement)
  } catch (reason) {
    if (cleanupFailures > 0 && reason instanceof ToolError) {
      throw new ToolError(reason.code, 'tool settlement commit failed and cleanup is incomplete', {
        ...reason.details, invocationId: request.invocationId, cleanupIncomplete: true,
      })
    }
    throw reason
  }
  phase('settled')
  if (infrastructure !== undefined) {
    throw new ToolError(infrastructure.code, 'tool infrastructure failed; inspect the committed settlement', {
      invocationId: request.invocationId, settledEventId: committed.stored.eventId,
    })
  }
  return committed
}
