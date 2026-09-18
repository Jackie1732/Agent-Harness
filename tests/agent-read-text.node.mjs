import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { h, fixture, catalog, schemaLimits, modelLimits } from './helpers/tool-fixture.mjs'
import { contextProfile } from '../examples/context-fixture.mjs'
import { agentSpec } from '../examples/agent-fixture.mjs'

test('Agent reads a real workspace file through exact Tool authorization and committed history', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-read-text-'))
  const text = 'Atomic Agent integration: real file contents.'
  let provider
  try {
    await mkdir(join(root, 'workspace'))
    await writeFile(join(root, 'workspace', 'research.txt'), text)
    await mkdir(join(root, 'sessions'))
    provider = await h.createWorkspaceReadTextProvider({ rootId: 'agent-test', rootPath: join(root, 'workspace'), protectedRoots: [join(root, 'sessions')],
      maxReadBytes: 1024, maxPathBytes: 1024, maxArgumentsBytes: 4096, maxResultBytes: 8192, schemaLimits })
    await fixture(async f => {
      let calls = 0
      const model = new h.ScriptedModelProvider({ providerId: 'agent-file-reader', maxConcurrentExchanges: 1,
        streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 },
        onPrepare(request) { if (calls === 1) assert.ok(JSON.stringify(request.messages).includes(text)) },
        script: async function* () {
          calls++
          yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: `response-${calls}` }
          if (calls === 1) {
            yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'read', name: 'read_text' }
            yield { kind: 'arguments-delta', index: 0, text: '{"path":"research.txt"}' }
            yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
          } else {
            yield { kind: 'block-start', index: 0, block: 'text' }
            yield { kind: 'text-delta', index: 0, text: 'File inspected.' }
            yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
          }
        } })
      f.providers.push(model)
      const context = new h.SessionContext({ session: f.session, messageCatalog: h.createMessageCatalog(), toolRegistry: f.registry })
      const profile = await context.recordProfile(contextProfile('generation', { rendererVersion: 'context-neutral/v2', toolNames: ['read_text'] }))
      await h.installAgentSpec(f.session, agentSpec(profile.stored.eventId, model.descriptor, { toolNames: ['read_text'] }), h.systemClock)
      const agent = new h.SessionAgent({ session: f.session, context, model: new h.SessionModelRunner({ session: f.session, provider: model, limits: modelLimits }),
        tools: f.runner, messageCatalog: h.createMessageCatalog(), clock: h.systemClock })
      try {
        await agent.submitInput({ kind: 'task', text: 'Inspect research.txt.', originLabel: 'test' })
        const report = await agent.start()
        assert.equal(report.roots[0].outcome, 'completed')
        assert.equal(report.roots[0].budget.tools, 1)
        assert.equal(calls, 2)
        assert.equal(f.trace.approvals, 1)
        const invocation = f.runner.snapshot().invocations[0]
        assert.equal(invocation.requested.payload.source.kind, 'model')
        assert.equal(invocation.settled.payload.outcome, 'succeeded')
        await agent.endSession()
        const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
          import * as h from './dist/index.js';
          const repository = new h.SessionRepository({ backend: new h.FileSessionBackend({ root: process.argv[1], maxRecordBytes: 262144 }),
            maxLineageDepth: 8, catalog: h.createDurableEventCatalog([...h.toolSessionEventDefinitions, ...h.modelSessionEventDefinitions, ...h.contextSessionEventDefinitions,
              ...h.communicationSessionEventDefinitions, ...h.agentSessionEventDefinitions]) });
          try {
            const snapshot = await repository.read(h.parseSessionId(process.argv[2]));
            const report = h.projectAgentReport(snapshot);
            for (const event of snapshot.history.at(-1).events.filter(event => event.stored.type === 'context/assembly-committed')) {
              if (h.rebuildAssembly(snapshot, event.stored.eventId).kind !== 'rebuilt') throw new Error('rebuild failed');
            }
            process.stdout.write(JSON.stringify({ outcome: report.roots[0].outcome, final: report.final.text }));
          } finally { await repository.dispose(); }
        `, join(root, 'sessions'), f.session.header.sessionId], { encoding: 'utf8' })
        assert.deepEqual(JSON.parse(child.stdout), { outcome: 'completed', final: 'File inspected.' })
      } finally { await agent.dispose() }
    }, { provider, definition: h.createReadTextDefinition(schemaLimits), backend: new h.FileSessionBackend({ root: join(root, 'sessions'), maxRecordBytes: 262144 }),
      catalog: catalog([...h.contextSessionEventDefinitions, ...h.communicationSessionEventDefinitions, ...h.agentSessionEventDefinitions]),
      decide: input => {
        assert.equal(input.plan.target.kind, 'workspace-file')
        assert.equal(input.plan.target.rootId, 'agent-test')
        assert.equal(input.plan.target.path, 'research.txt')
        return { kind: 'allow', reasonCode: 'fixture-authorized' }
      } })
  } finally { await provider?.dispose(); await rm(root, { recursive: true, force: true }) }
})
