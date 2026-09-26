import { subagentHostConfig } from '../host/subagent-fixture.js'
import { runnableWorkflowHost } from './host-fixture.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { workflowMemberFingerprints } from '../../src/host/workflow-authority.js'

/** A Workflow producer delegates within its own allowance; its Child has no workspace authority. */
export async function delegatedWorkflowHost(root: string) {
  const base = runnableWorkflowHost(root)
  const childBase = resolveHostConfig(decodeHostConfig(await subagentHostConfig(root), root))
  if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled' || childBase.schemaVersion !== 2 || childBase.subagents.kind !== 'enabled') throw new Error('workflow fixture')
  const parent = childBase.members[0]!
  if (parent.kind !== 'local' || parent.spec.protocolVersion !== 2) throw new Error('parent fixture')
  const parentRole = parent.spec.subagents
  const { workspaceResources: _resources, ...subagents } = childBase.subagents
  const actions = ['agent_spawn_subagent', 'agent_await_subagent', 'agent_answer_subagent', 'agent_ask_user'] as const
  const grant = { models: 8, steps: 8, tools: 0, messages: 12, waits: 6, outputTokens: 2048 }
  const members = base.members.map(member => {
    if (member.kind !== 'local' || member.spec.protocolVersion !== 3) throw new Error('local fixture')
    return { ...member, model: { ...member.model, runnerLimits: { ...member.model.runnerLimits, maxToolCalls: 1 } },
      spec: { ...member.spec, budget: grant, subagents: member.agentKey === 'writer' ? parentRole : member.spec.subagents,
        workflow: { kind: 'participant' as const, toolNames: [], resourceIds: [], nativeActions: member.agentKey === 'writer' ? actions : ['agent_ask_user'] as const } } }
  })
  const entry = base.workflows.definitions[0]!
  const definition = decodeWorkflowDefinition({ ...entry.definition,
    budget: { ...grant, models: 16, steps: 16, messages: 24, waits: 12, outputTokens: 4096 },
    roster: entry.definition.roster.map((member, index) => ({ ...member, ...workflowMemberFingerprints(members[index]!), budgetCeiling: grant })),
    nodes: entry.definition.nodes.map(node => ({ ...node, attempts: node.attempts.map(attempt => ({ ...attempt,
      workerGrant: grant, nativeActions: members.find(member => member.agentKey === node.executor)!.spec.workflow.nativeActions })) })) })
  return { ...base, members, subagents, workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
}
