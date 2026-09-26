import { expect, it } from 'vitest'
import { decodeSubagentAgentSpec, decodeWorkflowAgentSpec } from '../../src/agent/spec-codec.js'
import { agentFixture } from './fixtures.js'

it('decodes separate v3 ordinary and Workflow capability ceilings', async () => {
  const fixture = await agentFixture()
  try {
    const candidate = { ...fixture.spec, protocolVersion: 3, subagents: { role: 'none' }, workflow: {
      kind: 'participant', toolNames: ['read_text', 'write_text'],
      nativeActions: ['agent_ask_user', 'agent_ask_work_peer', 'agent_report_work_progress'], resourceIds: ['workspace'],
    } }
    const decoded = decodeWorkflowAgentSpec(candidate)
    expect(decoded.toolNames).toEqual([])
    expect(decoded.workflow).toEqual(candidate.workflow)
    expect(decodeSubagentAgentSpec({ ...fixture.spec, protocolVersion: 2, subagents: { role: 'none' },
      toolNames: ['agent_ask_work_peer'] }).toolNames).toEqual(['agent_ask_work_peer'])
    for (const name of ['agent_spawn_subagent', 'agent_await_subagent', 'agent_answer_subagent']) {
      expect(() => decodeWorkflowAgentSpec({ ...candidate, workflow: { ...candidate.workflow,
        nativeActions: [...candidate.workflow.nativeActions, name] } })).toThrow('invalid-agent-spec')
    }
    expect(() => decodeWorkflowAgentSpec({ ...candidate, workflow: { ...candidate.workflow,
      toolNames: ['agent_ask_work_peer'] } })).toThrow('invalid-agent-spec')
    expect(() => decodeWorkflowAgentSpec({ ...candidate, workflow: { ...candidate.workflow,
      resourceIds: ['workspace', 'workspace'] } })).toThrow('invalid-agent-spec')
  } finally { await fixture.close() }
})
