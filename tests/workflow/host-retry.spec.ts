import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runnableWorkflowHost } from './host-fixture.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { initializeHost, hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import { SessionRepository } from '../../src/session/repository.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { parseSessionId } from '../../src/session/ids.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { projectWorkflowSession } from '../../src/workflow/projection.js'

it.each(['retry', 'expired', 'exhausted', 'cancel', 'failed-again'] as const)('bounds the %s decision and preserves original attempt budgets', async scenario => {
  const root = await mkdtemp(join(tmpdir(), 'workflow-retry-'))
  try {
    const base = runnableWorkflowHost(root)
    if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('workflow fixture')
    const entry = base.workflows.definitions[0]!
    const definition = decodeWorkflowDefinition({ ...entry.definition,
      limits: { ...entry.definition.limits, maxProtocolMessages: 18 },
      budget: { ...entry.definition.budget, models: scenario === 'exhausted' ? 2 : 5, steps: 5, outputTokens: 1280 },
      nodes: entry.definition.nodes.map(node => node.nodeKey !== 'read' ? node : { ...node,
        attempts: [node.attempts[0], { ...node.attempts[0], workerGrant: { ...node.attempts[0]!.workerGrant, models: 1, steps: 1, outputTokens: 256 } }] }) })
    const spec = { ...base, workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
    let tick = Date.now(), producerCalls = 0, downstreamCalls = 0
    const clock = { now: () => tick }
    const bindings = { createModelProvider: (member: typeof base.members[number]) => {
      if (member.kind !== 'local') throw new Error('local fixture')
      return new ScriptedModelProvider({ ...member.model, script: async function* (submission) {
        let text: string
        if (member.agentKey === 'writer') {
          producerCalls++
          text = producerCalls === 1 || scenario === 'failed-again' ? 'invalid JSON' : '{"text":"second attempt evidence"}'
        } else {
          downstreamCalls++
          expect(JSON.stringify(submission.request)).toContain('second attempt evidence')
          text = 'accepted final report'
        }
        yield { kind: 'message-start', responseId: 'attempt', reportedModel: member.spec.target.model }
        yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
      } })
    } }
    await initializeHost(spec)
    let host = await openHost(spec, { clock, bindings })
    try {
      await host.workflow('research').resume({ requestKey: 'start' }); await host.run()
      let workflow = host.workflow('research')
      const failed = workflow.report().assignments[0]!.ref
      const request = { nodeKey: 'read', failedAssignment: failed, requestKey: 'retry-one' }
      expect(producerCalls).toBe(1); expect(downstreamCalls).toBe(0)
      if (scenario === 'exhausted') {
        expect(workflow.report()).toMatchObject({ state: 'failed', closed: true })
        await expect(workflow.retry(request)).rejects.toThrow('workflow-retry-unavailable')
      } else {
        expect(workflow.report()).toMatchObject({ state: 'retry-awaiting-decision', settled: false, counts: { assignments: 1, pendingRetries: 1 } })
        const deadline = workflow.report().retries[0]!.deadline
        await host.shutdown({ mode: 'drain' })
        host = await openHost(spec, { clock, bindings }); workflow = host.workflow('research')
        expect(workflow.report()).toMatchObject({ state: 'suspended', retries: [{ deadline }] })
        await host.run(); expect(producerCalls).toBe(1)
        if (scenario === 'expired') {
          tick = Date.parse(deadline)
          await expect(workflow.retry(request)).rejects.toThrow('workflow-retry-expired')
          await host.run()
          expect(workflow.report()).toMatchObject({ state: 'failed', closed: true, counts: { assignments: 1 } })
        } else if (scenario === 'cancel') {
          await workflow.cancel({ requestKey: 'cancel-retry' }); await host.run()
          expect(workflow.report()).toMatchObject({ state: 'cancelled', closed: true, counts: { pendingRetries: 0 } })
          await expect(workflow.retry(request)).rejects.toThrow('workflow-retry-unavailable')
        } else {
          const receipt = await workflow.retry(request)
          expect(await workflow.retry(request)).toEqual(receipt)
          await expect(workflow.retry({ ...request, nodeKey: 'write' })).rejects.toThrow('workflow-request-key-conflict')
          await host.run(); expect(producerCalls).toBe(1)
          await workflow.resume({ requestKey: 'resume-retry' }); await host.run()
          const completed = scenario === 'retry'
          expect(workflow.report()).toMatchObject({ state: completed ? 'completed' : 'failed', closed: true,
            counts: { assignments: completed ? 3 : 2, accepted: completed ? 2 : 0, pendingRetries: 0 },
            reservedBudget: { models: completed ? 5 : 3, steps: completed ? 5 : 3, outputTokens: completed ? 1280 : 768 } })
          expect(await workflow.retry(request)).toEqual(receipt)
          await expect(workflow.retry({ ...request, requestKey: 'another' })).rejects.toThrow('workflow-retry-unavailable')
          expect(producerCalls).toBe(2); expect(downstreamCalls).toBe(completed ? 1 : 0)
        }
      }
    } finally { await host.shutdown() }
    const repository = new SessionRepository({ backend: new FileSessionBackend(spec.storage), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      const producer = projectAgentSession((await repository.open(parseSessionId(spec.members[0]!.sessionId))).snapshot())
      expect(producer.roots).toHaveLength(producerCalls)
      expect(producer.roots.map(root => root.limit.models)).toEqual(producerCalls === 2 ? [2, 1] : [2])
      expect(new Set(producer.roots.map(root => root.id)).size).toBe(producerCalls)
      const coordinator = projectWorkflowSession((await repository.open(parseSessionId(entry.sessionId))).snapshot())
      expect(coordinator.assignments.filter(item => item.payload.kind === 'production' && item.payload.nodeKey === 'read').map(item => item.payload.attempt))
        .toEqual(producerCalls === 2 ? [1, 2] : [1])
      if (scenario === 'retry') {
        const accepted = coordinator.decisions.find(item => item.payload.assignment.eventId === coordinator.assignments[1]!.stored.eventId)!
        expect(coordinator.assignments[2]!.payload.sourceAccepted).toEqual([{ address: definition.coordinator, eventId: accepted.stored.eventId }])
      }
    } finally { await repository.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)
