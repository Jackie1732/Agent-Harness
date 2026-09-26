import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as h from '../../dist/index.js'
import { captureFileCommits, seedFileCommits } from './subagent-prefixes.mjs'
import { resolveWorkflowConfig } from '../../examples/workflow-fixture.mjs'

/** Independent peer prefixes need causal closure, not a shared sequence or observed wall-clock ordering. */
export async function verifyParallelRecovery(raw, frames, clock) {
  const peers = raw.members.slice(0, 2).map(member => member.sessionId)
  const starts = peers.map(id => frames.findIndex(frame => frame.kind === 'event' && frame.event.sessionId === id && frame.event.type === 'model/invocation-started'))
  assert.ok(starts.every(index => index >= 0))
  const prefix = frames.slice(0, Math.max(...starts) + 1)
  for (const settledPeer of [null, ...peers]) {
    const root = await mkdtemp(join(tmpdir(), 'workflow-parallel-cut-'))
    try {
      const cut = settledPeer === null ? prefix : frames.filter(frame => {
        if (frame.kind === 'header') return true
        if (frame.event.sessionId !== settledPeer) return prefix.includes(frame)
        const settled = frames.find(item => item.kind === 'event' && item.event.sessionId === settledPeer && item.event.type === 'model/invocation-settled')
        return frame.event.sequence <= settled.event.sequence
      })
      await seedFileCommits(root, cut)
      const spec = resolveWorkflowConfig({ ...raw, storage: { ...raw.storage, root } })
      const options = { predecessorStopped: true, maxRecoveryWrites: 64, maxJournalConflicts: 4, clock }
      let result
      const recovery = await captureFileCommits(async () => { result = await h.recoverHost(spec, options) })
      assert.ok(result.every(item => item.result.pending.length === 0))
      assert.ok(result.every(item => item.result.totalWrites === recovery.length && item.result.totalWrites <= 64))
      assert.ok(recovery.every(item => !['model/invocation-prepared', 'model/invocation-started', 'tool/invocation-requested',
        'communication/outbox-accepted', 'artifact/published', 'workflow/decision-committed'].includes(item.event.type)))
      assert.deepEqual(await captureFileCommits(() => h.recoverHost(spec, options)), [])
      const repository = new h.SessionRepository({ backend: new h.FileSessionBackend(spec.storage), catalog: h.hostRuntimeEventCatalog, maxLineageDepth: 4 })
      try {
        for (const peer of peers) {
          const snapshot = await repository.read(h.parseSessionId(peer)), model = h.projectModelSession(snapshot)
          assert.equal(model.invocations.length, 1)
          assert.equal(model.pendingInvocationId, null)
          const saved = cut.find(frame => frame.kind === 'event' && frame.event.sessionId === peer && frame.event.type === 'model/invocation-settled')
          if (saved) assert.deepEqual(model.invocations[0].settled.stored, saved.event)
          else assert.equal(h.projectAgentSession(snapshot).roots[0].outcome, 'result-unknown')
        }
      } finally { await repository.dispose() }
      const host = await h.openHost(spec, { clock, credentials: { 'local-fixture': 'local-only' } })
      try { assert.equal(host.workflow('research').report().state, 'suspended') }
      finally { await host.shutdown({ mode: 'drain' }) }
    } finally { await rm(root, { recursive: true, force: true }) }
  }
}
