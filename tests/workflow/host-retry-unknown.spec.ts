import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runnableWorkflowHost } from './host-fixture.js'
import { initializeHost } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'

it('retains an unknown release and rejects retry without acquiring another execution generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-retry-unknown-'))
  try {
    const base = runnableWorkflowHost(root)
    if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('workflow fixture')
    const entry = base.workflows.definitions[0]!
    const definition = decodeWorkflowDefinition({ ...entry.definition,
      limits: { ...entry.definition.limits, maxProtocolMessages: 18 },
      budget: { ...entry.definition.budget, models: 6, steps: 6, outputTokens: 1536 },
      nodes: entry.definition.nodes.map(node => node.nodeKey !== 'read' ? node : { ...node, attempts: [node.attempts[0], node.attempts[0]] }) })
    const spec = { ...base, workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
    await initializeHost(spec)
    let created = 0, calls = 0
    const host = await openHost(spec, { bindings: { createModelProvider: member => {
      created++
      return new ScriptedModelProvider({ ...member.model, script: async function* () {
        calls++
        yield { kind: 'message-start', responseId: 'unknown-release', reportedModel: member.spec.target.model }
        yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text: '{"text":"candidate"}' }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
      }, onClose: () => { throw new Error('controlled model cleanup failure') } })
    } } })
    try {
      const workflow = host.workflow('research')
      await workflow.resume({ requestKey: 'start' })
      await expect(host.run()).rejects.toThrow()
      const before = created
      await host.run()
      expect(workflow.report()).toMatchObject({ state: 'failed', closed: false, counts: { assignments: 1, retries: 0, accepted: 0 } })
      expect(host.report().members.find(member => member.agentKey === 'writer')!.agent.roots[0]?.outcome).toBe('result-unknown')
      await expect(workflow.retry({ nodeKey: 'read', failedAssignment: workflow.report().assignments[0]!.ref, requestKey: 'unsafe-retry' }))
        .rejects.toThrow('workflow-retry-unavailable')
      expect(created).toBe(before); expect(calls).toBe(1)
    } finally { await expect(host.shutdown()).rejects.toMatchObject({ code: 'HOST_CLEANUP_FAILED' }) }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)
