export const fields = form => Object.fromEntries(new FormData(form))
const number = value => { const parsed = Number(value); if (String(value).trim() === '' || !Number.isSafeInteger(parsed)) throw new Error('数值必须是整数'); return parsed }
const lines = value => value.split('\n').map(item => item.trim()).filter(Boolean)
/** Translate explicit operator fields into the existing protocol without inferred grants. */
export function formRequest(id, value, operation, context) {
  const agentKey = context.agentKey
  switch (id) {
    case 'task-form': return ['input.submit', { agentKey, submissionKey: value.submissionKey, text: value.text }]
    case 'shutdown-form': return ['host.shutdown', { expectedInstanceId: context.instanceId, mode: value.mode }]
    case 'input-form': return ['input.get', { agentKey, ...(value.lookup === 'event' ? { inputEventId: value.value } : { submissionKey: value.value }) }]
    case 'root-form': return [`root.${operation}`, { agentKey, rootId: value.rootId, ...(operation === 'wait' ? { timeoutMs: number(value.timeoutMs) } : {}) }]
    case 'root-cancel-form': return ['root.cancel', { agentKey, rootId: context.rootId, reason: value.reason }]
    case 'message-form': {
      JSON.parse(value.payloadJson)
      return [`message.${value.operation}`, { agentKey, type: value.type, payloadVersion: number(value.payloadVersion), payloadJson: value.payloadJson,
        ...(value.operation === 'send' ? { peerKey: value.peerKey } : { messageId: value.messageId }) }]
    }
    case 'message-query-form': return [`message.${operation}`, { agentKey, messageId: value.messageId, direction: value.direction,
      ...(operation === 'wait' ? { until: value.direction === 'outbox' ? 'terminal' : 'disposed', timeoutMs: number(value.timeoutMs) } : {}) }]
    case 'child-spawn-form': return ['delegation.spawn', { parentAgentKey: agentKey, parentRoot: value.parentRoot, requestKey: value.requestKey,
      request: { templateKey: value.templateKey, templateVersion: number(value.templateVersion), task: value.task, materials: JSON.parse(value.materials),
        requestedBudget: Object.fromEntries(['models','steps','tools','messages','waits','outputTokens'].map(key => [key, number(value[key])])),
        workspace: value.workspaceKind === 'none' ? { kind: 'none' } : { kind: value.workspaceKind, resourceId: value.resourceId, readFiles: lines(value.readFiles), writePrefixes: lines(value.writePrefixes) } } }]
    case 'child-form': return [`delegation.${operation}`, { parentAgentKey: agentKey, parentRoot: value.parentRoot, delegationId: value.delegationId,
      ...(operation === 'wait' ? { until: value.until, timeoutMs: number(value.timeoutMs) } : operation === 'cancel' ? { requestKey: value.requestKey } : {}) }]
    case 'workflow-form': return [`workflow.${operation}`, { workflowKey: value.workflowKey,
      ...(operation === 'wait' ? { until: value.until, timeoutMs: number(value.timeoutMs) } : ['pause','resume','cancel'].includes(operation) ? { requestKey: value.requestKey, reason: value.reason } : {}) }]
    case 'workflow-retry-form': return ['workflow.retry', { workflowKey: context.workflowKey, requestKey: value.requestKey, nodeKey: value.nodeKey,
      failedAssignment: { address: value.address, eventId: value.eventId } }]
    case 'output-form': return ['workflow.output', { workflowKey: context.workflowKey, nodeKey: value.nodeKey }]
    case 'artifact-form': return ['workflow.artifact', { workflowKey: context.workflowKey, artifactRef: { address: value.address, eventId: value.eventId } }]
    case 'events-form': {
      const target = value.kind === 'member' ? { kind: 'member', agentKey } : value.kind === 'workflow' ? { kind: 'workflow', workflowKey: context.workflowKey }
        : { kind: 'child', parentAgentKey: agentKey, parentRoot: context.parentRoot, delegationId: context.delegationId }
      return ['session.events', { target, maxEvents: number(value.maxEvents), after: number(value.after) }]
    }
    default: throw new Error('未定义的操作表单')
  }
}
