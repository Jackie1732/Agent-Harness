import type { ResolvedHostSpec } from '../../src/host/config.js'
import { workflowMemberFingerprints } from '../../src/host/workflow-authority.js'
import { decodeHostWorkflowTools } from '../../src/host/workflow-tools.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { runnableWorkflowHost } from './host-fixture.js'

export function workspaceWorkflowHost(storage: string, workspace: string, decision: 'allow' | 'deny' = 'allow'): ResolvedHostSpec {
  const base = runnableWorkflowHost(storage)
  if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('v3 fixture')
  const schemaLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
  const workflowTools = decodeHostWorkflowTools({ kind: 'workspace', resourceIds: ['files'], read: true, write: true,
    maxReadBytes: 4096, maxWriteBytes: 4096, maxBaselineFiles: 8, maxBaselineBytes: 8192,
    maxPathBytes: 1024, maxArgumentsBytes: 8192, maxResultBytes: 8192, schemaLimits,
    policy: { policyId: 'work-files', version: 1, decision, reasonCode: 'test-policy' },
    invocationLimits: { ...schemaLimits, maxRequestBytes: 65536, maxPlanBytes: 65536, maxArgumentsBytes: 8192,
      maxJsonDepth: 24, maxJsonNodes: 10000, maxResultBytes: 8192, maxJournalConflicts: 4 } })
  const members = base.members.map(member => {
    if (member.kind !== 'local' || member.agentKey !== 'writer') return member
    if (member.spec.protocolVersion !== 3) throw new Error('v3 member fixture')
    return { ...member, workflowTools, spec: { ...member.spec, protocolVersion: 3 as const,
      workflow: { kind: 'participant' as const, toolNames: ['write_text'], nativeActions: [], resourceIds: ['files'] },
      budget: { ...member.spec.budget, tools: 1 } },
    model: { ...member.model, runnerLimits: { ...member.model.runnerLimits, maxToolCalls: 1 } } }
  })
  const entry = base.workflows.definitions[0]!
  const recipe = entry.definition
  const definition = decodeWorkflowDefinition({ ...recipe, budget: { ...recipe.budget, tools: 1 },
    roster: recipe.roster.map(item => {
      const member = members.find(member => member.agentKey === item.memberKey)!
      if (member.kind !== 'local') throw new Error('local fixture')
      return { ...item, ...workflowMemberFingerprints(member), resourceIds: item.memberKey === 'writer' ? ['files'] : [],
        budgetCeiling: { ...item.budgetCeiling, tools: item.memberKey === 'writer' ? 1 : 0 } }
    }),
    nodes: recipe.nodes.map(node => node.nodeKey !== 'read' ? node : { ...node,
      output: { kind: 'json', schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        artifacts: [{ name: 'written', source: { kind: 'write-text', path: 'out/attempt-1/result.txt' } }] },
      attempts: node.attempts.map(attempt => ({ ...attempt, workerGrant: { ...attempt.workerGrant, tools: 1 }, toolNames: ['write_text'],
        workspace: { kind: 'exclusive-write', resourceId: 'files', readFiles: ['in/source.txt'], writePrefixes: ['out/attempt-1'] } })) }),
  })
  return { ...base, members, workspaceResources: [{ resourceId: 'files', rootPath: workspace, mode: 'exclusive-write', protectedRoots: [],
    readPrefixes: ['in'], writePrefixes: ['out'], maxBaselineFiles: 8, maxBaselineBytes: 8192 }],
  workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
}
