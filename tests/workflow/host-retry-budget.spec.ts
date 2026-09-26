import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runnableWorkflowHost } from './host-fixture.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { initializeHost } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'

it('reserves the remaining retry grant before dispatch and prevents competing operator requests from overspending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-retry-budget-'))
  try {
    const base = runnableWorkflowHost(root)
    if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('workflow fixture')
    const entry = base.workflows.definitions[0]!, producer = entry.definition.nodes[0]!
    const first = producer.attempts[0]!
    const definition = decodeWorkflowDefinition({ ...entry.definition,
      nodes: entry.definition.nodes.map(node => ({ ...node, dependencies: [], inputs: [], inputSchema: producer.inputSchema,
        output: producer.output, attempts: [first, { ...first, workerGrant: { ...first.workerGrant, models: 1, steps: 1, outputTokens: 256 } }] })),
      budget: { ...entry.definition.budget, models: 5, steps: 5, outputTokens: 1280 },
      limits: { ...entry.definition.limits, maxProtocolMessages: 24 } })
    const spec = { ...base, members: base.members.map(member => {
      if (member.kind !== 'local') throw new Error('local fixture')
      return { ...member, model: { ...member.model, text: 'invalid JSON' } }
    }),
      workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
    await initializeHost(spec)
    const host = await openHost(spec)
    try {
      const workflow = host.workflow('research')
      await workflow.resume({ requestKey: 'start' }); await host.run()
      expect(workflow.report()).toMatchObject({ counts: { assignments: 2, pendingRetries: 2 }, reservedBudget: { models: 4 } })
      const [firstFailed, secondFailed] = workflow.report().assignments
      await workflow.retry({ nodeKey: firstFailed!.nodeKey, failedAssignment: firstFailed!.ref, requestKey: 'reserve-first' })
      await expect(workflow.retry({ nodeKey: secondFailed!.nodeKey, failedAssignment: secondFailed!.ref, requestKey: 'reserve-second' }))
        .rejects.toThrow('workflow-retry-budget')
      expect(workflow.report()).toMatchObject({ counts: { assignments: 2 }, reservedBudget: { models: 4 } })
      await workflow.cancel({ requestKey: 'cancel-before-dispatch' }); await host.run()
      expect(workflow.report()).toMatchObject({ state: 'cancelled', closed: true, counts: { assignments: 2, pendingRetries: 0 },
        reservedBudget: { models: 4, steps: 4, outputTokens: 1024 } })
    } finally { await host.shutdown() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60000)
