import { strict as assert } from 'node:assert'
import { createDurableEventCatalog, createDurableEventDefinition } from '../../src/session/event-catalog.js'
import { MemorySessionBackend } from '../../src/session/memory-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import type { SessionHandle } from '../../src/session/session-handle.js'
import {
  createPreparedSubmission, ModelError, modelSessionEventDefinitions, parseModelInvocationId,
  recoverModelInvocation, SessionModelRunner,
} from '../../src/model/index.js'
import type { ModelProvider } from '../../src/model/index.js'
import { modelPreparedEvent, modelStartedEvent } from '../../src/model/session-events.js'
import { hasCode, repository, request, runnerLimits, scripted, textFrames } from './fixtures.js'
import type { RegisterCase } from './fixtures.js'

/** Injection seam delegates every read/write to a real Session Handle and its CAS queue. */
function beforeConditional(handle: SessionHandle, inject: (type: string) => void): SessionHandle {
  return {
    get header() { return handle.header },
    get status() { return handle.status },
    get maxRecordBytes() { return handle.maxRecordBytes },
    supportsEventDefinition: definition => handle.supportsEventDefinition(definition),
    append: (definition, payload) => handle.append(definition, payload),
    appendIfPosition: (position, definition, payload) => {
      inject(definition.type)
      return handle.appendIfPosition(position, definition, payload)
    },
    end: reason => handle.end(reason),
    snapshot: () => handle.snapshot(),
    project: projection => handle.project(projection),
    dispose: () => handle.dispose(),
  }
}

export function journalCases(test: RegisterCase): void {
  for (const exhaust of [false, true]) {
    test(`S6-05 local CAS: unrelated writes at CP0/CP1/CP2; exhaust=${exhaust}, external start remains once`, async () => {
      const noise = createDurableEventDefinition({ type: 'test/concurrent', payloadVersion: 1, ignorable: false, decode: value => value })
      const repo = new SessionRepository({ backend: new MemorySessionBackend({ maxRecordBytes: 65536 }), catalog: createDurableEventCatalog([...modelSessionEventDefinitions, noise]), maxLineageDepth: 0 })
      const actual = await repo.create(); const injected = new Set<string>(); const extra: Promise<unknown>[] = []; let starts = 0
      const handle = beforeConditional(actual, type => {
        if (exhaust ? type.endsWith('settled') : !injected.has(type)) {
          injected.add(type)
          const write = actual.append(noise, { type }); void write.catch(() => undefined); extra.push(write)
        }
      })
      const provider = scripted({ script: async function* () { starts++; yield* textFrames() } })
      const runner = new SessionModelRunner({ session: handle, provider, limits: { ...runnerLimits, maxJournalConflicts: 2 } })
      try {
        if (exhaust) {
          await assert.rejects(runner.invoke(request()), hasCode('MODEL_SESSION_CHANGED'))
          assert.equal(runner.snapshot().invocations[0]?.state, 'started')
          assert.equal(extra.length, 3)
        } else {
          assert.equal((await runner.invoke(request())).payload.outcome, 'completed')
          assert.equal(extra.length, 3)
          assert.equal(actual.snapshot().localPosition, 6)
        }
        assert.equal(starts, 1)
        assert.equal(actual.status, 'open')
      } finally { await Promise.all(extra); await runner.dispose().catch(() => undefined); await provider.dispose(); await repo.dispose() }
    })
  }

  test('S6-38: recovery rechecks external uncertainty if a start fact wins the CAS race', async () => {
    const repo = repository(); const provider = scripted(); const actual = await repo.create()
    const invocationId = parseModelInvocationId('11111111-1111-4111-8111-111111111111')
    const prepared = await actual.append(modelPreparedEvent, { invocationId, submission: provider.prepare(request()).submission, limits: runnerLimits })
    let inserted: Promise<unknown> | undefined
    const handle = beforeConditional(actual, type => {
      if (type.endsWith('settled') && inserted === undefined) {
        // Simulate an administrative competing write, not a surviving network driver.
        inserted = actual.append(modelStartedEvent, { invocationId, preparedEventId: prepared.stored.eventId, fingerprint: prepared.payload.submission.fingerprint })
        void inserted.catch(() => undefined)
      }
    })
    try {
      const result = await recoverModelInvocation(handle, { invocationId, predecessorStopped: true, maxJournalConflicts: 2 })
      assert.equal(result.payload.external, 'may-have-been-issued')
      assert.equal(result.payload.outcome, 'interrupted')
      assert.equal(actual.snapshot().localPosition, 3)
    } finally { await inserted; await provider.dispose(); await repo.dispose() }
  })

  test('S6-48: preparation exceptions cannot leak arbitrary provider messages or details', async () => {
    const secret = 'runtime-credential-never-persist'
    const provider = scripted({ onPrepare: () => { throw new ModelError('MODEL_REQUEST_INVALID', secret, { apiKey: secret }) } })
    const repo = repository(); const session = await repo.create()
    const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    try {
      await assert.rejects(runner.invoke(request()), reason => {
        assert.ok(reason instanceof ModelError)
        assert.equal(reason.code, 'MODEL_REQUEST_INVALID')
        assert.ok(!JSON.stringify(reason.toJSON()).includes(secret))
        assert.ok(!reason.message.includes(secret))
        return true
      })
      assert.equal(session.snapshot().localPosition, 0)
    } finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })

  test('S6-55: third-party Provider needs only the public contract and prepared factory', async () => {
    const descriptorSource = scripted(); const descriptor = descriptorSource.descriptor
    let starts = 0; let closes = 0
    const provider: ModelProvider = {
      descriptor,
      prepare: input => {
        const submission = createPreparedSubmission(input, descriptor, { input })
        let acquired = false
        return { submission, acquire: committed => {
          if (acquired || committed.fingerprint !== submission.fingerprint) throw new ModelError('MODEL_BINDING_MISMATCH', 'fixture binding mismatch')
          acquired = true
          return { start: () => { starts++; return textFrames() }, close: async () => { closes++ } }
        } }
      },
      dispose: async () => undefined,
    }
    const repo = repository(); const runner = new SessionModelRunner({ session: await repo.create(), provider, limits: runnerLimits })
    try { assert.equal((await runner.invoke(request())).payload.outcome, 'completed'); assert.equal(starts, 1); assert.equal(closes, 1) }
    finally { await runner.dispose(); await repo.dispose(); await descriptorSource.dispose() }
  })
}
