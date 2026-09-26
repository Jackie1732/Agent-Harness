import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runnableWorkflowHost } from './host-fixture.js'
import { initializeHost } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'

it('requires closed review and production receipts before authorizing a fresh reviewed attempt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-retry-review-'))
  try {
    const base = runnableWorkflowHost(root)
    if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('workflow fixture')
    const entry = base.workflows.definitions[0]!, producer = entry.definition.nodes[0]!
    const reviewerGrant = { models: 1, steps: 1, tools: 0, messages: 0, waits: 0, outputTokens: 256 }
    const attempt = { ...producer.attempts[0], reviewerGrants: [{ memberKey: 'reviewer', grant: reviewerGrant }] }
    const definition = decodeWorkflowDefinition({ ...entry.definition, requiredOutputs: ['read'],
      communication: { ...entry.definition.communication, disclosures: [entry.definition.communication.disclosures[0]] },
      roster: entry.definition.roster.map(member => ({ ...member, canReview: member.memberKey === 'reviewer' })),
      nodes: [{ ...producer, attempts: [attempt, attempt], acceptance: { kind: 'reviewed-all', reviewers: ['reviewer'] } }],
      budget: { ...entry.definition.budget, models: 6, steps: 6, outputTokens: 1536 },
      limits: { ...entry.definition.limits, maxProtocolMessages: 24 } })
    const spec = { ...base, scheduling: { ...base.scheduling, maxBatchesPerRun: 1 },
      workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
    await initializeHost(spec)
    let productions = 0, reviews = 0
    const host = await openHost(spec, { bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* (submission) {
        const production = member.agentKey === 'writer'
        if (production) productions++
        else {
          reviews++
          expect(JSON.stringify(submission.request)).toContain(`candidate ${productions}`)
        }
        yield { kind: 'message-start', responseId: 'review-retry', reportedModel: member.spec.target.model }
        yield { kind: 'block-start', index: 0, block: 'text' }
        yield { kind: 'text-delta', index: 0, text: production ? JSON.stringify({ text: `candidate ${productions}` })
          : JSON.stringify({ decision: reviews === 1 ? 'reject' : 'accept', reason: 'checked frozen candidate' }) }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
      } }) } })
    try {
      const workflow = host.workflow('research')
      await workflow.resume({ requestKey: 'start' })
      for (let batch = 0; batch < 100 && workflow.report().counts.pendingRetries === 0; batch++) await host.run()
      expect(workflow.report().counts.pendingRetries).toBe(1)
      const request = { nodeKey: 'read', failedAssignment: workflow.report().assignments[0]!.ref, requestKey: 'after-review' }
      await expect(workflow.retry(request)).rejects.toThrow('workflow-retry-still-closing')
      for (let batch = 0; batch < 100; batch++) if ((await host.run()).stoppedBy === 'quiescent') break
      expect(productions).toBe(1); expect(reviews).toBe(1)
      await workflow.retry(request)
      expect(productions).toBe(1)
      for (let batch = 0; batch < 100 && !workflow.report().closed; batch++) await host.run()
      expect(workflow.report()).toMatchObject({ state: 'completed', closed: true, counts: { assignments: 4, reviews: 2, accepted: 1 },
        reservedBudget: { models: 6, outputTokens: 1536 } })
      expect(productions).toBe(2); expect(reviews).toBe(2)
      expect(workflow.report().assignments.map(item => item.attempt)).toEqual([1, 1, 2, 2])
    } finally { await host.shutdown() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 60000)
