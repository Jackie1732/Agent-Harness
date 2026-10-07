import { budgetSchema as budget, choice, eventIdSchema as event, flagSchema as flag, integerSchema as integer,
  literal, list, nullable, object, positiveSchema as positive, stringSchema as string,
  timestampSchema as time, uuidSchema as uuid, workflowReferenceSchema as ref } from './schema-fields.js'

export const delegationFields = {
  delegationId: event, parentKey: string, parentRoot: event, childSessionId: uuid, deadline: time,
  grant: budget, localReserved: budget, parentProtocolReserve: budget,
  childModelUsage: nullable(object({ settled: integer, partialOrUnknown: integer, inputTokens: nullable(integer), outputTokens: nullable(integer) })),
  parentResourceGenerations: integer,
  businessResolved: flag, executionReleased: flag, adopted: flag, inputDisposed: flag, closed: flag,
  resultAvailable: flag, pendingQuestions: integer,
  parentResources: list(object({ component: choice(['execution', 'protocol']), generation: integer, outcome: string })),
  childResources: list(object({ opened: event, component: choice(['execution', 'protocol']), generation: integer,
    release: nullable(event), outcome: choice(['pending', 'released', 'cleanup-incomplete', 'unknown']) })),
  cleanupIncomplete: flag, suspended: flag, recoveryRequired: flag, failed: flag, failureCode: nullable(string),
}
const workUsage = { modelCalls: integer, toolCalls: integer, unknownCalls: integer, inputTokens: nullable(integer), outputTokens: nullable(integer) }
const group = object({ request: event, interaction: ref, observedAt: time, outcome: choice(['completed', 'failed', 'cancelled', 'timed-out']),
  recipients: list(object({ assignment: ref, status: choice(['delivered', 'rejected', 'abandoned', 'outcome-unknown']), source: event })) })
const work = object({ assignment: ref, root: event, outcome: nullable(choice(['completed', 'failed', 'cancelled', 'budget-exhausted', 'result-unknown', 'timed-out'])),
  allowance: budget, reserved: budget, localReserved: budget, delegatedBudget: budget,
  execution: choice(['unknown', 'active', 'released', 'release-pending']), recovery: nullable(event),
  pendingWaits: integer, externalWaits: integer, exhausted: flag, unknown: flag, usage: object(workUsage), groups: list(group) })
const countNames = ['workRoots', 'artifacts', 'unknown', 'exhausted', 'pendingResources', 'cleanupIncomplete', 'pendingRecoveries',
  'pendingWaits', 'externalWaits', 'runnable', 'nodes', 'assignments', 'proposals', 'reviews', 'progress', 'accepted', 'failed',
  'pendingInbox', 'questions', 'pendingQuestions', 'groups', 'pendingGroups', 'pendingControls', 'retries', 'pendingRetries', 'pendingStops', 'pendingOutbox']
export const workflowFields = {
  workflowKey: string, desired: choice(['paused', 'running']), state: string, settled: flag, closed: flag,
  terminal: nullable(ref), budget, reservedBudget: budget, usage: object({ scope: literal('participant-roots'), ...workUsage }),
  recovery: list(object({ domain: string, supersedes: event })), work: list(work),
  artifacts: list(object({ ref, name: string, mediaType: literal('text/plain'), byteLength: integer, sha256: { ...string, pattern: '^[a-f0-9]{64}$' } })),
  counts: object(Object.fromEntries(countNames.map(key => [key, integer]))),
  progress: list(object({ inbox: event, value: object({ assignment: ref, root: event, ordinal: positive, text: string }) })),
  retries: list(object({ assignment: ref, failure: event, deadline: time, request: nullable(event), consumed: nullable(event), expired: nullable(event) })),
  nodes: list(object({ nodeKey: string, status: string })),
  assignments: list(object({ ref, nodeKey: string, memberKey: string, attempt: positive })), truncated: flag,
}
