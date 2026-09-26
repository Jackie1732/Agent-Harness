import type { SessionEventId } from '../session/ids.js'
import type { WorkflowSnapshot } from './projection.js'
import type { WorkflowDefinition, WorkflowEventRef, WorkflowAttempt } from './types.js'
import type { WorkflowRetryRequest } from './control-events.js'
import { reserveAgentBudget } from '../agent/budget.js'
import type { AgentBudget } from '../agent/contract.js'
import { createDurableEventDefinition } from '../session/event-catalog.js'
import { eventId, exact, record, timestamp } from '../agent/validation.js'
import { workflowReference, sameWorkflowValue } from './work-binding.js'

export interface WorkflowRetry {
  readonly assignment: WorkflowEventRef
  readonly failure: SessionEventId
  readonly deadline: string
  request: SessionEventId | null
  consumed: SessionEventId | null
  expired: SessionEventId | null
}

export const workflowRetryExpiredEvent = createDurableEventDefinition({ type: 'workflow/retry-expired', payloadVersion: 1, ignorable: false,
  decode(value) {
    const p = record(value); exact(p, ['assignment', 'failure', 'observedAt'])
    return { assignment: workflowReference(p.assignment), failure: eventId(p.failure), observedAt: timestamp(p.observedAt) }
  } })

/** The known failure fixes the retry decision deadline, including time spent releasing the old attempt. */
export function retryAfterFailure(definition: WorkflowDefinition, assignment: WorkflowSnapshot['assignments'][number],
  failure: SessionEventId, recordedAt: string): WorkflowRetry | undefined {
  if (assignment.payload.kind !== 'production') return undefined
  const node = definition.nodes.find(node => node.nodeKey === assignment.payload.nodeKey)!
  if (assignment.payload.attempt >= node.attempts.length) return undefined
  return { assignment: { address: definition.coordinator, eventId: assignment.stored.eventId }, failure,
    deadline: new Date(Math.min(Date.parse(definition.deadline), Date.parse(recordedAt) + node.attempts[assignment.payload.attempt - 1]!.retryDecisionMs)).toISOString(),
    request: null, consumed: null, expired: null }
}

export function reserveWorkflowAttempt(used: AgentBudget, attempt: WorkflowAttempt, budget: AgentBudget): AgentBudget | null {
  let next = reserveAgentBudget(used, attempt.workerGrant, budget)
  for (const reviewer of attempt.reviewerGrants) {
    if (next === null) break
    next = reserveAgentBudget(next, reviewer.grant, budget)
  }
  return next
}

type RetryBudgetState = Pick<WorkflowSnapshot, 'definition' | 'assignments' | 'retries' | 'reservedBudget'>

/** Authorized, undispatched retries retain their grant claim until their own CP-W consumes it. */
export function workflowBudgetWithRetries(state: RetryBudgetState, omit?: SessionEventId): AgentBudget | null {
  let used: AgentBudget | null = state.reservedBudget
  for (const retry of state.retries) {
    if (retry.request === null || retry.consumed !== null || retry.expired !== null || retry.assignment.eventId === omit) continue
    const work = state.assignments.find(item => item.stored.eventId === retry.assignment.eventId)!.payload
    const attempt = state.definition!.payload.nodes.find(node => node.nodeKey === work.nodeKey)!.attempts[work.attempt]!
    if (used === null) return null
    used = reserveWorkflowAttempt(used, attempt, state.definition!.payload.budget)
  }
  return used
}

export function retryRequestFailure(state: RetryBudgetState & Pick<WorkflowSnapshot, 'stop' | 'terminal' | 'upstream'>,
  input: WorkflowRetryRequest, observedAt: string): string | undefined {
  const work = state.assignments.filter(item => item.payload.kind === 'production' && item.payload.nodeKey === input.nodeKey).at(-1)
  const retry = state.retries.find(item => sameWorkflowValue(item.assignment, input.failedAssignment))
  if (state.stop !== null || state.terminal !== null || work?.stored.eventId !== input.failedAssignment.eventId || retry === undefined
    || retry.request !== null || retry.expired !== null || retry.consumed !== null
    || state.upstream.find(item => item.nodeKey === input.nodeKey)?.state.kind !== 'retry-awaiting-decision') return 'workflow-retry-unavailable'
  if (observedAt >= retry.deadline) return 'workflow-retry-expired'
  const used = workflowBudgetWithRetries(state)
  const attempt = state.definition!.payload.nodes.find(node => node.nodeKey === input.nodeKey)!.attempts[work.payload.attempt]!
  if (used === null || reserveWorkflowAttempt(used, attempt, state.definition!.payload.budget) === null) return 'workflow-retry-budget'
  return undefined
}

/** The next production template requires an applied control naming the exact preceding failure. */
export function nextWorkflowAttempt(state: Pick<WorkflowSnapshot, 'assignments' | 'retries' | 'controls'>, nodeKey: string): number | undefined {
  const previous = state.assignments.filter(item => item.payload.kind === 'production' && item.payload.nodeKey === nodeKey).at(-1)
  if (previous === undefined) return 1
  const retry = state.retries.find(item => item.assignment.eventId === previous.stored.eventId)
  return retry?.consumed === null && retry.expired === null && state.controls.some(item => item.requested.stored.eventId === retry.request
    && item.settled?.payload.outcome === 'applied') ? previous.payload.attempt + 1 : undefined
}
