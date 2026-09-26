import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeHost, hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import { parseSessionId } from '../../src/session/ids.js'
import { projectWorkflowSession } from '../../src/workflow/projection.js'
import { workflowDecisionCommittedEvent } from '../../src/workflow/coordinator-events.js'
import { WorkflowJournal } from '../../src/workflow/journal.js'
import { runnableWorkflowHost } from './host-fixture.js'
import { workflowMemberFingerprints } from '../../src/host/workflow-authority.js'

it.each(['accept', 'reject', 'invalid', 'question', 'all'] as const)('uses an independent reviewer and settles %s without charging its reserved grant twice', async decision => {
  const root = await mkdtemp(join(tmpdir(), 'work-review-'))
  try {
    const base = runnableWorkflowHost(root)
    if (base.schemaVersion !== 3 || base.workflows.kind !== 'enabled') throw new Error('v3 fixture')
    const entry = base.workflows.definitions[0]!, recipe = entry.definition
    const questions = decision === 'question', accepted = decision === 'accept' || questions || decision === 'all'
    const reviewers = decision === 'all' ? ['reviewer', 'editor'] : ['reviewer']
    const grant = { models: questions ? 2 : 1, steps: questions ? 2 : 1, tools: 0, messages: 0, waits: questions ? 1 : 0, outputTokens: questions ? 512 : 256 }
    const members = base.members.map(member => {
      if (!questions || member.kind !== 'local' || member.agentKey !== 'reviewer') return member
      if (member.spec.protocolVersion !== 3 || member.spec.workflow.kind !== 'participant') throw new Error('participant fixture')
      return { ...member, spec: { ...member.spec, workflow: { ...member.spec.workflow, nativeActions: ['agent_ask_user' as const] } },
        model: { ...member.model, runnerLimits: { ...member.model.runnerLimits, maxToolCalls: 1 } } }
    })
    if (decision === 'all') members.push({ ...members[1]!, agentKey: 'editor', sessionId: '70000000-0000-4000-8000-000000000103' })
    const roster = decision === 'all' ? [...recipe.roster, { ...recipe.roster[1]!, memberKey: 'editor', address: 'ah-session:70000000-0000-4000-8000-000000000103' }] : recipe.roster
    const definition = decodeWorkflowDefinition({ ...recipe, budget: { ...recipe.budget, models: 4 + reviewers.length * grant.models,
      steps: 4 + reviewers.length * grant.steps, waits: grant.waits, outputTokens: 1024 + reviewers.length * grant.outputTokens },
      limits: { ...recipe.limits, maxProtocolMessages: decision === 'all' ? 24 : 18 },
      communication: { ...recipe.communication, disclosures: recipe.communication.disclosures.map(item => item.nodeKey === 'read'
        ? { ...item, recipients: ['coordinator', ...reviewers] } : item) },
      roster: roster.map(item => {
        const member = members.find(member => member.agentKey === item.memberKey)!
        if (member.kind !== 'local') throw new Error('local fixture')
        return { ...item, ...workflowMemberFingerprints(member), budgetCeiling: { ...item.budgetCeiling, waits: grant.waits }, canReview: reviewers.includes(item.memberKey) }
      }),
      nodes: recipe.nodes.map(node => node.nodeKey !== 'read' ? node : { ...node, acceptance: { kind: 'reviewed-all', reviewers },
        attempts: node.attempts.map(attempt => ({ ...attempt, reviewerGrants: reviewers.map(memberKey => ({ memberKey, grant })) })) }) })
    const spec = { ...base, members, routes: decision === 'all' ? [...base.routes, { ...base.routes[1]!, memberKey: 'editor', sessionId: members.at(-1)!.sessionId }] : base.routes,
      workflows: { ...base.workflows, definitions: [{ ...entry, definition }] } }
    await initializeHost(spec)
    let reviews = 0
    const host = await openHost(spec, { bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* (submission): AsyncGenerator<ModelFrame> {
        const review = JSON.stringify(submission.request).includes('Review the exact candidate')
        if (review) {
          reviews++
          expect(reviewers).toContain(member.agentKey)
          expect(JSON.stringify(submission.request)).toContain('accepted upstream')
          expect(submission.request.tools.map(tool => tool.name)).toEqual(questions ? ['agent_ask_user'] : [])
        }
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'review-case' }
        if (questions && review && reviews === 1) {
          yield { kind: 'block-start', index: 0, block: 'tool-call', name: 'agent_ask_user', callId: 'review-question' }
          yield { kind: 'arguments-delta', index: 0, text: '{"question":"Confirm review criteria?","timeoutMs":60000}' }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
          return
        }
        yield { kind: 'block-start', index: 0, block: 'text' }
        yield { kind: 'text-delta', index: 0, text: review
          ? decision === 'invalid' ? '```json\n{"decision":"accept","reason":"fenced"}\n```' : JSON.stringify({ decision: accepted ? 'accept' : 'reject', reason: 'checked exact candidate' })
          : member.agentKey === 'writer' ? '{"text":"accepted upstream"}' : 'final report' }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
      } }) } })
    try {
      await host.workflow('research').resume({ requestKey: 'review' }); await host.run()
      if (questions) {
        const wait = host.report().members.find(member => member.agentKey === 'reviewer')!.agent.waits[0]!
        await host.submitAnswer('reviewer', wait.reference, 'Criteria confirmed')
        await host.run()
      }
      expect(host.workflow('research').report()).toMatchObject({ state: accepted ? 'completed' : 'failed', closed: true,
        counts: { reviews: reviewers.length, accepted: accepted ? 2 : 0, assignments: (accepted ? 2 : 1) + reviewers.length },
        reservedBudget: { models: (accepted ? 4 : 2) + reviewers.length * grant.models, outputTokens: (accepted ? 1024 : 512) + reviewers.length * grant.outputTokens } })
      expect(reviews).toBe(questions ? 2 : reviewers.length)
    } finally { await host.shutdown() }
    const repository = new SessionRepository({ backend: new FileSessionBackend(spec.storage), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      const coordinator = await repository.open(parseSessionId(entry.sessionId))
      const state = projectWorkflowSession(coordinator.snapshot())
      const productionDecision = state.decisions.find(item => item.payload.assignment.eventId === state.assignments[0]!.stored.eventId)!
      expect(productionDecision.payload.reviews).toEqual(state.reviews.map(item => item.payload.message.proposal))
      if (accepted) expect(state.assignments.at(-1)?.payload.sourceAccepted).toEqual([{ address: coordinator.header.address, eventId: productionDecision.stored.eventId }])
      await expect(new WorkflowJournal(coordinator, { now: () => Date.now() }).append(workflowDecisionCommittedEvent, () => productionDecision.payload))
        .rejects.toThrow('decision-source')
    } finally { await repository.dispose() }
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)
