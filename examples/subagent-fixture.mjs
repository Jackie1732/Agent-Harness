import { readFile } from 'node:fs/promises'
import * as h from '../dist/index.js'

export const clock = { now: () => Date.parse('2026-09-22T00:00:00Z') }
export const grant = { models: 4, steps: 4, tools: 0, messages: 4, waits: 2, outputTokens: 1024 }
export const delegationRequest = () => ({ templateKey: 'research', templateVersion: 1, task: 'Check the supplied evidence.',
  materials: [{ label: 'evidence', text: 'Forty-two is the supplied observation.' }], requestedBudget: grant, workspace: { kind: 'none' } })

/** Shared data fixture for executable examples; Providers are injected separately by each scenario. */
export async function subagentConfig(storage) {
  const raw = JSON.parse(await readFile(new URL('./host-config.json', import.meta.url), 'utf8'))
  const parent = raw.members[0]
  parent.spec = { ...parent.spec, protocolVersion: 2, peers: [], messages: [],
    nativeActions: ['agent_spawn_subagent', 'agent_await_subagent', 'agent_answer_subagent', 'agent_ask_user'],
    budget: { models: 16, steps: 16, tools: 4, messages: 20, waits: 8, outputTokens: 4096 } }
  parent.profile.rendererVersion = 'context-neutral/v3'
  parent.model.runnerLimits.maxToolCalls = 4
  const model = { ...parent.model, providerId: 'child-provider', text: 'Child verified the evidence.' }
  const capabilities = { models: [{ providerId: model.providerId, model: parent.spec.target.model }], tools: [], workspaces: [] }
  const limits = { maxUnresolvedDelegations: 8, maxActiveChildren: 4, maxChildDurationMs: 60000, maxProtocolStepsPerBatch: 8,
    maxRecoveryWrites: 32, maxRequestBytes: 16384, maxMaterialBytes: 4096, maxResultBytes: 16384, maxFileEntries: 8,
    maxProtocolConflicts: 4, maxDiscoveryEntries: 64 }
  const template = h.decodeChildTemplate({ templateKey: 'research', templateVersion: 1, profile: { ...parent.profile, profileKey: 'child-generation' },
    spec: { ...parent.spec, target: { ...parent.spec.target, provider: h.scriptedModelDescriptor(model) }, budget: grant,
      nativeActions: ['agent_ask_parent', 'agent_report_progress'], maxDirectSendCommandsPerSession: 0 },
    model, tools: { kind: 'none' }, capabilities, maxQuestions: 2, maxProgress: 1, limits })
  return { ...raw, schemaVersion: 2, storage: { ...raw.storage, root: storage }, members: [parent], messages: [], channels: [], routes: [raw.routes[0]],
    communication: { ...raw.communication, maxMessageBytes: 65536 }, scheduling: { ...raw.scheduling, maxBatchesPerRun: 512 },
    subagents: { kind: 'enabled', templates: [template], parents: [{ agentKey: parent.agentKey, templates: [{ templateKey: 'research', templateVersion: 1 }],
      capabilities, maxDelegations: 4, maxGrant: grant }], workspaceResources: [], limits } }
}

export async function* action(name, args) {
  yield { kind: 'block-start', index: 0, block: 'tool-call', name, callId: 'example-action' }
  yield { kind: 'arguments-delta', index: 0, text: JSON.stringify(args) }; yield { kind: 'block-end', index: 0 }
  yield { kind: 'complete', stopReason: 'tool-calls' }
}
export async function* final(text) {
  yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text }
  yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
}
export function protocolInput(submission, kind) {
  return submission.request.messages.flatMap(message => message.content.filter(block => block.kind === 'text'))
    .map(block => { try { return JSON.parse(block.text) } catch { return null } }).find(value => value?.kind === kind)?.data
}
