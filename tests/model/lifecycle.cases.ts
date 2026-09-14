import { strict as assert } from 'node:assert'
import { SessionModelRunner } from '../../src/model/runner.js'
import { ModelError } from '../../src/model/errors.js'
import { parseModelInvocationId } from '../../src/model/ids.js'
import { encodeModelWireBody } from '../../src/model/submission.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { deferred, hasCode, repository, request, runnerLimits, scripted, textFrames, tool } from './fixtures.js'
import type { RegisterCase } from './fixtures.js'

export function lifecycleCases(test: RegisterCase): void {
  test('S6-02/20/42/51: committed input, once-only exchange, repeated experiment and borrowed Writer', async () => {
    const repo = repository(); let starts = 0; let closes = 0
    const provider = scripted({ script: async function* (submission) { starts++; assert.equal(submission.request.model, 'fixture-model'); yield* textFrames() }, onClose: () => { closes++ } })
    try {
      const session = await repo.create(); const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
      const input = structuredClone(request()); const pending = runner.invoke(input)
      Object.assign(input, { model: 'mutated' })
      const event = await pending
      assert.equal(event.payload.outcome, 'completed'); assert.equal(event.payload.cleanup.status, 'complete')
      assert.equal(session.snapshot().localPosition, 3)
      const original = runner.snapshot().invocations[0]
      assert.ok(original); assert.equal(original.prepared.payload.submission.request.model, 'fixture-model')
      assert.equal(JSON.parse(Buffer.from(encodeModelWireBody(original.prepared.payload.submission)).toString()).model, 'fixture-model')
      await runner.invoke(request(), { retryOf: event.payload.invocationId })
      assert.equal(starts, 2); assert.equal(closes, 2)
      assert.notEqual(runner.snapshot().invocations[0]?.invocationId, runner.snapshot().invocations[1]?.invocationId)
      const close = runner.dispose(); assert.equal(close, runner.dispose()); await close
      assert.throws(() => runner.invoke(request()), hasCode('MODEL_RUNNER_INACTIVE'))
      assert.equal(runner.snapshot().invocations.length, 2); assert.equal(session.status, 'open'); await session.end()
    } finally { await provider.dispose(); await repo.dispose() }
  })
  test('S6-03/08: input accessors and unsupported fields fail before durable acceptance', async () => {
    const repo = repository(); const provider = scripted(); const session = await repo.create()
    const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    let getterCalls = 0
    try {
      const input = request(); Object.defineProperty(input, 'model', { enumerable: true, get: () => { getterCalls++; return 'secret' } })
      await assert.rejects(runner.invoke(input), hasCode('MODEL_REQUEST_INVALID'))
      await assert.rejects(runner.invoke({ ...request(), extraBody: {} } as ReturnType<typeof request>), hasCode('MODEL_REQUEST_INVALID'))
      assert.equal(getterCalls, 0); assert.equal(session.snapshot().localPosition, 0)
    } finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })
  test('S6-04: two runners sharing one Handle cannot prepare overlapping invocations', async () => {
    const entered = deferred(); const release = deferred(); const repo = repository()
    const provider = scripted({ maxConcurrentExchanges: 2, script: async function* () { entered.resolve(); await release.promise; yield* textFrames() } })
    const session = await repo.create(); const a = new SessionModelRunner({ session, provider, limits: runnerLimits }); const b = new SessionModelRunner({ session, provider, limits: runnerLimits })
    const first = a.invoke(request()); const second = b.invoke(request()); void second.catch(() => undefined)
    try { await entered.promise; await assert.rejects(second, hasCode('MODEL_SESSION_BUSY')); assert.equal(a.snapshot().invocations.length, 1) }
    finally { release.resolve(); await first; await a.dispose(); await b.dispose(); await provider.dispose(); await repo.dispose() }
  })
  test('S6-04: a colliding identity remains a busy admission while its invocation is pending', async () => {
    const entered = deferred(); const release = deferred(); const repo = repository()
    const provider = scripted({ maxConcurrentExchanges: 2, script: async function* () { entered.resolve(); await release.promise; yield* textFrames() } })
    const session = await repo.create()
    const invocationId = parseModelInvocationId('11111111-1111-4111-8111-111111111111')
    const identities = { nextInvocationId: () => invocationId }
    const a = new SessionModelRunner({ session, provider, limits: runnerLimits, identities })
    const b = new SessionModelRunner({ session, provider, limits: runnerLimits, identities })
    const first = a.invoke(request())
    try {
      await entered.promise
      await assert.rejects(b.invoke(request()), hasCode('MODEL_SESSION_BUSY'))
      assert.equal(b.status, 'accepting')
      assert.equal(session.snapshot().localPosition, 2)
    } finally {
      release.resolve(); await first; await a.dispose(); await b.dispose(); await provider.dispose(); await repo.dispose()
    }
  })
  test('S6-17: pre-aborted invocation has no facts or resources', async () => {
    const repo = repository(); let acquired = 0; const provider = scripted({ onAcquire: () => { acquired++ } })
    const session = await repo.create(); const runner = new SessionModelRunner({ session, provider, limits: runnerLimits }); const abort = new AbortController(); abort.abort()
    try { assert.throws(() => runner.invoke(request(), { signal: abort.signal }), hasCode('MODEL_CALL_CANCELLED')); assert.equal(session.snapshot().localPosition, 0); assert.equal(acquired, 0) }
    finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })
  test('S6-17: cancellation during acquisition records not-issued and waits for cleanup', async () => {
    const acquired = deferred(); const release = deferred(); let starts = 0; let closes = 0
    const repo = repository(); const provider = scripted({ onAcquire: async () => { acquired.resolve(); await release.promise }, script: async function* () { starts++; yield* textFrames() }, onClose: () => { closes++ } })
    const session = await repo.create(); const runner = new SessionModelRunner({ session, provider, limits: runnerLimits }); const abort = new AbortController()
    const pending = runner.invoke(request(), { signal: abort.signal })
    try { await acquired.promise; abort.abort(); release.resolve(); const result = await pending; assert.equal(result.payload.outcome, 'cancelled'); assert.equal(result.payload.external, 'not-issued'); assert.equal(starts, 0); assert.equal(closes, 1); assert.equal(session.snapshot().localPosition, 2) }
    finally { release.resolve(); await pending; await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })
  test('S6-17/19/20: cancellation requests stop but waits for an uncooperative in-flight read', async () => {
    const entered = deferred(); const release = deferred(); let closed = 0
    const repo = repository(); const provider = scripted({ script: async function* () { yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'slow' }; entered.resolve(); await release.promise; yield* textFrames() }, onClose: () => { closed++ } })
    const session = await repo.create(); const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    const pending = runner.invoke(request()); await entered.promise
    const disposal = runner.dispose(); assert.equal(disposal, runner.dispose())
    let finished = false; void disposal.then(() => { finished = true })
    try {
      await Promise.resolve(); assert.equal(finished, false); assert.equal(closed, 0)
      release.resolve(); const result = await pending; assert.equal(result.payload.outcome, 'cancelled'); assert.equal(result.payload.cleanup.status, 'complete'); await disposal; assert.equal(closed, 1)
    } finally { release.resolve(); await pending; await disposal; await provider.dispose(); await repo.dispose() }
  })
  test('S6-18: complete claimed before a later cancellation is not rewritten', async () => {
    const closing = deferred(); const release = deferred(); const repo = repository(); const abort = new AbortController()
    const provider = scripted({ onClose: async () => { closing.resolve(); await release.promise } })
    const session = await repo.create(); const runner = new SessionModelRunner({ session, provider, limits: runnerLimits }); const pending = runner.invoke(request(), { signal: abort.signal })
    try { await closing.promise; abort.abort(); release.resolve(); assert.equal((await pending).payload.outcome, 'completed') }
    finally { release.resolve(); await pending; await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })
  test('S6-21: cleanup failure persists output and CP2 identity, then faults the runner', async () => {
    let closes = 0; const repo = repository(); const provider = scripted({ onClose: () => { closes++; throw new Error('secret cleanup body') } })
    const session = await repo.create(); const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    try {
      await assert.rejects(runner.invoke(request()), cause => { assert.ok(cause instanceof ModelError); assert.equal(cause.code, 'MODEL_CLEANUP_FAILED'); assert.ok(cause.details?.eventId); assert.ok(!JSON.stringify(cause).includes('secret')); return true })
      const value = runner.snapshot().invocations[0]; assert.ok(value?.state === 'settled'); assert.equal(value.settled.payload.result.protocolComplete, true); assert.equal(value.settled.payload.cleanup.status, 'incomplete'); assert.equal(runner.status, 'faulted')
      await assert.rejects(runner.dispose(), hasCode('MODEL_CLEANUP_FAILED')); assert.equal(closes, 1)
    } finally { await runner.dispose().catch(() => undefined); await provider.dispose().catch(() => undefined); await repo.dispose() }
  })
  test('S6-22: disposal from the active provider chain rejects self-wait but takes effect', async () => {
    const repo = repository(); let runner: SessionModelRunner | undefined
    const provider = scripted({ script: async function* () { assert.ok(runner); await assert.rejects(runner.dispose(), hasCode('MODEL_REENTRANT_WAIT')); yield* textFrames() } })
    const session = await repo.create(); runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    try { const event = await runner.invoke(request()); assert.equal(event.payload.outcome, 'cancelled'); await runner.dispose() }
    finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })
  test('S6-22: provider disposal from its borrowed exchange cannot deadlock itself', async () => {
    const repo = repository(); const provider = scripted({ onClose: async () => { await assert.rejects(provider.dispose(), hasCode('MODEL_REENTRANT_WAIT')) } })
    const session = await repo.create(); const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    try { assert.equal((await runner.invoke(request())).payload.outcome, 'completed'); await provider.dispose() }
    finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })
  test('S6-26/27/54: invalid arguments and unadvertised intent remain data, length is incomplete', async () => {
    const repo = repository(); const provider = scripted({ script: async function* () {
      yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'tools' }
      yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'call-1', name: 'send_message' }
      yield { kind: 'arguments-delta', index: 0, text: '{bad json' }; yield { kind: 'block-end', index: 0 }
      yield { kind: 'complete', stopReason: 'length' }
    } })
    const session = await repo.create(); const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    try { const event = await runner.invoke({ ...request(), tools: [tool] }); assert.equal(event.payload.outcome, 'incomplete'); const block = event.payload.result.blocks[0]; assert.ok(block?.kind === 'tool-call'); assert.equal(block.argumentsText, '{bad json'); assert.equal(block.argumentsStatus, 'invalid-json'); assert.equal(block.advertisement, 'not-advertised') }
    finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })
  for (const [name, frames] of [
    ['missing terminal', [{ kind: 'message-start', reportedModel: 'm', responseId: 'r' }]],
    ['open block', [{ kind: 'message-start', reportedModel: 'm', responseId: 'r' }, { kind: 'block-start', index: 0, block: 'text' }, { kind: 'complete', stopReason: 'stop' }]],
    ['wrong index', [{ kind: 'message-start', reportedModel: 'm', responseId: 'r' }, { kind: 'block-start', index: 1, block: 'text' }]],
  ] as const) {
    test(`S6-24/30: ${name} cannot become completed`, async () => {
      const repo = repository(); const provider = scripted({ script: async function* () { yield* frames as readonly ModelFrame[] } })
      const session = await repo.create(); const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
      try { const event = await runner.invoke(request()); assert.equal(event.payload.outcome, 'failed'); assert.equal(event.payload.failure?.code, 'MODEL_PROTOCOL_INVALID') }
      finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
    })
  }
  test('S6-57: capacity two permits isolated Sessions while capacity one refuses without emission', async () => {
    for (const maximum of [1, 2]) {
      const entered = deferred(); const both = deferred(); const release = deferred(); const repo = repository(); let starts = 0
      const provider = scripted({ maxConcurrentExchanges: maximum, script: async function* (submission) { starts++; entered.resolve(); if (starts === 2) both.resolve(); await release.promise; yield* textFrames(submission.request.instructions[0]) } })
      const a = new SessionModelRunner({ session: await repo.create(), provider, limits: runnerLimits }); const b = new SessionModelRunner({ session: await repo.create(), provider, limits: runnerLimits })
      const first = a.invoke({ ...request(), instructions: ['A'] }); await entered.promise; const second = b.invoke({ ...request(), instructions: ['B'] }); void second.catch(() => undefined)
      try {
        if (maximum === 1) await assert.rejects(second, hasCode('MODEL_PROVIDER_BUSY'))
        else await both.promise
        assert.equal(starts, maximum); release.resolve(); const resultA = await first; assert.deepEqual(resultA.payload.result.blocks[0], { kind: 'text', index: 0, text: 'A', complete: true }); if (maximum === 2) { const resultB = await second; assert.deepEqual(resultB.payload.result.blocks[0], { kind: 'text', index: 0, text: 'B', complete: true }) }
        assert.notEqual(a.snapshot().sessionId, b.snapshot().sessionId)
      } finally { release.resolve(); await Promise.allSettled([first, second]); await a.dispose(); await b.dispose(); await provider.dispose(); await repo.dispose() }
    }
  })
}
