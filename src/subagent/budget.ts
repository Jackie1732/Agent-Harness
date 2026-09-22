import { budgetFields, emptyAgentBudget, reserveAgentBudget } from '../agent/budget.js'
import type { AgentBudget } from '../agent/contract.js'
import { isCanonicalIsoTimestamp } from '../foundation/protocol-scalars.js'
import type { DelegationBudgetReservation } from './contract.js'
import { SubagentError } from './errors.js'

/** Reserve the full child grant and finite protocol before accepting CP-D. No refunds. */
export function reserveDelegationBudget(input: {
  readonly parentUsed: AgentBudget
  readonly parentLimit: AgentBudget
  readonly requested: AgentBudget
  readonly templateCap: AgentBudget
  readonly parentGrantCap: AgentBudget
  readonly parentMaxOutputTokens: number
  readonly childMaxOutputTokens: number
  readonly maxQuestions: number
  readonly maxProgress: number
}): DelegationBudgetReservation {
  const { maxQuestions: q, maxProgress: p, requested: grant } = input
  for (const number of [q, p, input.parentMaxOutputTokens, input.childMaxOutputTokens]) {
    if (!Number.isSafeInteger(number) || number < 0) exhausted('invalid-reservation')
  }
  const childMessages = q + p + 1
  const parentMessages = q + 1
  if (!Number.isSafeInteger(childMessages) || !Number.isSafeInteger(parentMessages)) exhausted('message-overflow')
  for (const field of budgetFields) {
    if (grant[field] > input.templateCap[field] || grant[field] > input.parentGrantCap[field]) exhausted('grant-cap')
  }
  if (grant.models < 1 || grant.steps < 1 || grant.outputTokens < input.childMaxOutputTokens
    || grant.messages < childMessages) exhausted('child-minimum')
  const parentProtocolReserve = { ...emptyAgentBudget, messages: parentMessages }
  const childProtocolReserve = { ...emptyAgentBudget, messages: childMessages }
  const withGrant = reserveAgentBudget(input.parentUsed, grant, input.parentLimit)
  if (withGrant === null) exhausted('parent-grant')
  const parentReserved = reserveAgentBudget(withGrant, parentProtocolReserve, input.parentLimit)
  if (parentReserved === null || reserveAgentBudget(parentReserved, {
    ...emptyAgentBudget, models: 1, steps: 1, outputTokens: input.parentMaxOutputTokens,
  }, input.parentLimit) === null) exhausted('parent-continuation')
  return Object.freeze({ grant, parentProtocolReserve: Object.freeze(parentProtocolReserve),
    childProtocolReserve: Object.freeze(childProtocolReserve), parentReserved,
    mailboxReserve: Object.freeze({ parent: Object.freeze({ inbox: childMessages, outbox: parentMessages }),
      child: Object.freeze({ inbox: parentMessages, outbox: childMessages }) }) })
}

/** An absolute admission-time deadline survives delayed installation and resumed generations. */
export function delegationDeadline(parentDeadline: string, observedAt: string, templateDurationMs: number, hostDurationMs: number): string {
  if (!isCanonicalIsoTimestamp(parentDeadline) || !isCanonicalIsoTimestamp(observedAt)) exhausted('invalid-deadline')
  const now = Date.parse(observedAt)
  for (const duration of [templateDurationMs, hostDurationMs]) {
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > 31_536_000_000
      || !Number.isFinite(new Date(now + duration).getTime())) exhausted('deadline-overflow')
  }
  const deadline = Math.min(Date.parse(parentDeadline), now + templateDurationMs, now + hostDurationMs)
  if (deadline <= now) exhausted('parent-expired')
  return new Date(deadline).toISOString()
}
function exhausted(reason: string): never { throw new SubagentError('SUBAGENT_BUDGET_EXHAUSTED', reason) }
