import { assertDelegatedWriteCapacity } from '../subagent/write-capacity.js'
import type { SessionId, SessionLogPosition } from '../session/ids.js'
import { formatSessionEventId, sessionSequence } from '../session/ids.js'
import type { CommittedSessionEvent, SessionProjectionCoverage, SessionSnapshot } from '../session/types.js'
import { boundedJson } from '../schema/bounded-json.js'
import type { ToolAuthorizationPayload, ToolRequestedPayload, ToolSettlement, ToolStartedPayload } from './contract.js'
import { compileDefinition, validateToolSuccessValue } from './schema-validator.js'
import { ToolError } from './errors.js'
import type { ToolInvocationId } from './ids.js'
import { assertPlanBinding, schemaLimits } from './plan.js'
import { toolAuthorizationEvent, toolRequestedEvent, toolSettledEvent, toolStartedEvent } from './session-events.js'
import { requestedArguments, selectionRejection, sourceKey, validateRequestSource } from './source.js'
import { effectiveLimits, equalJson, jsonBytes, resultBudget } from './validation.js'

interface InvocationBase { readonly invocationId: ToolInvocationId; readonly requested: CommittedSessionEvent<ToolRequestedPayload> }
/** Durable data only. No provider, cancellation right, lease, or reusable authorization. */
export type ToolInvocationSnapshot = InvocationBase & (
  | { readonly state: 'requested' }
  | { readonly state: 'decided'; readonly authorization: CommittedSessionEvent<ToolAuthorizationPayload> }
  | { readonly state: 'started'; readonly authorization: CommittedSessionEvent<ToolAuthorizationPayload>; readonly started: CommittedSessionEvent<ToolStartedPayload> }
  | { readonly state: 'settled'; readonly authorization?: CommittedSessionEvent<ToolAuthorizationPayload>; readonly started?: CommittedSessionEvent<ToolStartedPayload>; readonly settled: CommittedSessionEvent<ToolSettlement> }
)

export interface ToolSessionSnapshot {
  readonly sessionId: SessionId
  readonly localPosition: SessionLogPosition
  readonly invocations: readonly ToolInvocationSnapshot[]
  readonly pendingInvocationId: ToolInvocationId | null
  readonly coverage: readonly SessionProjectionCoverage[]
}

/** Deterministic local replay. An inherited Tool/Model fact cannot become child work. */
export function projectToolSession(snapshot: SessionSnapshot): ToolSessionSnapshot {
  const local = snapshot.history.at(-1)
  if (local === undefined || local.header.sessionId !== snapshot.header.sessionId || local.through !== snapshot.localPosition
    || local.events.length !== local.through) invalid()
  const records = new Map<ToolInvocationId, ToolInvocationSnapshot>()
  const sources = new Set<string>()
  let pending: ToolInvocationId | null = null
  let sequence = 0
  for (const event of local.events) {
    sequence++
    if (event.stored.sessionId !== snapshot.header.sessionId || event.stored.sequence !== sequence
      || event.stored.eventId !== formatSessionEventId(snapshot.header.sessionId, sessionSequence(sequence))) invalid()
    const type = event.stored.type
    if (![toolRequestedEvent.type, toolAuthorizationEvent.type, toolStartedEvent.type, toolSettledEvent.type].includes(type)) continue
    if (event.kind !== 'known' || event.stored.payloadVersion !== 1 || event.stored.ignorable === true) invalid()
    if (!equalJson(event.payload, event.stored.payload)) invalid()
    try {
      if (type === toolRequestedEvent.type) {
        const payload = toolRequestedEvent.decode(event.payload)
        if (pending !== null || records.has(payload.invocationId)) invalid()
        assertDelegatedWriteCapacity(snapshot, payload, sequence)
        validateRequestSource(payload, snapshot, sequence)
        const key = sourceKey(payload.source)
        if (key !== null) { if (sources.has(key)) invalid(); sources.add(key) }
        records.set(payload.invocationId, Object.freeze({ invocationId: payload.invocationId, state: 'requested', requested: Object.freeze({ ...event, payload }) }))
        pending = payload.invocationId
        continue
      }
      if (type === toolAuthorizationEvent.type) {
        const payload = toolAuthorizationEvent.decode(event.payload)
        const before = records.get(payload.invocationId)
        if (before?.state !== 'requested' || pending !== payload.invocationId) invalid()
        const request = before.requested.payload
        if (payload.requestedEventId !== before.requested.stored.eventId || request.selection.kind !== 'resolved') invalid()
        const original = validateRequestSource(request, snapshot, before.requested.stored.sequence)
        if (selectionRejection(request, original) !== null) invalid()
        const input = requestedArguments(request)
        const limits = effectiveLimits(request.limits, request.selection.provider)
        assertPlanBinding(payload.plan, request.selection.definition, request.selection.provider, input, limits)
        if (!compileDefinition(request.selection.definition, schemaLimits(limits)).input(input)) invalid()
        records.set(payload.invocationId, Object.freeze({ ...before, state: 'decided', authorization: Object.freeze({ ...event, payload }) }))
        continue
      }
      if (type === toolStartedEvent.type) {
        const payload = toolStartedEvent.decode(event.payload)
        const before = records.get(payload.invocationId)
        if (before?.state !== 'decided' || pending !== payload.invocationId || before.authorization.payload.decision.kind !== 'allow'
          || payload.authorizationEventId !== before.authorization.stored.eventId) invalid()
        records.set(payload.invocationId, Object.freeze({ ...before, state: 'started', started: Object.freeze({ ...event, payload }) }))
        continue
      }
      const payload = toolSettledEvent.decode(event.payload)
      const before = records.get(payload.invocationId)
      if (before === undefined || before.state === 'settled' || pending !== payload.invocationId) invalid()
      validateSettlement(before, payload)
      records.set(payload.invocationId, Object.freeze({ ...before, state: 'settled', settled: Object.freeze({ ...event, payload }) }))
      pending = null
    } catch {
      throw new ToolError('TOOL_STATE_INVALID', 'tool fact violates its payload, predecessor, source, or budget contract', { eventId: event.stored.eventId })
    }
  }
  if (snapshot.lifecycle === 'ended' && pending !== null) throw new ToolError('TOOL_STATE_INVALID', 'ended Session contains stranded tool work', { invocationId: pending })
  return Object.freeze({ sessionId: snapshot.header.sessionId, localPosition: snapshot.localPosition,
    invocations: Object.freeze([...records.values()]), pendingInvocationId: pending,
    coverage: Object.freeze([Object.freeze({ sessionId: snapshot.header.sessionId, through: snapshot.localPosition })]),
  })
}

function validateSettlement(before: Exclude<ToolInvocationSnapshot, { state: 'settled' }>, settled: ToolSettlement): void {
  const requested = before.requested.payload
  const limits = before.state === 'requested' ? requested.limits : before.authorization.payload.plan.limits
  boundedJson(settled.result, { ...resultBudget(limits), maxDepth: Math.min(128, limits.maxJsonDepth + 2), maxNodes: limits.maxJsonNodes + 8 })
  if (jsonBytes(settled.result) > limits.maxResultBytes) invalid()
  if (before.state !== 'started' && settled.execution !== 'not-started') invalid()
  if (settled.outcome === 'rejected' && (before.state === 'started'
    || before.state === 'decided' && before.authorization.payload.decision.kind === 'allow')) invalid()
  if (settled.cleanup.status !== 'unknown-after-process-loss') {
    if (settled.cleanup.attempted === null || settled.cleanup.attempted > 1) invalid()
    if (before.state === 'requested' && settled.cleanup.attempted !== 0) invalid()
  }
  if (before.state !== 'requested' && before.authorization.payload.decision.kind === 'deny') {
    if (settled.outcome !== 'rejected' || settled.execution !== 'not-started' || settled.result.kind !== 'error'
      || settled.result.code !== 'policy-denied' || settled.cleanup.status !== 'complete' || settled.cleanup.attempted !== 0) invalid()
  }
  if (settled.execution !== 'not-started' && (before.state !== 'started' || before.authorization.payload.decision.kind !== 'allow')) invalid()
  const operation = requested.selection.kind === 'resolved' ? requested.selection.definition.operationClass : null
  if (operation !== 'external' && settled.emission !== 'none') invalid()
  if (operation === 'external' && settled.execution !== 'not-started' && settled.emission === 'none') invalid()
  if (settled.cleanup.status !== 'unknown-after-process-loss' && before.state === 'started' && settled.cleanup.attempted === 0) invalid()
  if (settled.outcome === 'succeeded') {
    if (before.state !== 'started' || requested.selection.kind !== 'resolved' || settled.result.kind !== 'success') invalid()
    const definition = requested.selection.definition
    validateToolSuccessValue(settled.result.value, limits,
      value => compileDefinition(definition, schemaLimits(limits)).output(value))
  }
}
function invalid(): never { throw new ToolError('TOOL_STATE_INVALID', 'tool history is invalid') }
