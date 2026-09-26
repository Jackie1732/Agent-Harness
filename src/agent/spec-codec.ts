import { parseChannelId } from '../communication/ids.js'
import { decodeProviderDescriptor } from '../model/submission.js'
import { snapshotModelRequest } from '../model/request.js'
import { parseSessionAddress } from '../session/ids.js'
import type { AgentLimits, AgentSpec, AgentSpecV1, AgentSpecV2, AgentSpecV3, ChildAgentSpecTemplate } from './contract.js'
import { agentNativeActionNames, subagentNativeActionNames, workflowNativeActionNames } from './contract.js'
import { decodeAgentSubagentRole } from '../subagent/role-codec.js'
import { decodeAgentBudget } from './budget.js'
import { AgentError } from './errors.js'
import { agentJson, array, choice, eventId, exact, flag, integer, record, text, unique } from './validation.js'

export const agentLimitFields = [
  'maxTurnsPerRun', 'maxManagementPerRun', 'maxDispatchRunsPerRun', 'maxJournalConflicts', 'maxReassemblies',
  'maxPendingInputs', 'maxPendingWaits', 'maxLanes', 'maxInputBytes', 'maxActionsPerStep', 'maxActionBytes',
  'maxResultBytes', 'maxReportEntries', 'maxWaitMs',
] as const

export function decodeAgentLimits(value: unknown): AgentLimits {
  const input = record(value); exact(input, agentLimitFields)
  for (const field of agentLimitFields) integer(input[field])
  for (const field of ['maxTurnsPerRun', 'maxManagementPerRun', 'maxLanes', 'maxInputBytes', 'maxActionBytes', 'maxResultBytes', 'maxWaitMs']) integer(input[field], 1)
  for (const field of ['maxInputBytes', 'maxActionBytes', 'maxResultBytes']) integer(input[field], 1, 1024 * 1024)
  integer(input.maxActionsPerStep, 0, 64)
  return input as AgentLimits
}

function names(value: unknown): readonly string[] {
  const result = array(value, 64).map(item => text(item, 64))
  unique(result)
  return result
}

/** Parse a complete configuration without consulting a registry, clock or provider. */
export function decodeAgentSpec(value: unknown): AgentSpecV1 {
  return decodeSpec(value, 1) as AgentSpecV1
}

/** New Sessions opt into v2 explicitly; old specs never gain delegation by reopening. */
export function decodeSubagentAgentSpec(value: unknown): AgentSpecV2 {
  return decodeSpec(value, 2) as AgentSpecV2
}

/** Version 3 fixes separate ordinary and Workflow capability selections. */
export function decodeWorkflowAgentSpec(value: unknown): AgentSpecV3 {
  return decodeSpec(value, 3) as AgentSpecV3
}

/** Installation-local references are bound only after their actual predecessor commits. */
export function decodeChildAgentSpecTemplate(value: unknown): ChildAgentSpecTemplate {
  return decodeSpec(value, 2, true) as ChildAgentSpecTemplate
}

function decodeSpec(value: unknown, version: 1 | 2 | 3, childTemplate = false): AgentSpec | AgentSpecV3 | ChildAgentSpecTemplate {
  try {
    const input = record(agentJson(value))
    exact(input, ['protocolVersion', 'label', 'responsibility', 'nonGoals', ...(!childTemplate ? ['profileEventId'] : []), 'target', 'toolNames',
      'nativeActions', 'peers', 'messages', 'context', 'budget', 'rootDurationMs', 'maxDirectSendCommandsPerSession',
      'limits', 'errorFeedback', 'usagePolicy', 'businessRefusalHandled', ...(version !== 1 && !childTemplate ? ['subagents'] : []),
      ...(version === 3 ? ['workflow'] : [])])
    integer(input.protocolVersion, version, version); text(input.label, 128); text(input.responsibility, 8192)
    array(input.nonGoals, 64).forEach(item => text(item, 1024))
    if (!childTemplate) eventId(input.profileEventId)
    const target = record(input.target)
    const allowed = ['model', 'maxOutputTokens', 'provider', 'temperature', 'topP', 'profile']
    if (Object.keys(target).some(key => !allowed.includes(key))) throw new Error('target-fields')
    decodeProviderDescriptor(record(target.provider))
    const { provider: _provider, ...controls } = target
    snapshotModelRequest({ ...controls, instructions: [], messages: [{ role: 'user', content: [{ kind: 'text', text: 'validate' }] }], tools: [] })
    const tools = names(input.toolNames)
    const reservedNames: readonly string[] = [...agentNativeActionNames, ...subagentNativeActionNames,
      ...(version === 3 ? workflowNativeActionNames : [])]
    if (tools.some(name => !/^[A-Za-z0-9_-]+$/.test(name) || (version === 1 ? agentNativeActionNames as readonly string[] : reservedNames).includes(name))) throw new Error('tool-name')
    const actions = names(input.nativeActions)
    actions.forEach(name => choice(name, version === 1 ? agentNativeActionNames : reservedNames))
    const peers = array(input.peers, 1000).map(item => {
      const peer = record(item); exact(peer, ['key', 'address', 'channelId'])
      text(peer.key, 128); parseSessionAddress(text(peer.address)); parseChannelId(text(peer.channelId))
      return text(peer.key)
    })
    unique(peers)
    const messages = array(input.messages, 256).map(item => {
      const message = record(item); exact(message, ['type', 'payloadVersion', 'requiresReply'])
      text(message.type, 128); integer(message.payloadVersion, 1); flag(message.requiresReply)
      return `${message.type}:${message.payloadVersion}`
    })
    unique(messages)
    const context = record(input.context); exact(context, ['history', 'memory', 'compactions'])
    const history = record(context.history); exact(history, ['mode', 'maxRoots'])
    choice(history.mode, ['none', 'completed-roots']); integer(history.maxRoots, 0, 10000)
    if (history.mode === 'none' && history.maxRoots !== 0) throw new Error('history-none-limit')
    unique(array(context.compactions).map(eventId))
    const memory = record(context.memory); exact(memory, ['required', 'query'])
    const required = array(memory.required).map(item => {
      const reference = record(item); exact(reference, ['eventId', 'selector'])
      choice(reference.selector, ['memory']); return eventId(reference.eventId)
    })
    unique(required)
    const query = record(memory.query); exact(query, ['requiredTags', 'queryTags', 'topK'])
    for (const key of ['requiredTags', 'queryTags']) {
      const tags = names(query[key]); if (tags.some(tag => !/^[a-z0-9][a-z0-9_-]*$/.test(tag))) throw new Error('tags')
    }
    integer(query.topK, 0, 10000)
    decodeAgentBudget(input.budget); decodeAgentLimits(input.limits)
    integer(input.rootDurationMs, 1, 31_536_000_000); integer(input.maxDirectSendCommandsPerSession)
    choice(input.errorFeedback, ['new-step', 'stop']); choice(input.usagePolicy, ['observe-only', 'stop-on-unknown'])
    flag(input.businessRefusalHandled)
    if (childTemplate) {
      if (peers.length !== 0 || actions.some(name => name !== 'agent_ask_parent' && name !== 'agent_report_progress')) throw new Error('child-template-authority')
    } else if (version !== 1) {
      const role = decodeAgentSubagentRole(input.subagents)
      const parentActions: readonly string[] = ['agent_spawn_subagent', 'agent_await_subagent', 'agent_answer_subagent']
      const childActions: readonly string[] = ['agent_ask_parent', 'agent_report_progress']
      if (actions.some(name => parentActions.includes(name) && role.role !== 'parent'
        || childActions.includes(name) && role.role !== 'child')) throw new Error('role-action')
      if (role.role === 'child' && (peers.length !== 0 || actions.some(name => agentNativeActionNames.includes(name as typeof agentNativeActionNames[number])))) throw new Error('child-direct-action')
    }
    if (version === 3) {
      const workflow = record(input.workflow)
      if (workflow.kind === 'disabled') exact(workflow, ['kind'])
      else {
        exact(workflow, ['kind', 'toolNames', 'nativeActions', 'resourceIds'])
        choice(workflow.kind, ['participant'])
        const workTools = names(workflow.toolNames)
        if (workTools.some(name => !/^[A-Za-z0-9_-]+$/.test(name) || reservedNames.includes(name))) throw new Error('workflow-tool-name')
        const workActions = names(workflow.nativeActions)
        workActions.forEach(name => choice(name, [...workflowNativeActionNames, 'agent_ask_user', 'agent_spawn_subagent']))
        if (names(workflow.resourceIds).some(name => !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name))) throw new Error('workflow-resource-id')
        const role = decodeAgentSubagentRole(input.subagents).role
        if (role === 'child' || workActions.includes('agent_spawn_subagent') && role !== 'parent') throw new Error('workflow-subagent-role')
      }
    }
    return input as AgentSpec | AgentSpecV3
  } catch { throw new AgentError('AGENT_SPEC_INVALID', 'invalid-agent-spec') }
}
