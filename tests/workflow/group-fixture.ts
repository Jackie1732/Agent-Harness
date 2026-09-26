import { runnableWorkflowHost } from './host-fixture.js'
import { workflowMemberFingerprints } from '../../src/host/workflow-authority.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { parseSessionId } from '../../src/session/ids.js'
import { scriptedModelDescriptor } from '../../src/model/providers/scripted.js'

/** Four independent active assignments; execution concurrency remains one. */
export function groupWorkflowHost(root: string) {
  const base = runnableWorkflowHost(root)
  if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('v3 fixture')
  const entry = base.workflows.definitions[0]!, first = base.members[0]!
  if (first.kind !== 'local' || first.spec.protocolVersion !== 3) throw new Error('local fixture')
  const names = ['writer', 'reviewer', 'reader2', 'reader3'], keys = ['read', 'write', 'note2', 'note3']
  const grant = { models: 2, steps: 2, tools: 0, messages: 3, waits: 1, outputTokens: 512 }
  const members = names.map((agentKey, index) => ({ ...first, agentKey, sessionId: parseSessionId(`70000000-0000-4000-8000-00000000010${index + 1}`),
    profile: { ...first.profile, profileKey: `${agentKey}-generation` },
    model: { ...first.model, providerId: `${agentKey}-provider`, runnerLimits: { ...first.model.runnerLimits, maxToolCalls: 1 } },
    spec: { ...first.spec, target: { ...first.spec.target, provider: scriptedModelDescriptor({ ...first.model, providerId: `${agentKey}-provider` }) },
      budget: grant, workflow: { kind: 'participant' as const, resourceIds: [], toolNames: [],
      nativeActions: ['agent_send_work_group', 'agent_await_work_message'] as const } } }))
  const definition = decodeWorkflowDefinition({ ...entry.definition,
    roster: members.map((member, index) => ({ ...entry.definition.roster[0], memberKey: member.agentKey, address: `ah-session:${member.sessionId}`,
      ...workflowMemberFingerprints(member), budgetCeiling: grant, roles: [names[index]!] })),
    nodes: members.map((member, index) => ({ ...entry.definition.nodes[0], nodeKey: keys[index]!, executor: member.agentKey,
      output: { kind: 'text', name: `result${index}` }, attempts: [{ ...entry.definition.nodes[0]!.attempts[0], workerGrant: grant,
        nativeActions: member.spec.workflow.nativeActions }] })),
    communication: { ask: [], groups: [{ from: 'writer', recipients: names.slice(1) }],
      disclosures: keys.map(nodeKey => ({ nodeKey, recipients: ['coordinator'] })) }, requiredOutputs: keys,
    budget: { models: 8, steps: 8, tools: 0, messages: 12, waits: 4, outputTokens: 2048 },
    limits: { ...entry.definition.limits, maxActiveAssignments: 4, maxGroups: 1, maxGroupRecipients: 3,
      maxIncomingGroupMessages: 1, maxProtocolMessages: 128 } })
  return { ...base, members, communication: { ...base.communication, maxPendingInbox: 64, maxPendingOutbox: 64 },
    routes: members.map(member => ({ ...base.routes[0]!, memberKey: member.agentKey, sessionId: member.sessionId })),
    workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
}
