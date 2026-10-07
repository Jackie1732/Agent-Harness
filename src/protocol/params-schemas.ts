import type { JsonObject } from '../foundation/json.js'
import type { ControlMethod } from './constants.js'
import { actionReferenceSchema as wait, budgetSchema, choice, cursorSchema, eventIdSchema as event,
  integerSchema, keySchema as key, literal, list, nameSchema as name, object, positiveSchema,
  stringSchema, union, uuidSchema as uuid, workflowReferenceSchema as workflowRef } from './schema-fields.js'

const agent = { agentKey: name }
const root = { ...agent, rootId: event }
const delegation = { parentAgentKey: name, parentRoot: event, delegationId: event }
const workflow = { workflowKey: name }
const timed = { timeoutMs: { ...positiveSchema, maximum: 2_147_483_647 } }
const text = { ...stringSchema, minLength: 1, maxUtf8Bytes: 1024 * 1024 }
const control = { ...workflow, requestKey: key, reason: { ...stringSchema, maxUtf8Bytes: 1024 } }
const content = { type: name, payloadVersion: positiveSchema, payloadJson: text }
const target = union(object({ kind: literal('member'), ...agent }),
  object({ kind: literal('child'), ...delegation }), object({ kind: literal('workflow'), ...workflow }))
const workspace = union(object({ kind: literal('none') }), object({ kind: choice(['shared-read', 'exclusive-write']),
  resourceId: name, readFiles: list({ ...name, maxUtf8Bytes: 4096 }, true), writePrefixes: list({ ...name, maxUtf8Bytes: 4096 }, true) }))
const request = object({ templateKey: name, templateVersion: positiveSchema, task: text,
  materials: list(object({ label: name, text: { ...stringSchema, maxUtf8Bytes: 1024 * 1024 } })),
  requestedBudget: budgetSchema, workspace })

/** Method ownership fixes each command's fields before a domain method is called. */
export const PARAMS_SCHEMAS = {
  'host.status': object({}),
  'host.run': object({ expectedInstanceId: uuid }),
  'host.shutdown': object({ expectedInstanceId: uuid, mode: choice(['drain', 'cancel']) }),
  'agent.get': object(agent),
  'agent.pause': object({ ...agent, expectedInstanceId: uuid }),
  'agent.resume': object({ ...agent, expectedInstanceId: uuid }),
  'input.submit': object({ ...agent, submissionKey: key, text }),
  'input.answer': object({ ...agent, submissionKey: key, wait, text }),
  'input.get': union(object({ ...agent, inputEventId: event }), object({ ...agent, submissionKey: key })),
  'root.get': object(root),
  'root.wait': object({ ...root, ...timed }),
  'root.cancel': object({ ...root, reason: { ...name, maxUtf8Bytes: 128 } }),
  'message.send': object({ ...agent, peerKey: name, ...content }),
  'message.reply': object({ ...agent, messageId: uuid, ...content }),
  'message.get': object({ ...agent, messageId: uuid, direction: choice(['outbox', 'inbox']) }),
  'message.wait': union(object({ ...agent, messageId: uuid, ...timed, direction: literal('outbox'), until: literal('terminal') }),
    object({ ...agent, messageId: uuid, ...timed, direction: literal('inbox'), until: literal('disposed') })),
  'session.events': union(object({ target, maxEvents: positiveSchema, after: integerSchema }, ['after']),
    object({ target, maxEvents: positiveSchema, cursor: cursorSchema })),
  'delegation.spawn': object({ parentAgentKey: name, parentRoot: event, requestKey: key, request }),
  'delegation.get': object(delegation),
  'delegation.wait': object({ ...delegation, ...timed, until: choice(['business', 'closed']) }),
  'delegation.cancel': object({ ...delegation, requestKey: key }),
  'workflow.get': object(workflow),
  'workflow.wait': object({ ...workflow, ...timed, until: choice(['settled', 'closed']) }),
  'workflow.pause': object(control), 'workflow.resume': object(control), 'workflow.cancel': object(control),
  'workflow.retry': object({ ...workflow, requestKey: key, nodeKey: name, failedAssignment: workflowRef }),
  'workflow.output': object({ ...workflow, nodeKey: name }),
  'workflow.artifact': object({ ...workflow, artifactRef: workflowRef }),
} as const satisfies Record<ControlMethod, JsonObject>
