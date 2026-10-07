import type { JsonObject } from '../foundation/json.js'
import { actionReferenceSchema as action, budgetSchema as budget, choice, eventIdSchema as event, flagSchema as flag,
  inputReferenceSchema as inputRef, inputStatusSchema, integerSchema as integer, literal, list, nameSchema as name,
  nullable, object, positiveSchema as positive, reference, rootOutcomeSchema, runSelectionSchema,
  stringSchema as string, timestampSchema as time, union, uuidSchema as uuid, workflowReferenceSchema as work } from './schema-fields.js'

const descriptorBase = { root: event, deadline: time, observedAt: time, protectedTurns: list(event, true) }
export const waitDescriptorSchema = union(
  object({ ...descriptorBase, kind: literal('user'), question: { ...name, maxUtf8Bytes: 1024 * 1024 } }),
  object({ ...descriptorBase, kind: literal('reply'), messageId: uuid, outboxEventId: event }),
  object({ ...descriptorBase, kind: literal('delegation'), delegation: event }),
  object({ ...descriptorBase, kind: literal('parent-answer'), delegation: event, question: event }),
  object({ ...descriptorBase, kind: literal('work-message'), assignment: work, receive: choice(['question', 'group', 'either']) }),
  object({ ...descriptorBase, kind: choice(['work-answer', 'work-group']), request: event, interaction: work }),
)
const actionResult = union(object({ kind: literal('tool'), settled: event }), object({ kind: literal('outbox'), accepted: event }),
  object({ kind: literal('wait'), descriptor: waitDescriptorSchema }), object({ kind: literal('protocol-accepted'), protocol: event }),
  object({ kind: literal('not-started'), reason: name }),
  object({ kind: literal('communication-not-accepted'), reason: name, basis: choice(['observed-rejection', 'recovered-absence']) }))
const committed = (payload: JsonObject) => object({ kind: literal('known'), stored: reference('storedEvent'), payload })
const runStarted = union(object({ spec: event, kind: choice(['drive', 'command']), selection: runSelectionSchema }, ['selection']),
  object({ spec: event, kind: literal('maintenance') }))
const runSettled = object({ run: event, stoppedBy: choice(['idle', 'paused', 'waiting', 'run-budget', 'cancelled', 'faulted', 'interrupted', 'command-settled', 'command-budget']), reason: name })
const waitSettled = object({ wait: action, outcome: choice(['matched', 'timed-out', 'cancelled', 'unavailable']),
  response: nullable(inputRef), reason: name, observedAt: time,
  supportedMessages: list(object({ type: name, payloadVersion: positive })), outboxTerminal: nullable(event) })
const root = object({ id: event, deadline: time, budget, limit: budget, allowedTools: list(string), allowedNativeActions: list(string),
  source: runSelectionSchema, outcome: nullable(rootOutcomeSchema), reason: nullable(string), stopControl: nullable(event) })
const input = object({ reference: inputRef, lane: string, status: inputStatusSchema, claimedBy: nullable(event), reservedBy: nullable(action), everMatched: flag, reason: nullable(string) })
const wait = object({ reference: action, created: committed(object({ action, result: actionResult })), turn: event, settled: nullable(committed(waitSettled)) })
const usageFields = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'reasoningOutputTokens']
const usage = object({ source: literal('provider'), completeness: choice(['unknown', 'partial', 'complete']),
  ...Object.fromEntries(usageFields.map(key => [key, integer])) }, usageFields)
const vectorNames = ['roots', 'inputs', 'waits', 'modelUsage', 'pendingReceipts', 'pendingControls', 'pendingOutbox', 'turns']
const countNames = ['roots', 'inputs', 'pendingWaits', 'modelUsage', 'pendingReceipts', 'pendingControls', 'pendingOutbox', 'turns',
  'pendingInputs', 'queuedInputs', 'reservedInputs', 'reviewRequiredInputs', 'failedRoots', 'exhaustedRoots']

/** Existing report fields, decoded without importing the Agent execution owner. */
export const agentReportSchema = object({
  run: nullable(object({ started: committed(runStarted), settled: nullable(committed(runSettled)) })),
  openRun: nullable(event), openTurn: nullable(event), roots: list(root), inputs: list(input), waits: list(wait),
  modelUsage: list(object({ step: event, settled: event, external: choice(['not-issued', 'may-have-been-issued', 'response-observed']), usage })),
  pendingReceipts: list(object({ reference: inputRef, disposition: inputStatusSchema })),
  pendingControls: list(object({ eventId: event, kind: string })),
  pendingOutbox: list(object({ messageId: uuid, accepted: event, attemptCount: integer })),
  turns: list(object({ turn: event, root: event, settled: nullable(event), outcome: nullable(choice(['completed', 'waiting', 'failed', 'cancelled', 'budget-exhausted', 'result-unknown', 'interrupted'])) })),
  truncated: object(Object.fromEntries(vectorNames.map(key => [key, flag]))),
  counts: object(Object.fromEntries(countNames.map(key => [key, integer]))),
  nextWakeAt: nullable(time),
  final: nullable(object({ turn: event, settled: event, text: nullable(string), textBytes: integer, textOmitted: flag })),
})
export const readinessSchema = object({ sourcePosition: integer, canRun: flag, canMaintain: flag, nextWakeAt: nullable(time),
  blockedBy: choice(['none', 'ended', 'recovery-required', 'closing', 'driver-active', 'unsupported-input', 'review-required', 'waiting', 'idle', 'cleanup-incomplete', 'capacity']),
  counts: object({ runnableInputs: integer, pendingMaintenance: integer, unsupportedInputs: integer, reviewRequiredInputs: integer }) })
