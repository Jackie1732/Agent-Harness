import { parseChannelId } from '../communication/ids.js'
import { decodeProviderDescriptor } from '../model/submission.js'
import { snapshotModelRequest } from '../model/request.js'
import { parseSessionAddress } from '../session/ids.js'
import type { AgentLimits, AgentSpec } from './contract.js'
import { agentNativeActionNames } from './contract.js'
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
  for (const field of ['maxTurnsPerRun', 'maxManagementPerRun', 'maxLanes', 'maxInputBytes', 'maxActionBytes', 'maxResultBytes', 'maxReportEntries', 'maxWaitMs']) integer(input[field], 1)
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
export function decodeAgentSpec(value: unknown): AgentSpec {
  try {
    const input = record(agentJson(value))
    exact(input, ['protocolVersion', 'label', 'responsibility', 'nonGoals', 'profileEventId', 'target', 'toolNames',
      'nativeActions', 'peers', 'messages', 'context', 'budget', 'rootDurationMs', 'maxDirectSendCommandsPerSession',
      'limits', 'errorFeedback', 'usagePolicy', 'businessRefusalHandled'])
    integer(input.protocolVersion, 1, 1); text(input.label, 128); text(input.responsibility, 8192)
    array(input.nonGoals, 64).forEach(item => text(item, 1024)); eventId(input.profileEventId)
    const target = record(input.target)
    const allowed = ['model', 'maxOutputTokens', 'provider', 'temperature', 'topP', 'profile']
    if (Object.keys(target).some(key => !allowed.includes(key))) throw new Error('target-fields')
    decodeProviderDescriptor(record(target.provider))
    const { provider: _provider, ...controls } = target
    snapshotModelRequest({ ...controls, instructions: [], messages: [{ role: 'user', content: [{ kind: 'text', text: 'validate' }] }], tools: [] })
    const tools = names(input.toolNames)
    if (tools.some(name => !/^[A-Za-z0-9_-]+$/.test(name) || (agentNativeActionNames as readonly string[]).includes(name))) throw new Error('tool-name')
    const actions = names(input.nativeActions)
    actions.forEach(name => choice(name, agentNativeActionNames))
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
    return input as AgentSpec
  } catch { throw new AgentError('AGENT_SPEC_INVALID', 'invalid-agent-spec') }
}
