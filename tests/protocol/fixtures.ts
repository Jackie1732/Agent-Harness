import { CONTROL_METHODS, CONTROL_PROTOCOL, CONTROL_VERSION, parseRequestId } from '../../src/protocol/index.js'
import type { ControlMethod, Params } from '../../src/protocol/index.js'
import { formatSessionAddress, formatSessionEventId, parseSessionId, sessionLogPosition, sessionSequence } from '../../src/session/ids.js'
import { parseMessageId } from '../../src/communication/ids.js'

export const instanceId = '91000000-0000-4000-8000-000000000001'
export const sessionId = parseSessionId('91000000-0000-4000-8000-000000000002')
export const eventId = formatSessionEventId(sessionId, sessionSequence(1))
export const messageId = parseMessageId('91000000-0000-4000-8000-000000000003')
export const ref = { address: formatSessionAddress(sessionId), eventId }
export const cut = { sessionId, through: sessionLogPosition(1) }
export const evidence = { instanceId, cuts: [cut], recoveryRequired: false }
export const receiptEvidence = { instanceId, cuts: [cut] }
export const wait = { eventId, index: 0 }
export const budget = { models: 1, steps: 1, tools: 0, messages: 1, waits: 1, outputTokens: 16 }
const agent = { agentKey: 'writer' }
const root = { ...agent, rootId: eventId }
const delegation = { parentAgentKey: 'writer', parentRoot: eventId, delegationId: eventId }
const workflow = { workflowKey: 'research' }
const workflowControl = { ...workflow, requestKey: 'stable-key', reason: '' }
const content = { type: 'test/note', payloadVersion: 1, payloadJson: '{"text":"hello"}' }

export const params = {
  'host.status': {}, 'host.run': { expectedInstanceId: instanceId },
  'host.shutdown': { expectedInstanceId: instanceId, mode: 'cancel' },
  'agent.get': agent, 'agent.pause': { ...agent, expectedInstanceId: instanceId }, 'agent.resume': { ...agent, expectedInstanceId: instanceId },
  'input.submit': { ...agent, submissionKey: 'stable-key', text: 'task' },
  'input.answer': { ...agent, submissionKey: 'stable-key', text: 'answer', wait },
  'input.get': { ...agent, submissionKey: 'stable-key' },
  'root.get': root, 'root.wait': { ...root, timeoutMs: 10 }, 'root.cancel': { ...root, reason: 'cancelled' },
  'message.send': { ...agent, peerKey: 'reviewer', ...content }, 'message.reply': { ...agent, messageId, ...content },
  'message.get': { ...agent, messageId, direction: 'outbox' },
  'message.wait': { ...agent, messageId, direction: 'inbox', until: 'disposed', timeoutMs: 10 },
  'session.events': { target: { kind: 'member', agentKey: 'writer' }, maxEvents: 10 },
  'delegation.spawn': { parentAgentKey: 'writer', parentRoot: eventId, requestKey: 'stable-key', request: {
    templateKey: 'researcher', templateVersion: 1, task: 'find sources', materials: [], requestedBudget: budget, workspace: { kind: 'none' },
  } },
  'delegation.get': delegation, 'delegation.wait': { ...delegation, until: 'closed', timeoutMs: 10 },
  'delegation.cancel': { ...delegation, requestKey: 'stable-key' },
  'workflow.get': workflow, 'workflow.wait': { ...workflow, until: 'settled', timeoutMs: 10 },
  'workflow.pause': workflowControl, 'workflow.resume': workflowControl, 'workflow.cancel': workflowControl,
  'workflow.retry': { ...workflow, requestKey: 'stable-key', nodeKey: 'paper', failedAssignment: ref },
  'workflow.output': { ...workflow, nodeKey: 'paper' }, 'workflow.artifact': { ...workflow, artifactRef: ref },
} as const satisfies { [M in ControlMethod]: Params<M> }

export const requestId = parseRequestId('request-1')
export function request<M extends ControlMethod>(method: M, supplied: unknown = params[method]) {
  return { protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId, method, params: supplied }
}
export const jsonLimits = { maxBytes: 1024 * 1024, maxDepth: 64, maxNodes: 100000 }
export { CONTROL_METHODS }
