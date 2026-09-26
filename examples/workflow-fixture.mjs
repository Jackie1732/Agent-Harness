import { readFile } from 'node:fs/promises'
import * as h from '../dist/index.js'

/** File-backed peers with two independent text outputs and explicit finite work grants. */
export async function workflowConfig(root) {
  const raw = JSON.parse(await readFile(new URL('./host-config.json', import.meta.url), 'utf8'))
  raw.schemaVersion = 3
  raw.storage.root = root
  raw.subagents = { kind: 'disabled' }
  raw.workspaceResources = []
  raw.communication.maxMessageBytes = 128 * 1024
  raw.scheduling.maxBatchesPerRun = 200
  for (const member of raw.members) {
    member.profile.rendererVersion = 'context-neutral/v4'
    member.spec.protocolVersion = 3
    member.spec.workflow = { kind: 'participant', toolNames: [], nativeActions: [], resourceIds: [] }
    member.workflowTools = { kind: 'none' }
  }
  const grant = { models: 2, steps: 2, tools: 0, messages: 0, waits: 0, outputTokens: 512 }
  const definition = {
    version: 1, workflowKey: 'research', coordinator: 'ah-session:87000000-0000-4000-8000-000000000001',
    roster: raw.members.map(member => ({ memberKey: member.agentKey, address: 'ah-session:' + member.sessionId,
      roles: ['researcher'], canProduce: true, canReview: false, resourceIds: [], budgetCeiling: grant,
      specFingerprint: '', contextFingerprint: '' })),
    nodes: raw.members.map(member => ({ nodeKey: member.agentKey, executor: member.agentKey,
      task: 'Produce evidence for ' + member.agentKey, dependencies: [], inputs: [],
      inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
      guard: { kind: 'always' }, output: { kind: 'text', name: member.agentKey }, acceptance: { kind: 'schema-only' },
      attempts: [{ workerGrant: grant, reviewerGrants: [], durationMs: 60000, retryDecisionMs: 60000,
        toolNames: [], nativeActions: [], workspace: { kind: 'none' } }] })),
    communication: { ask: [], groups: [], disclosures: raw.members.map(member => ({ nodeKey: member.agentKey, recipients: ['coordinator'] })) },
    requiredOutputs: raw.members.map(member => member.agentKey), deadline: '2030-01-01T00:00:00.000Z',
    budget: { ...grant, models: 4, steps: 4, outputTokens: 1024 }, failurePolicy: 'fail-fast',
    limits: { ...h.DEFAULT_WORKFLOW_LIMITS, maxProtocolMessages: 12, maxQuestions: 0, maxIncomingQuestions: 0,
      maxGroups: 0, maxGroupRecipients: 0, maxIncomingGroupMessages: 0, maxProgress: 0 },
  }
  raw.workflows = { kind: 'enabled', maxBusinessConcurrency: 1,
    definitions: [{ sessionId: '87000000-0000-4000-8000-000000000001', definition }] }
  return raw
}

/** Bind each roster entry to its final resolved local Spec and Context profile. */
export function resolveWorkflowConfig(raw) {
  const peers = h.resolveHostConfig(h.decodeHostConfig({ ...raw, workflows: { kind: 'disabled' } }, raw.storage.root))
  for (const entry of raw.workflows.definitions) for (const peer of entry.definition.roster) {
    Object.assign(peer, h.workflowMemberFingerprints(peers.members.find(member => member.agentKey === peer.memberKey)))
  }
  return h.resolveHostConfig(h.decodeHostConfig(raw, raw.storage.root))
}
