import type { JsonObject } from '../../src/foundation/json.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { workflowMemberFingerprints } from '../../src/host/workflow-authority.js'
import { twoMemberHostConfig } from '../host/fixtures.js'
import { workflowFixture } from './fixtures.js'

export function runnableWorkflowHost(root: string, firstText = '{"text":"accepted upstream"}') {
  const base = twoMemberHostConfig(root)
  const members = (base.members as readonly JsonObject[]).map(member => ({ ...member,
    profile: { ...(member.profile as JsonObject), rendererVersion: 'context-neutral/v4' },
    spec: { ...(member.spec as JsonObject), protocolVersion: 3, workflow: { kind: 'participant', toolNames: [], nativeActions: [], resourceIds: [] } },
    model: { ...(member.model as JsonObject), text: member.agentKey === 'writer' ? firstText : 'final report' },
  }))
  const configured = { ...base, members, schemaVersion: 3, subagents: { kind: 'disabled' }, workspaceResources: [], workflows: { kind: 'disabled' },
    communication: { ...(base.communication as JsonObject), maxMessageBytes: 128 * 1024 },
    scheduling: { ...(base.scheduling as JsonObject), maxBatchesPerRun: 200 } }
  const resolved = resolveHostConfig(decodeHostConfig(configured, root))
  const recipe = workflowFixture()
  const grant = { models: 2, steps: 2, tools: 0, messages: 0, waits: 0, outputTokens: 512 }
  const definition = { ...recipe, roster: resolved.members.map((member, index) => {
    if (member.kind !== 'local') throw new Error('local fixture')
    return { ...recipe.roster[index], memberKey: member.agentKey, address: 'ah-session:' + member.sessionId,
      ...workflowMemberFingerprints(member), budgetCeiling: grant }
  }), nodes: recipe.nodes.map((node, index) => ({ ...node, executor: index === 0 ? 'writer' : 'reviewer',
    attempts: node.attempts.map(attempt => ({ ...attempt, workerGrant: grant })) })),
  communication: { ask: [], groups: [], disclosures: [
    { nodeKey: 'read', recipients: ['coordinator', 'reviewer'] }, { nodeKey: 'write', recipients: ['coordinator'] },
  ] }, budget: { ...grant, models: 4, steps: 4, outputTokens: 1024 },
  limits: { ...recipe.limits, maxProtocolMessages: 12, maxQuestions: 0, maxIncomingQuestions: 0,
    maxGroups: 0, maxGroupRecipients: 0, maxIncomingGroupMessages: 0, maxProgress: 0 } }
  return resolveHostConfig(decodeHostConfig({ ...configured, workflows: { kind: 'enabled', maxBusinessConcurrency: 1,
    definitions: [{ sessionId: '87000000-0000-4000-8000-000000000001', definition }] } }, root))
}
