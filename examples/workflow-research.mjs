import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h from '../dist/index.js'
import { workflowConfig, resolveWorkflowConfig } from './workflow-fixture.mjs'

// The same four independent peers and frozen DAG run with either one or two business slots.
for (const concurrency of [1, 2]) {
  const root = await mkdtemp(join(tmpdir(), 'workflow-research-'))
  let host
  try {
    const raw = await workflowConfig(root), definition = raw.workflows.definitions[0].definition
    const grant = { models: 1, steps: 1, tools: 0, messages: 0, waits: 0, outputTokens: 256 }
    const names = ['writer', 'reviewer', 'synthesis', 'critic']
    raw.members = names.map((agentKey, index) => {
      const member = structuredClone(raw.members[0])
      member.agentKey = agentKey; member.sessionId = '70000000-0000-4000-8000-00000000010' + (index + 1)
      member.profile.profileKey = agentKey
      member.spec.peers = []; member.spec.messages = []
      member.model.text = index < 2 ? JSON.stringify({ text: 'evidence-' + agentKey })
        : index === 2 ? 'Synthesis of both accepted evidence records.' : JSON.stringify({ decision: 'accept', reason: 'Checked fixed synthesis candidate.' })
      return member
    })
    raw.routes = raw.members.map(member => ({ memberKey: member.agentKey, ownerHost: raw.hostKey, origin: null, serverName: null }))
    definition.roster = raw.members.map(member => ({ ...structuredClone(definition.roster[0]), memberKey: member.agentKey,
      address: 'ah-session:' + member.sessionId, canProduce: member.agentKey !== 'critic', canReview: member.agentKey === 'critic', budgetCeiling: grant }))
    const template = definition.nodes[0]
    definition.nodes = names.slice(0, 3).map(nodeKey => ({ ...structuredClone(template), nodeKey, executor: nodeKey,
      task: nodeKey === 'synthesis' ? 'Combine the two accepted evidence inputs.' : 'Produce bounded evidence for ' + nodeKey,
      output: nodeKey === 'synthesis' ? { kind: 'text', name: 'report' }
        : { kind: 'json', schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, artifacts: [] },
      attempts: [{ ...structuredClone(template.attempts[0]), workerGrant: grant }] }))
    const synthesis = definition.nodes[2]
    synthesis.dependencies = names.slice(0, 2).map(nodeKey => ({ nodeKey, mode: 'required' }))
    synthesis.inputs = names.slice(0, 2).map(nodeKey => ({ name: nodeKey, source: { kind: 'accepted', nodeKey, path: ['text'] } }))
    synthesis.inputSchema = { type: 'object', properties: { writer: { type: 'string' }, reviewer: { type: 'string' } }, required: ['writer', 'reviewer'], additionalProperties: false }
    synthesis.acceptance = { kind: 'reviewed-all', reviewers: ['critic'] }
    synthesis.attempts[0].reviewerGrants = [{ memberKey: 'critic', grant }]
    definition.requiredOutputs = ['synthesis']
    definition.communication.disclosures = names.slice(0, 3).map(nodeKey => ({ nodeKey, recipients: ['coordinator', nodeKey === 'synthesis' ? 'critic' : 'synthesis'] }))
    definition.limits.maxProtocolMessages = 24
    definition.budget = { ...grant, models: 4, steps: 4, outputTokens: 1024 }
    raw.workflows.maxBusinessConcurrency = concurrency
    const spec = resolveWorkflowConfig(raw)
    await h.initializeHost(spec); host = await h.openHost(spec)
    const workflow = host.workflow('research')
    await workflow.resume({ requestKey: 'start-research' }); await host.run()
    const report = workflow.report()
    assert.equal(report.closed, true); assert.equal(report.counts.accepted, 3); assert.equal(report.counts.reviews, 1)
    assert.equal(report.usage.modelCalls, 4)
    assert.ok(host.report().members.every(member => member.agent.roots.length === 1))
    const artifact = workflow.readArtifact(report.artifacts.find(item => item.name === 'report').ref)
    assert.equal(artifact.value.text, raw.members[2].model.text)
    await host.shutdown({ mode: 'drain' })
    const repository = new h.SessionRepository({ backend: new h.FileSessionBackend(spec.storage), catalog: h.hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      for (const [index, expected] of [[2, ['evidence-writer', 'evidence-reviewer']], [3, [raw.members[2].model.text]]]) {
        const snapshot = await repository.read(h.parseSessionId(spec.members[index].sessionId))
        const request = snapshot.history.at(-1).events.find(item => item.stored.type === 'model/invocation-prepared')
        for (const text of expected) assert.ok(JSON.stringify(request.payload).includes(text))
      }
    } finally { await repository.dispose() }
    console.log(JSON.stringify({ example: 'workflow-research', concurrency, report }))
  } finally { await host?.shutdown(); await rm(root, { recursive: true, force: true }) }
}
