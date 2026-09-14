import { strict as assert } from 'node:assert'
import { SessionModelRunner } from '../../src/model/runner.js'
import { ModelResponseAccumulator } from '../../src/model/response.js'
import { MemorySessionBackend } from '../../src/session/memory-backend.js'
import { snapshotModelRequest } from '../../src/model/request.js'
import { parseModelInvocationId } from '../../src/model/ids.js'
import { createPreparedSubmission, assertSameSubmission } from '../../src/model/submission.js'
import { repository, scripted, runnerLimits, streamLimits, request, textFrames, hasCode, tool } from './fixtures.js'
import type { RegisterCase } from './fixtures.js'
import type { ModelFrame, ModelRequest, ModelRunnerLimits } from '../../src/model/contract.js'

export function boundaryCases(test: RegisterCase): void {
  test('S6-03/08: malformed JSON inputs, IDs, Schema keywords and tool links reject', () => {
    const cycle: Record<string, unknown> = {}; cycle.self = cycle
    for (const input of [cycle, { ...request(), maxOutputTokens: Infinity }, { ...request(), messages: [{ role: 'system', content: [] }] },
      { ...request(), tools: [{ ...tool, inputSchema: { type: 'object', $ref: 'https://never-fetch.invalid/schema' } }] }]) {
      assert.throws(() => snapshotModelRequest(input))
    }
    assert.throws(() => parseModelInvocationId('UPPERCASE-or-not-uuid'), hasCode('MODEL_REQUEST_INVALID'))
    const reference = { invocationId: parseModelInvocationId('11111111-1111-4111-8111-111111111111'), outputBlockIndex: 0 }
    assert.throws(() => snapshotModelRequest({ ...request(), messages: [{ role: 'user', content: [{ kind: 'tool-result', callId: 'missing', source: reference, result: 'unmatched', isError: false }] }] }), hasCode('MODEL_REQUEST_INVALID'))
  })
  test('S6-09: mutable constructor configuration and prepared input cannot drift the bound plan', async () => {
    const limits = { ...streamLimits }; const provider = scripted({ streamLimits: limits }); const mutable = structuredClone(request())
    try {
      const bound = provider.prepare(mutable); limits.maxFrames = 1; Object.assign(mutable, { model: 'changed' })
      assert.equal(bound.submission.binding.streamLimits.maxFrames, streamLimits.maxFrames); assert.equal(bound.submission.request.model, 'fixture-model')
      assert.throws(() => Object.assign(provider, { descriptor: {} }), TypeError)
      const other = createPreparedSubmission(request(), bound.submission.binding, { different: true })
      assert.throws(() => assertSameSubmission(bound.submission, other), hasCode('MODEL_BINDING_MISMATCH'))
    } finally { await provider.dispose() }
  })
  test('S6-16: provider-local partial acquisition cleanup occurs before its failure settlement', async () => {
    let temporaryLive = false; let starts = 0; const repo = repository()
    const provider = scripted({ onAcquire: () => { temporaryLive = true; try { throw new Error('opaque acquisition error') } finally { temporaryLive = false } }, script: async function* () { starts++; yield* textFrames() } })
    const runner = new SessionModelRunner({ session: await repo.create(), provider, limits: runnerLimits })
    try { const result = await runner.invoke(request()); assert.equal(result.payload.outcome, 'failed'); assert.equal(result.payload.external, 'not-issued'); assert.equal(temporaryLive, false); assert.equal(starts, 0) }
    finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })
  for (const [name, limit] of [
    ['result bytes', { maxNormalizedResultBytes: 350 }], ['output blocks', { maxOutputBlocks: 1 }], ['tool calls', { maxToolCalls: 0 }],
  ] as const) {
    test(`S6-33/34: ${name} stops with a persistable bounded partial result`, async () => {
      const repo = repository(); const limits: ModelRunnerLimits = { ...runnerLimits, ...limit }
      const provider = scripted({ script: async function* () {
        yield { kind: 'message-start', reportedModel: 'm', responseId: 'r' }
        if (name === 'tool calls') yield { kind: 'block-start', index: 0, block: 'tool-call', name: 'lookup', callId: 'id' }
        else { yield { kind: 'block-start', index: 0, block: 'text' }; yield { kind: 'text-delta', index: 0, text: name === 'result bytes' ? '\u0000'.repeat(1024) : 'a' }; yield { kind: 'block-start', index: 1, block: 'text' } }
      } })
      const session = await repo.create(); const runner = new SessionModelRunner({ session, provider, limits })
      try { const result = await runner.invoke(request()); assert.equal(result.payload.outcome, 'incomplete'); assert.equal(result.payload.failure?.code, 'MODEL_LIMIT_EXCEEDED'); assert.ok(Buffer.byteLength(JSON.stringify(result.payload.result)) <= limits.maxNormalizedResultBytes); assert.equal(session.snapshot().localPosition, 3) }
      finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
    })
  }
  test('S6-34: actual Backend budget rejects an impossible result shell before prepare', async () => {
    const repo = repository(new MemorySessionBackend({ maxRecordBytes: 512 })); const session = await repo.create(); const provider = scripted()
    try { assert.throws(() => new SessionModelRunner({ session, provider, limits: runnerLimits }), hasCode('MODEL_REQUEST_INVALID')); assert.equal(session.maxRecordBytes, 512); assert.equal(session.snapshot().localPosition, 0) }
    finally { await provider.dispose(); await repo.dispose() }
  })
  test('S6-32: absent, zero and cumulative usage remain distinct', async () => {
    const provider = scripted()
    try {
      const accumulator = new ModelResponseAccumulator(request(), provider.descriptor, runnerLimits)
      accumulator.accept({ kind: 'message-start', reportedModel: 'm', responseId: 'r' })
      assert.equal(accumulator.snapshot().usage.completeness, 'unknown')
      accumulator.accept({ kind: 'usage', counts: { inputTokens: 0, outputTokens: 1 } })
      accumulator.accept({ kind: 'usage', counts: { outputTokens: 3 } })
      accumulator.accept({ kind: 'complete', stopReason: 'stop' })
      assert.equal(accumulator.snapshot().usage.inputTokens, 0); assert.equal(accumulator.snapshot().usage.outputTokens, 3)
      assert.equal(accumulator.snapshot().usage.completeness, 'complete')
    } finally { await provider.dispose() }
  })
  for (const frames of [
    [{ kind: 'block-start', block: 'tool-call', index: 0, callId: 'same', name: 'lookup' }, { kind: 'block-start', block: 'tool-call', index: 1, callId: 'same', name: 'lookup' }],
    [{ kind: 'usage', counts: { outputTokens: 10 } }, { kind: 'usage', counts: { outputTokens: 9 } }],
    [{ kind: 'complete', stopReason: 'stop' }, { kind: 'complete', stopReason: 'stop' }],
  ] as const) {
    test(`S6-24/32: invalid frame sequence ${JSON.stringify(frames[1])} is rejected`, async () => {
      const provider = scripted(); const accumulator = new ModelResponseAccumulator(request(), provider.descriptor, runnerLimits)
      try { accumulator.accept({ kind: 'message-start', reportedModel: 'm', responseId: 'r' }); accumulator.accept(frames[0] as ModelFrame); assert.throws(() => accumulator.accept(frames[1] as ModelFrame), hasCode('MODEL_PROTOCOL_INVALID')) }
      finally { await provider.dispose() }
    })
  }
  test('S6-18/30: transport failure after a complete frame cannot preserve successful outcome', async () => {
    const repo = repository(); const provider = scripted({ script: async function* () { yield* textFrames(); throw new Error('late disconnect') } })
    const runner = new SessionModelRunner({ session: await repo.create(), provider, limits: runnerLimits })
    try { assert.equal((await runner.invoke(request())).payload.outcome, 'failed') }
    finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })
  test('S6-07: provider call IDs may repeat across separate resolved historical invocations', () => {
    const first = { invocationId: parseModelInvocationId('11111111-1111-4111-8111-111111111111'), outputBlockIndex: 0 }
    const second = { invocationId: parseModelInvocationId('22222222-2222-4222-8222-222222222222'), outputBlockIndex: 0 }
    const pair = (source: typeof first): ModelRequest['messages'] => [{ role: 'assistant', content: [{ kind: 'tool-call', callId: 'same', source, name: 'lookup', argumentsText: '{}' }] }, { role: 'user', content: [{ kind: 'tool-result', callId: 'same', source, result: 'done', isError: false }] }]
    assert.doesNotThrow(() => snapshotModelRequest({ ...request(), messages: [...request().messages, ...pair(first), ...pair(second)] }))
  })
}
