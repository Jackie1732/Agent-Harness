import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { decodeHostConfig, initializeHost, openHost, resolveHostConfig, ScriptedModelProvider,
  FileSessionBackend, SessionRepository, hostRuntimeEventCatalog, parseSessionId, projectCommunicationFacts } from '../../src/index.js'
import type { JsonObject, ModelFrame } from '../../src/index.js'
import { createHostModelProvider } from '../../src/host/model-factory.js'
import { twoMemberHostConfig } from './fixtures.js'

it.each([1, 2])('gives business an opportunity with saturated delivery and maintenance, scanning %i members', async maxSlotsPerScan => {
  const root = await mkdtemp(join(tmpdir(), 'host-lane-fairness-'))
  const config = twoMemberHostConfig(root)
  const members = (config.members as readonly JsonObject[]).map(member => ({ ...member, spec: { ...(member.spec as JsonObject),
    nativeActions: ['agent_ask_user', 'agent_send_message'], maxDirectSendCommandsPerSession: 32,
    limits: { ...((member.spec as JsonObject).limits as JsonObject), maxManagementPerRun: 1, maxTurnsPerRun: 1 },
  }, model: { ...(member.model as JsonObject), runnerLimits: { ...((member.model as JsonObject).runnerLimits as JsonObject), maxToolCalls: 1 } } }))
  const spec = resolveHostConfig(decodeHostConfig({ ...config, members,
    scheduling: { ...(config.scheduling as object), maxSlotsPerScan, maxBatchesPerRun: 1, maxReportEntries: 1 } }, root))
  await initializeHost(spec)
  let reviewerCalls = 0
  const host = await openHost(spec, { bindings: { createModelProvider(member) {
    if (member.agentKey === 'reviewer') {
      const provider = createHostModelProvider(member.model, {})
      return { descriptor: provider.descriptor, dispose: () => provider.dispose(), prepare(request) { reviewerCalls++; return provider.prepare(request) } }
    }
    return new ScriptedModelProvider({ ...member.model, script: async function* (): AsyncGenerator<ModelFrame> {
      yield { kind: 'message-start', reportedModel: 'fixed-model', responseId: 'question' }
      yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'question', name: 'agent_ask_user' }
      yield { kind: 'arguments-delta', index: 0, text: '{"question":"continue?","timeoutMs":60000}' }
      yield { kind: 'block-end', index: 0 }
      yield { kind: 'complete', stopReason: 'tool-calls' }
    } })
  } } })
  try {
    for (let index = 0; index < 4; index++) { await host.submitTask('writer', `wait ${index}`); await host.run() }
    const waits = host.report().members[0]!.agent.waits
    expect(waits).toHaveLength(4)
    host.pause('writer')
    for (const wait of waits) await host.submitAnswer('writer', wait.reference, 'answer')
    await host.submitTask('reviewer', 'business must progress')
    let delivery = 0; let maintenance = 0
    const bound = 3 * Math.ceil(2 / maxSlotsPerScan)
    for (let run = 0; run < bound; run++) {
      await host.sendMessage('writer', { kind: 'send', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1, payloadJson: JSON.stringify({ text: `fresh ${run}` }) })
      const report = await host.run()
      expect(report.batches).toBe(1)
      delivery += report.deliveryAttempts; maintenance += report.maintenanceRuns
    }
    expect(delivery).toBeGreaterThan(0); expect(maintenance).toBeGreaterThan(0)
    expect(reviewerCalls).toBeGreaterThan(0)
  } finally { await host.shutdown() }
}, 30_000)

it.each([1, 3])('rotates multiple senders under sustained delivery with budget %i', async maxBatchesPerRun => {
  const root = await mkdtemp(join(tmpdir(), 'host-sender-fairness-'))
  const config = twoMemberHostConfig(root)
  const members = (config.members as readonly JsonObject[]).map(member => ({ ...member,
    spec: { ...(member.spec as JsonObject), maxDirectSendCommandsPerSession: 32 } }))
  const spec = resolveHostConfig(decodeHostConfig({ ...config, members,
    scheduling: { ...(config.scheduling as object), maxSlotsPerScan: 2, maxBatchesPerRun } }, root))
  await initializeHost(spec)
  const host = await openHost(spec)
  try {
    host.pause('writer'); host.pause('reviewer')
    for (let index = 0; index < 6; index++) {
      for (const [agent, peer] of [['writer', 'reviewer'], ['reviewer', 'writer']]) {
        await host.sendMessage(agent!, { kind: 'send', peerKey: peer!, type: 'test/note', payloadVersion: 1, payloadJson: JSON.stringify({ text: `${index}` }) })
      }
      await host.run()
    }
    // Neither direction monopolizes admission, even with one batch per run.
    for (const member of host.report().members) {
      expect(member.agent.counts.pendingInputs).toBeGreaterThanOrEqual(3)
    }
  } finally { await host.shutdown() }
  const repository = new SessionRepository({ backend: new FileSessionBackend({ root, maxRecordBytes: spec.storage.maxRecordBytes }),
    catalog: hostRuntimeEventCatalog, maxLineageDepth: spec.storage.maxLineageDepth })
  try {
    for (const member of spec.members) {
      const inbox = projectCommunicationFacts(await repository.read(parseSessionId(member.sessionId))).inbox
      expect(inbox.map(item => item.envelope.payload)).toEqual(inbox.map((_, index) => ({ text: `${index}` })))
    }
  } finally { await repository.dispose() }
})
