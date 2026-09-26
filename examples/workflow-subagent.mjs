import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h from '../dist/index.js'
import { workflowConfig, resolveWorkflowConfig, configureWorkGrant } from './workflow-fixture.mjs'
import { subagentConfig, delegationRequest, action, final, protocolInput } from './subagent-fixture.mjs'

const root = await mkdtemp(join(tmpdir(), 'workflow-subagent-'))
let host
try {
  const raw = await workflowConfig(root), delegated = await subagentConfig(root)
  const { workspaceResources: _resources, ...subagents } = delegated.subagents
  raw.subagents = subagents
  configureWorkGrant(raw, { models: 8, steps: 8, tools: 0, messages: 12, waits: 6, outputTokens: 2048 },
    ['agent_spawn_subagent', 'agent_await_subagent', 'agent_answer_subagent'])
  raw.members[0].spec.nativeActions = delegated.members[0].spec.nativeActions
  // Only the configured parent can spawn; the other peer remains an independent producer.
  raw.members[1].spec.workflow.nativeActions = []
  raw.workflows.definitions[0].definition.nodes[1].attempts[0].nativeActions = []
  const spec = resolveWorkflowConfig(raw); let parentCalls = 0
  await h.initializeHost(spec)
  host = await h.openHost(spec, { bindings: { createModelProvider: member => new h.ScriptedModelProvider({ ...member.model,
    script: async function* (submission) {
      yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'child-work' }
      if (member.agentKey === 'writer' && parentCalls++ === 0) yield* action('agent_spawn_subagent', delegationRequest())
      else {
        if (member.agentKey === 'writer') assert.equal(protocolInput(submission, 'subagent-result').payload.summary.text, 'Private child evidence.')
        yield* final(member.agentKey.startsWith('child') ? 'Private child evidence.' : 'Integrated result.')
      }
    } }) } })
  await host.workflow('research').resume({ requestKey: 'start' }); await host.run()
  assert.equal(host.workflow('research').report().closed, true)
  assert.equal(host.delegationReport().unresolved, 0)
  console.log(JSON.stringify({ example: 'workflow-subagent', report: host.workflow('research').report() }))
} finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }) }
