import { performance } from 'node:perf_hooks'
import * as h from '../dist/index.js'
import { contextProfile, scriptedTextProvider, modelLimits } from '../examples/context-fixture.mjs'
import { agentSpec } from '../examples/agent-fixture.mjs'

const observation = h.createDurableEventDefinition({ type: 'benchmark/observation', payloadVersion: 1, ignorable: true, decode: value => value })
const repository = new h.SessionRepository({ backend: new h.MemorySessionBackend({ maxRecordBytes: 262144 }), maxLineageDepth: 8,
  catalog: h.createDurableEventCatalog([...h.agentSessionEventDefinitions, ...h.contextSessionEventDefinitions, ...h.modelSessionEventDefinitions,
    ...h.toolSessionEventDefinitions, ...h.communicationSessionEventDefinitions, observation]) })
const provider = scriptedTextProvider('completed task')
const session = await repository.create(); const messageCatalog = h.createMessageCatalog()
const context = new h.SessionContext({ session, messageCatalog })
const profile = await context.recordProfile(contextProfile('generation', { rendererVersion: 'context-neutral/v2' }))
await h.installAgentSpec(session, agentSpec(profile.stored.eventId, provider.descriptor), h.systemClock)
const agent = new h.SessionAgent({ session, context, model: new h.SessionModelRunner({ session, provider, limits: modelLimits }), messageCatalog, clock: h.systemClock })
try {
  await agent.submitInput({ kind: 'task', text: 'one completed root among independent Session facts', originLabel: 'benchmark' }); await agent.start()
  for (const size of [100, 1000, 5000]) {
    while (session.snapshot().localPosition < size) await session.append(observation, { text: 'bounded independent observation' })
    const snapshot = session.snapshot(); const samples = []
    for (let index = 0; index < 12; index++) { const start = performance.now(); h.projectAgentReport(snapshot); const elapsed = performance.now() - start; if (index >= 2) samples.push(elapsed) }
    samples.sort((a, b) => a - b)
    process.stdout.write(JSON.stringify({ benchmark: 'full-report-replay', events: size, roots: 1, samples: samples.length,
      medianMs: Number(samples[5].toFixed(3)), maxMs: Number(samples.at(-1).toFixed(3)), node: process.version }) + '\n')
  }
} finally { await agent.dispose(); await provider.dispose(); await repository.dispose() }
