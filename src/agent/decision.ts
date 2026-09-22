import type { ModelSettlement } from '../model/settlement.js'
import type { AgentSpec } from './contract.js'
import type { AgentActionIntent, AgentStepDecided } from './event-contract.js'

/** Classify only the durable final model result; streamed fragments are not inputs. */
export function classifyAgentModel(
  result: ModelSettlement, spec: AgentSpec, advertised: readonly string[],
): Pick<AgentStepDecided, 'classification' | 'reason' | 'actions'> {
  if (result.cleanup.status !== 'complete' || result.cleanup.failedResources !== 0) {
    return { classification: 'failed', reason: 'model-cleanup', actions: [] }
  }
  if (result.outcome !== 'completed' || !result.result.protocolComplete || result.failure !== undefined) {
    return { classification: result.outcome === 'cancelled' ? 'cancelled' : 'failed', reason: `model-${result.outcome}`, actions: [] }
  }
  const calls = result.result.blocks.filter(block => block.kind === 'tool-call')
  if (result.result.stopReason === 'refusal') return { classification: 'failed', reason: 'business-refusal', actions: [] }
  if (result.result.stopReason === 'stop' && calls.length === 0 && result.result.blocks.some(block => block.kind === 'text' && block.complete)) {
    return { classification: 'final', reason: 'model-final', actions: [] }
  }
  if (result.result.stopReason !== 'tool-calls' || calls.length === 0 || calls.some(block => !block.complete || block.argumentsStatus === 'partial')) {
    return { classification: 'failed', reason: 'model-not-actionable', actions: [] }
  }
  const actions: AgentActionIntent[] = calls.map(block => {
    let route: AgentActionIntent['route'] = 'invalid'
    if (advertised.includes(block.name)) {
      if (spec.toolNames.includes(block.name)) route = 'tool'
      else if ((spec.nativeActions as readonly string[]).includes(block.name)) {
        switch (block.name) {
          case 'agent_send_message': route = 'send'; break
          case 'agent_reply_message': route = 'reply'; break
          case 'agent_await_reply': route = 'wait'; break
          case 'agent_ask_user': route = 'ask'; break
          case 'agent_spawn_subagent': if (spec.protocolVersion === 2) route = 'spawn'; break
          case 'agent_await_subagent': if (spec.protocolVersion === 2) route = 'await-subagent'; break
          case 'agent_answer_subagent': if (spec.protocolVersion === 2) route = 'answer-subagent'; break
          case 'agent_ask_parent': if (spec.protocolVersion === 2) route = 'ask-parent'; break
          case 'agent_report_progress': if (spec.protocolVersion === 2) route = 'progress'; break
        }
      }
    }
    return { source: { invocationId: result.invocationId, outputBlockIndex: block.index }, route }
  })
  return { classification: 'actions', reason: actions.length > 1 && actions.some(action => ['wait', 'ask', 'spawn', 'await-subagent', 'answer-subagent', 'ask-parent'].includes(action.route))
    ? 'invalid-control-batch' : 'model-actions', actions }
}
