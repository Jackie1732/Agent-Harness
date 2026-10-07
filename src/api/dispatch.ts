import type { AtomicHost, HostShutdownMode } from '../host/runtime.js'
import type { ResolvedHostSpec } from '../host/config.js'
import type { ApiLimits, ApiPrincipal } from './config.js'
import type { AnyControlRequest, Result, ControlMethod } from '../protocol/index.js'
import { principalControlKey, principalNamespace } from './authorization.js'
import { ApiRejection } from './errors.js'
import { HarnessError } from '../foundation/error.js'
import { formatSessionAddress, parseSessionAddress, parseSessionId } from '../session/ids.js'

/** Map each closed method to its original owner; this adapter owns no durable business state. */
export async function dispatchControl(host: AtomicHost, spec: ResolvedHostSpec, principal: ApiPrincipal, request: AnyControlRequest,
  limits: ApiLimits, signal: AbortSignal, shutdown: (mode: HostShutdownMode) => Promise<void>,
  progress: { domainReturned: boolean }): Promise<Result<ControlMethod>> {
  if (request.method === 'host.shutdown') {
    await shutdown(request.params.mode)
    return { instanceId: host.instanceId, mode: host.shutdownState.mode!, hostStatus: 'stopped', serviceStatus: 'closing' }
  }
  const reads = host.read(), namespace = principalNamespace(principal)
  if ('timeoutMs' in request.params && request.params.timeoutMs > limits.maxWaitMs) throw new ApiRejection('API_LIMIT_EXCEEDED', 'not-applicable')
  switch (request.method) {
    case 'host.status': return await reads.status()
    case 'host.run': {
      const report = await host.run()
      return { instanceId: host.instanceId, report, cuts: report.cuts! }
    }
    case 'agent.get': return await reads.agent(request.params.agentKey)
    case 'agent.pause':
      host.pause(request.params.agentKey)
      return { agentKey: request.params.agentKey, instanceId: host.instanceId, paused: true }
    case 'agent.resume': {
      if (reads.agent(request.params.agentKey).mailbox !== 'online') throw new ApiRejection('API_INACTIVE')
      const resumptions = host.resume(request.params.agentKey)
      return { agentKey: request.params.agentKey, instanceId: host.instanceId, paused: (await reads.agent(request.params.agentKey)).paused, resumptions }
    }
    case 'input.submit': return await host.submitKeyedInput(request.params.agentKey,
      { kind: 'task', text: request.params.text, originLabel: namespace }, { namespace, key: request.params.submissionKey })
    case 'input.answer': {
      let prior
      try { prior = reads.input(request.params.agentKey, { namespace, key: request.params.submissionKey }) }
      catch (error) { if (!(error instanceof HarnessError) || error.code !== 'HOST_TARGET_NOT_FOUND') throw error }
      if (prior === undefined) {
        const root = reads.answerRoot(request.params.agentKey, request.params.wait)
        if (root.outcome !== null || root.stopControl !== null || !root.waits.some(wait => wait.reference.eventId === request.params.wait.eventId
          && wait.reference.index === request.params.wait.index && wait.descriptor.kind === 'user')) throw new ApiRejection('API_OPERATION_REJECTED')
      }
      return await host.submitKeyedInput(request.params.agentKey,
        { kind: 'answer', wait: request.params.wait, text: request.params.text, originLabel: namespace }, { namespace, key: request.params.submissionKey })
    }
    case 'input.get': return await reads.input(request.params.agentKey, request.params.inputEventId !== undefined
      ? { inputEventId: request.params.inputEventId } : { namespace, key: request.params.submissionKey })
    case 'root.get': return await reads.root(request.params.agentKey, request.params.rootId)
    case 'root.wait': return await host.observe(() => reads.root(request.params.agentKey, request.params.rootId),
      observation => observation.outcome !== null, { timeoutMs: request.params.timeoutMs, scanIntervalMs: limits.observerScanIntervalMs, signal })
    case 'root.cancel': {
      await host.cancel(request.params.agentKey, request.params.rootId, request.params.reason)
      progress.domainReturned = true
      const root = await reads.root(request.params.agentKey, request.params.rootId)
      return { agentKey: root.agentKey, sessionId: root.sessionId, rootId: root.rootId, stopControl: root.stopControl,
        outcome: root.outcome, instanceId: root.instanceId, cuts: root.cuts, recoveryRequired: root.recoveryRequired }
    }
    case 'message.send':
    case 'message.reply': {
      const p = request.params
      const report = await host.sendMessage(p.agentKey, request.method === 'message.send'
        ? { kind: 'send', peerKey: request.params.peerKey, type: p.type, payloadVersion: p.payloadVersion, payloadJson: p.payloadJson }
        : { kind: 'reply', messageId: request.params.messageId, type: p.type, payloadVersion: p.payloadVersion, payloadJson: p.payloadJson })
      const sessionId = parseSessionId(spec.members.find(member => member.agentKey === p.agentKey)!.sessionId)
      const evidence = { agentKey: p.agentKey, sessionId, instanceId: host.instanceId, cuts: report.cuts }
      const command = report.command
      if (command.status === 'outbox-accepted') return { ...evidence, status: 'outbox-accepted', runId: command.runId,
        commandEventId: command.commandEventId!, action: command.action!, outboxAcceptedEventId: command.outboxAcceptedEventId!, messageId: command.messageId!, reason: null }
      return { ...evidence, status: 'not-accepted', runId: command.runId, commandEventId: command.commandEventId,
        action: command.action, outboxAcceptedEventId: null, messageId: null, reason: command.reason! }
    }
    case 'message.get': return await reads.message(request.params.agentKey, request.params.messageId, request.params.direction)
    case 'message.wait': return await host.observe(() => reads.message(request.params.agentKey, request.params.messageId, request.params.direction),
      observation => observation.fact.status !== 'pending', { timeoutMs: request.params.timeoutMs, scanIntervalMs: limits.observerScanIntervalMs, signal })
    case 'session.events': {
      if (request.params.maxEvents > limits.maxPageEvents) throw new ApiRejection('API_LIMIT_EXCEEDED', 'not-applicable')
      const overhead = Buffer.byteLength(JSON.stringify({ protocol: 'atomic-harness-control', version: 1, requestId: request.requestId, kind: 'result', result: null })) - 4
      return await reads.events(request.params.target, { ...request.params, maxBytes: limits.maxResponseBytes - overhead })
    }
    case 'delegation.spawn': {
      const p = request.params
      const receipt = await host.bindParent(parentAddress(spec, p.parentAgentKey), p.parentRoot).spawn(principalControlKey(principal, p.requestKey), p.request)
      progress.domainReturned = true
      const observation = await reads.delegation(p.parentAgentKey, p.parentRoot, receipt.delegationId)
      return { delegationId: receipt.delegationId, childSessionId: parseSessionId(receipt.childSessionId), childAddress: formatSessionAddress(parseSessionAddress(receipt.childAddress)), instanceId: host.instanceId, cuts: observation.cuts }
    }
    case 'delegation.get': return await reads.delegation(request.params.parentAgentKey, request.params.parentRoot, request.params.delegationId)
    case 'delegation.wait': {
      const p = request.params
      return await host.bindParent(parentAddress(spec, p.parentAgentKey), p.parentRoot).wait(p.delegationId, { until: p.until, timeoutMs: p.timeoutMs, signal })
    }
    case 'delegation.cancel': {
      const p = request.params
      const result = await host.bindParent(parentAddress(spec, p.parentAgentKey), p.parentRoot).cancel(p.delegationId, principalControlKey(principal, p.requestKey))
      progress.domainReturned = true
      const observation = await reads.delegation(p.parentAgentKey, p.parentRoot, p.delegationId)
      return 'eventId' in result ? { status: 'requested', eventId: result.eventId, instanceId: host.instanceId, cuts: observation.cuts }
        : { status: 'already-closed', instanceId: host.instanceId, cuts: observation.cuts }
    }
    case 'workflow.get': return await reads.workflow(request.params.workflowKey)
    case 'workflow.wait': {
      const p = request.params
      const { status, observation } = await host.workflow(p.workflowKey).wait({ until: p.until, timeoutMs: p.timeoutMs, signal })
      return { status, observation }
    }
    case 'workflow.pause':
    case 'workflow.resume':
    case 'workflow.cancel': {
      const p = request.params, workflow = host.workflow(p.workflowKey)
      const input = { requestKey: principalControlKey(principal, p.requestKey), reason: p.reason }
      const result = await (request.method === 'workflow.pause' ? workflow.pause(input) : request.method === 'workflow.resume' ? workflow.resume(input) : workflow.cancel(input))
      progress.domainReturned = true
      return { ...result, instanceId: host.instanceId, cuts: (await reads.workflow(p.workflowKey)).cuts }
    }
    case 'workflow.retry': {
      const p = request.params
      const result = await host.workflow(p.workflowKey).retry({ requestKey: principalControlKey(principal, p.requestKey), nodeKey: p.nodeKey, failedAssignment: p.failedAssignment })
      progress.domainReturned = true
      return { ...result, instanceId: host.instanceId, cuts: (await reads.workflow(p.workflowKey)).cuts }
    }
    case 'workflow.output': return await reads.output(request.params.workflowKey, request.params.nodeKey)
    case 'workflow.artifact': return await reads.artifact(request.params.workflowKey, request.params.artifactRef)
  }
}
function parentAddress(spec: ResolvedHostSpec, key: string) {
  const member = spec.members.find(member => member.kind === 'local' && member.agentKey === key)
  if (member === undefined) throw new ApiRejection('API_TARGET_NOT_FOUND')
  return formatSessionAddress(parseSessionId(member.sessionId))
}
