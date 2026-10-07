import type { JsonObject } from '../foundation/json.js'
import type { ControlMethod } from './constants.js'
import { agentReportSchema, readinessSchema, waitDescriptorSchema } from './agent-schemas.js'
import { delegationFields, workflowFields } from './collaboration-schemas.js'
import { inboxFactSchema, outboxFactSchema } from './communication-schemas.js'
import { actionReferenceSchema as action, addressSchema as address, choice, coverageSchema, cursorSchema,
  eventIdSchema as event, flagSchema as flag, inputStatusSchema, integerSchema as integer, keySchema,
  literal, list, nameSchema as name, nullable, object, positiveSchema, rootOutcomeSchema, runSelectionSchema,
  stringSchema as string, timestampSchema, union, uuidSchema as uuid, workflowReferenceSchema as ref } from './schema-fields.js'

const receipt = { instanceId: uuid, cuts: list(coverageSchema) }
const evidence = { ...receipt, recoveryRequired: flag }
const agent = { agentKey: name, sessionId: uuid }
const root = { ...agent, rootId: event }
const hostStatus = choice(['ready', 'stopping', 'stopped', 'failed'])
const counts = object(Object.fromEntries(['members', 'pendingInputs', 'pendingWaits', 'pendingOutbox', 'pendingMaintenance',
  'runnableInputs', 'reviewRequiredInputs', 'unsupportedInputs', 'blockedMembers', 'failedRoots', 'exhaustedRoots'].map(key => [key, integer])))
const member = object({ ...agent, paused: flag, faulted: flag, mailbox: choice(['online', 'known-offline', 'ended']),
  routingPaused: flag, readiness: readinessSchema, agent: agentReportSchema })
const sharedHost = { blockedRoutes: list(string), members: list(member), counts, truncated: flag }
const current = object({ status: hostStatus, shutdownMode: nullable(choice(['drain', 'cancel'])), hostKey: string,
  instanceId: uuid, configVersion: choice([1, 2, 3]), configFingerprint: string, configuredMembers: integer,
  remoteMembers: integer, unfinishedOperations: integer, shutdownOverdue: flag, ...sharedHost, cuts: list(coverageSchema) })
const run = object({ batches: integer, businessRuns: integer, maintenanceRuns: integer, deliveryAttempts: integer,
  stoppedBy: choice(['quiescent', 'batch-budget', 'no-progress', 'aborted', 'host-stopping']), ...sharedHost,
  cuts: list(coverageSchema) }, ['cuts'])
const rootObservation = object({ ...root, ...evidence, source: runSelectionSchema, outcome: nullable(rootOutcomeSchema),
  reason: nullable(string), stopControl: nullable(event), waits: list(object({ reference: action, descriptor: waitDescriptorSchema })),
  final: nullable(object({ turnId: event, stepId: event, modelSettledId: event, text: nullable(string), textBytes: integer, textOmitted: flag })),
  executionPending: flag })
const messageObservation = union(object({ ...agent, ...evidence, direction: literal('outbox'), fact: outboxFactSchema }),
  object({ ...agent, ...evidence, direction: literal('inbox'), fact: inboxFactSchema }))
const delegationObservation = object({ ...delegationFields, ...evidence }, ['failureCode'])
const workflowObservation = object({ ...workflowFields, ...evidence })
const wait = (observation: JsonObject) => object({ status: choice(['condition-met', 'timeout', 'host-closed']), observation })
const messageCommand = union(object({ ...agent, ...receipt, status: literal('outbox-accepted'), runId: event,
  commandEventId: event, action, outboxAcceptedEventId: event, messageId: uuid, reason: literal(null) }),
  object({ ...agent, ...receipt, status: literal('not-accepted'), runId: nullable(event), commandEventId: nullable(event),
    action: nullable(action), outboxAcceptedEventId: literal(null), messageId: literal(null), reason: name }))
const control = object({ ...receipt, status: choice(['applied', 'no-op']), ref })
const resume = object({ ...receipt, status: choice(['applied', 'resumed', 'no-op']), ref })

export const STORED_EVENT_SCHEMA = object({ envelopeVersion: literal(1), sessionId: uuid, eventId: event, sequence: positiveSchema,
  recordedAt: timestampSchema, type: name, payloadVersion: positiveSchema, payload: {}, ignorable: literal(true) }, ['ignorable'])

/** Each method validates its entire pure result, including original report vectors. */
export const RESULT_SCHEMAS = {
  'host.status': object({ ...receipt, hostStatus, activity: choice(['idle', 'run', 'command']), report: current }),
  'host.run': object({ ...receipt, report: run }),
  'host.shutdown': object({ instanceId: uuid, mode: choice(['drain', 'cancel']), hostStatus: literal('stopped'), serviceStatus: literal('closing') }),
  'agent.get': object({ ...agent, ...evidence, paused: flag, faulted: flag, mailbox: choice(['online', 'known-offline', 'ended']),
    routingPaused: flag, readiness: readinessSchema, report: agentReportSchema }),
  'agent.pause': object({ agentKey: name, instanceId: uuid, paused: literal(true) }),
  'agent.resume': object({ agentKey: name, instanceId: uuid, paused: flag,
    resumptions: list(object({ delegationId: event, status: choice(['resumed', 'blocked']), reasonCode: name })) }),
  'input.submit': object({ ...agent, inputEventId: event, reused: flag }),
  'input.answer': object({ ...agent, inputEventId: event, reused: flag }),
  'input.get': object({ ...agent, ...evidence, inputEventId: event, kind: choice(['task', 'answer']),
    submission: nullable(object({ namespace: keySchema, key: keySchema })), status: inputStatusSchema,
    claimedBy: nullable(event), rootId: nullable(event), reason: nullable(string), wait: nullable(action) }),
  'root.get': rootObservation, 'root.wait': wait(rootObservation),
  'root.cancel': object({ ...root, ...evidence, stopControl: nullable(event), outcome: nullable(rootOutcomeSchema) }),
  'message.send': messageCommand, 'message.reply': messageCommand,
  'message.get': messageObservation, 'message.wait': wait(messageObservation),
  'session.events': object({ sessionId: uuid, through: integer, parent: nullable(coverageSchema),
    events: list(STORED_EVENT_SCHEMA), nextCursor: nullable(cursorSchema), hasMore: flag }),
  'delegation.spawn': object({ ...receipt, delegationId: event, childSessionId: uuid, childAddress: address }),
  'delegation.get': delegationObservation, 'delegation.wait': wait(delegationObservation),
  'delegation.cancel': union(object({ ...receipt, status: literal('requested'), eventId: event }),
    object({ ...receipt, status: literal('already-closed') })),
  'workflow.get': workflowObservation, 'workflow.wait': wait(workflowObservation),
  'workflow.pause': control, 'workflow.resume': resume, 'workflow.cancel': control, 'workflow.retry': control,
  'workflow.output': union(object({ ...receipt, workflowKey: name, nodeKey: name, status: literal('available'),
    value: {}, decisionRef: ref, assignmentRef: ref, proposalRef: ref }),
    object({ ...receipt, workflowKey: name, nodeKey: name, status: literal('not-available') })),
  'workflow.artifact': object({ ...receipt, workflowKey: name, artifactRef: ref, decisionRef: ref, assignmentRef: ref, proposalRef: ref,
    mediaType: literal('text/plain'), text: string, byteLength: integer, sha256: { ...string, pattern: '^[a-f0-9]{64}$' } }),
} as const satisfies Record<ControlMethod, JsonObject>
