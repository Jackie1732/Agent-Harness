import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h from '../dist/index.js'
import { workflowConfig, resolveWorkflowConfig } from './workflow-fixture.mjs'
import { final } from './subagent-fixture.mjs'

const root = await mkdtemp(join(tmpdir(), 'workflow-reviewed-'))
let host
try {
  const raw = await workflowConfig(root), definition = raw.workflows.definitions[0].definition
  definition.nodes = [definition.nodes[0]]; definition.requiredOutputs = ['writer']
  definition.communication.disclosures = [{ nodeKey: 'writer', recipients: ['coordinator', 'reviewer'] }]
  definition.roster[1].canReview = true
  const node = definition.nodes[0], grant = { models: 1, steps: 1, tools: 0, messages: 0, waits: 0, outputTokens: 256 }
  node.acceptance = { kind: 'reviewed-all', reviewers: ['reviewer'] }
  node.attempts[0].reviewerGrants = [{ memberKey: 'reviewer', grant }]
  node.attempts.push(structuredClone(node.attempts[0]))
  definition.budget = { ...definition.budget, models: 6, steps: 6, outputTokens: 1536 }
  definition.limits.maxProtocolMessages = 24
  const spec = resolveWorkflowConfig(raw); let reviews = 0
  await h.initializeHost(spec)
  host = await h.openHost(spec, { bindings: { createModelProvider: member => new h.ScriptedModelProvider({ ...member.model,
    script: async function* () {
      yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'review' }
      yield* final(member.agentKey === 'writer' ? 'Bounded research evidence.'
        : JSON.stringify({ decision: ++reviews === 1 ? 'reject' : 'accept', reason: 'checked exact candidate' }))
    } }) } })
  const workflow = host.workflow('research')
  await workflow.resume({ requestKey: 'start' }); await host.run()
  assert.equal(workflow.report().state, 'retry-awaiting-decision')
  await workflow.retry({ requestKey: 'revise-once', nodeKey: 'writer', failedAssignment: workflow.report().assignments[0].ref })
  await host.run()
  assert.equal(workflow.report().closed, true); assert.equal(reviews, 2)
  console.log(JSON.stringify({ example: 'workflow-review-retry', report: workflow.report() }))
} finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }) }
