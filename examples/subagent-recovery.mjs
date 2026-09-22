import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h from '../dist/index.js'
// Fault injection writes only this example's disposable repository using the released frame codec.
import { encodeFrame } from '../dist/session/frame.js'
import { encodeSessionHeader, encodeStoredSessionEvent } from '../dist/session/codec.js'
import { subagentConfig, clock, delegationRequest, action, final } from './subagent-fixture.mjs'

const directory = await mkdtemp(join(tmpdir(), 'harness-ack-recovery-'))
let host
try {
  const root = join(directory, 'original'); const recoveredRoot = join(directory, 'recovered')
  const config = await subagentConfig(root)
  const spec = h.resolveHostConfig(h.decodeHostConfig(config, root))
  await h.initializeHost(spec, { clock })
  let parentCalls = 0; let childCalls = 0
  const bindings = { createModelProvider: member => new h.ScriptedModelProvider({ ...member.model,
    script: async function* () {
      const parent = member.agentKey === 'writer'; const call = parent ? parentCalls++ : childCalls++
      yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'recovery' }
      if (parent && call === 0) yield* action('agent_spawn_subagent', delegationRequest())
      else yield* final(parent ? 'Adopted.' : 'Original child result.')
    },
  }) }
  host = await h.openHost(spec, { clock, bindings }); await host.submitTask('writer', 'Delegate'); await host.run()
  const relation = host.delegationReport().delegations[0]
  assert.equal(relation.closed, true)
  await host.shutdown(); host = undefined
  const repository = new h.SessionRepository({ backend: new h.FileSessionBackend({ root, maxRecordBytes: spec.storage.maxRecordBytes }),
    catalog: h.hostRuntimeEventCatalog, maxLineageDepth: spec.storage.maxLineageDepth })
  try {
    for (const sessionId of [spec.members[0].sessionId, relation.childSessionId]) {
      const snapshot = await repository.read(h.parseSessionId(sessionId))
      const events = snapshot.history.at(-1).events
      const cut = events.find(event => event.stored.type === (sessionId === relation.childSessionId
        ? 'communication/outbox-attempt-started' : 'communication/inbox-accepted')).stored.sequence
      const path = join(recoveredRoot, 'sessions', sessionId)
      await mkdir(path, { recursive: true })
      await writeFile(join(path, 'header.frame'), encodeFrame(encodeSessionHeader(snapshot.header), 65536))
      await writeFile(join(path, 'events.log'), Buffer.concat(events.slice(0, cut).map(event => encodeFrame(encodeStoredSessionEvent(event.stored), spec.storage.maxRecordBytes))))
    }
  } finally { await repository.dispose() }
  const recoveredSpec = h.resolveHostConfig(h.decodeHostConfig({ ...config, storage: { ...config.storage, root: recoveredRoot } }, recoveredRoot))
  await h.recoverHost(recoveredSpec, { predecessorStopped: true, maxRecoveryWrites: 32, maxJournalConflicts: 4, clock })
  const before = childCalls
  host = await h.openHost(recoveredSpec, { clock, bindings })
  assert.equal(host.resume('writer')[0].status, 'resumed')
  await host.run()
  assert.equal(childCalls, before)
  assert.equal(host.delegationReport().delegations[0].childSessionId, relation.childSessionId)
  assert.equal(host.delegationReport().delegations[0].closed, true)
  process.stdout.write(JSON.stringify({ example: 'subagent-ack-recovery', childCallsReplayed: childCalls - before, sameChild: true, closed: true }) + '\n')
} finally { await host?.shutdown(); await rm(directory, { recursive: true, force: true }) }
