import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import { exportNormalizedCallFixture, createNormalizedCallFixtureReplay, decodeNormalizedCallFixture, parseNormalizedCallFixture } from '../../src/experiment/fixture.js'
import type { NormalizedCallFixture } from '../../src/experiment/fixture-types.js'
import type { EvidenceSessionCut } from '../../src/experiment/evidence-types.js'
import { experimentBytesDigest } from '../../src/experiment/parsing.js'
import type { ModelFrame, ModelRequest, NormalizedModelResult } from '../../src/model/contract.js'
import { SessionModelRunner } from '../../src/model/runner.js'
import { parseModelInvocationId } from '../../src/model/ids.js'
import { modelPreparedEvent, modelSettledEvent, modelStartedEvent } from '../../src/model/session-events.js'
import { createPreparedSubmission } from '../../src/model/submission.js'
import { encodeSessionHeader, encodeStoredSessionEvent } from '../../src/session/codec.js'
import { SessionError } from '../../src/session/errors.js'
import { encodeFrame } from '../../src/session/frame.js'
import { formatSessionAddress, formatSessionEventId, sessionSequence } from '../../src/session/ids.js'
import type { SessionHandle } from '../../src/session/session-handle.js'
import type { SessionSnapshot } from '../../src/session/types.js'
import { hasCode, repository, request, runnerLimits, scripted, streamLimits, textFrames, tool } from '../model/fixtures.js'

const limits = { maxFixtureBytes: 65536, maxFixtureEntries: 8 }

/** Memory tests derive the same framed bytes used by File storage, without creating a Host. */
function cut(snapshot: SessionSnapshot, physical = snapshot): EvidenceSessionCut {
  const header = encodeFrame(encodeSessionHeader(snapshot.header), 65536)
  const frames = physical.history.at(-1)!.events.map(event => encodeFrame(encodeStoredSessionEvent(event.stored), 65536))
  const log = Buffer.concat(frames)
  const prefix = Buffer.concat(frames.slice(0, snapshot.localPosition))
  return { sessionId: snapshot.header.sessionId, through: snapshot.localPosition, role: 'selected',
    header: { path: `sessions/${snapshot.header.sessionId}/header.frame`, byteLength: header.byteLength, sha256: experimentBytesDigest(header) },
    log: { path: `sessions/${snapshot.header.sessionId}/events.log`, byteLength: log.byteLength, sha256: experimentBytesDigest(log) },
    committedBytes: prefix.byteLength, committedSha256: experimentBytesDigest(prefix), tail: null }
}

async function fixture(count = 1, frames?: () => AsyncIterable<ModelFrame>): Promise<NormalizedCallFixture> {
  const repo = repository(); const session = await repo.create(); let starts = 0
  const provider = scripted({ script: () => frames?.() ?? textFrames(`result ${++starts} 世界`) })
  const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
  try {
    const ids = []
    for (let index = 0; index < count; index++) ids.push((await runner.invoke(request())).payload.invocationId)
    const snapshot = session.snapshot()
    const exported = exportNormalizedCallFixture({ snapshot, source: cut(snapshot), invocationIds: ids, limits })
    assert.equal(exported.status, 'supported')
    return exported.fixture
  } finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
}

function intercept(handle: SessionHandle, before: (type: string) => void): SessionHandle {
  return { get header() { return handle.header }, get status() { return handle.status }, get maxRecordBytes() { return handle.maxRecordBytes },
    supportsEventDefinition: definition => handle.supportsEventDefinition(definition), append: (definition, payload) => handle.append(definition, payload),
    appendIfPosition: (position, definition, payload) => { before(definition.type); return handle.appendIfPosition(position, definition, payload) },
    end: reason => handle.end(reason), snapshot: () => handle.snapshot(), project: projection => handle.project(projection), dispose: () => handle.dispose() }
}

describe('normalized-call fixture provenance and finite export', () => {
  it('exports exact local references, canonical result digest and immutable source usage', async () => {
    const saved = await fixture()
    const entry = saved.entries[0]!
    assert.equal(saved.format, 'normalized-call-fixture/v1')
    assert.equal(entry.prepared.address, formatSessionAddress(saved.source.sessionId))
    assert.equal(entry.prepared.eventId, formatSessionEventId(saved.source.sessionId, sessionSequence(1)))
    assert.equal(entry.started.eventId, formatSessionEventId(saved.source.sessionId, sessionSequence(2)))
    assert.equal(entry.settled.eventId, formatSessionEventId(saved.source.sessionId, sessionSequence(3)))
    assert.deepEqual(entry.result.usage, { source: 'provider', completeness: 'complete', inputTokens: 0, outputTokens: 4 })
    assert.ok(Object.isFrozen(saved.entries) && Object.isFrozen(entry.result.blocks))
    assert.deepEqual(parseNormalizedCallFixture(JSON.stringify(saved), limits), saved)
  })

  it('retains an earlier cut while the physical source has later committed events', async () => {
    const repo = repository(); const session = await repo.create(); const provider = scripted()
    const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    try {
      const first = await runner.invoke(request()); const snapshot = session.snapshot()
      await runner.invoke(request())
      const exported = exportNormalizedCallFixture({ snapshot, source: cut(snapshot, session.snapshot()), invocationIds: [first.payload.invocationId], limits })
      assert.equal(exported.status, 'supported')
      assert.ok(exported.fixture.source.log.byteLength > exported.fixture.source.committedBytes)
      assert.deepEqual(decodeNormalizedCallFixture(exported.fixture, limits), exported.fixture)
      assert.throws(() => exportNormalizedCallFixture({ snapshot, source: cut(session.snapshot()), invocationIds: [first.payload.invocationId], limits }), hasCode('EXPERIMENT_STATE_INVALID'))
    } finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })

  it('reports absent/unsettled invocations without opening or recovering a Writer', async () => {
    const repo = repository(); const session = await repo.create(); const provider = scripted()
    const invocationId = parseModelInvocationId('11111111-1111-4111-8111-111111111111')
    try {
      let snapshot = session.snapshot()
      assert.deepEqual(exportNormalizedCallFixture({ snapshot, source: cut(snapshot), invocationIds: [invocationId], limits }),
        { status: 'unsupported', invocationId, reason: 'invocation-not-found' })
      await session.append(modelPreparedEvent, { invocationId, submission: provider.prepare(request()).submission, limits: runnerLimits })
      snapshot = session.snapshot()
      assert.deepEqual(exportNormalizedCallFixture({ snapshot, source: cut(snapshot), invocationIds: [invocationId], limits }),
        { status: 'unsupported', invocationId, reason: 'invocation-unsettled' })
      assert.equal(session.snapshot().localPosition, 1)
    } finally { await provider.dispose(); await repo.dispose() }
  })

  for (const kind of ['profile', 'continuation', 'result-continuation', 'tool-call', 'failed', 'partial', 'interrupted'] as const) {
    it(`rejects ${kind} source calls explicitly`, async () => {
      const repo = repository(); const session = await repo.create(); const provider = scripted()
      const invocationId = parseModelInvocationId('11111111-1111-4111-8111-111111111111')
      const capsule = { namespace: 'example', version: 1, providerId: 'scripted', model: 'fixture-model', text: 'state' }
      const input: ModelRequest = kind === 'profile' ? { ...request(), profile: { namespace: 'example', version: 1, options: {} } }
        : kind === 'continuation' ? { ...request(), messages: [{ role: 'assistant', content: [{ kind: 'text', text: 'old' }], continuation: capsule }] }
          : kind === 'tool-call' ? { ...request(), tools: [tool] } : request()
      const descriptor = { ...provider.descriptor, support: { ...provider.descriptor.support, profiles: ['example@1'], continuations: ['example@1'] } }
      const result: NormalizedModelResult = { reportedModel: 'fixture-model', responseId: 'source',
        blocks: kind === 'result-continuation' ? [{ kind: 'continuation', index: 0, capsule, complete: true }]
          : kind === 'tool-call' ? [{ kind: 'tool-call', index: 0, callId: 'tool-1', name: tool.name, argumentsText: '{}', argumentsStatus: 'valid-json', advertisement: 'advertised', complete: true }]
          : [{ kind: 'text', index: 0, text: 'source', complete: kind !== 'partial' && kind !== 'interrupted' }],
        usage: { source: 'provider', completeness: 'unknown' }, protocolComplete: kind !== 'partial' && kind !== 'interrupted',
        stopReason: kind === 'partial' || kind === 'interrupted' ? null : kind === 'tool-call' ? 'tool-calls' : 'stop' }
      try {
        const submission = createPreparedSubmission(input, descriptor, input)
        const prepared = await session.append(modelPreparedEvent, { invocationId, submission, limits: runnerLimits })
        await session.append(modelStartedEvent, { invocationId, preparedEventId: prepared.stored.eventId, fingerprint: submission.fingerprint })
        await session.append(modelSettledEvent, { invocationId, outcome: kind === 'failed' ? 'failed' : kind === 'partial' ? 'incomplete' : kind === 'interrupted' ? 'interrupted' : 'completed',
          external: 'response-observed', result, cleanup: kind === 'interrupted' ? { status: 'unknown-after-process-loss', failedResources: null } : { status: 'complete', failedResources: 0 } })
        const snapshot = session.snapshot()
        const exported = exportNormalizedCallFixture({ snapshot, source: cut(snapshot), invocationIds: [invocationId], limits })
        assert.equal(exported.status, 'unsupported')
        assert.equal(exported.reason, kind === 'profile' ? 'request-profile' : kind === 'continuation' ? 'request-continuation'
          : kind === 'tool-call' || kind === 'result-continuation' ? 'non-text-output' : 'non-successful-call')
      } finally { await provider.dispose(); await repo.dispose() }
    })
  }

  it('rejects closed-format changes, corrupt result digests and byte/entry budgets before replay', async () => {
    const saved = await fixture(2)
    assert.throws(() => parseNormalizedCallFixture(JSON.stringify(saved), { ...limits, maxFixtureBytes: 8 }), hasCode('EXPERIMENT_LIMIT_EXCEEDED'))
    assert.throws(() => decodeNormalizedCallFixture(saved, { ...limits, maxFixtureEntries: 1 }), hasCode('EXPERIMENT_INPUT_INVALID'))
    assert.throws(() => decodeNormalizedCallFixture({ ...saved, wireStream: [] }, limits), hasCode('EXPERIMENT_INPUT_INVALID'))
    const entry = saved.entries[0]!
    assert.throws(() => decodeNormalizedCallFixture({ ...saved, entries: [{ ...entry, resultSha256: '0'.repeat(64) }] }, limits), hasCode('EXPERIMENT_INPUT_INVALID'))
    assert.throws(() => decodeNormalizedCallFixture({ ...saved, entries: [{ ...entry, request: { ...entry.request, profile: { namespace: 'example', version: 1, options: {} } } }] }, limits), hasCode('EXPERIMENT_INPUT_INVALID'))
    assert.throws(() => decodeNormalizedCallFixture({ ...saved, entries: [{ ...entry, settled: entry.prepared }] }, limits), hasCode('EXPERIMENT_INPUT_INVALID'))
  })
})

describe('normalized-call fixture replay through SessionModelRunner', () => {
  it('replays multiple text blocks under a new binding, without charging original usage', async () => {
    const saved = await fixture(1, async function* () {
      yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'remote-original' }
      for (const [index, text] of ['hello', ' 世界'].entries()) {
        yield { kind: 'block-start', index, block: 'text' }; yield { kind: 'text-delta', index, text }; yield { kind: 'block-end', index }
      }
      yield { kind: 'usage', counts: { inputTokens: 30, outputTokens: 20 } }; yield { kind: 'complete', stopReason: 'stop' }
    })
    const replay = createNormalizedCallFixtureReplay({ fixture: saved, providerId: 'normalized-test', streamLimits })
    const repo = repository(); const session = await repo.create()
    const runner = new SessionModelRunner({ session, provider: replay.provider, limits: runnerLimits })
    try {
      const outcome = await runner.invoke({ maxOutputTokens: 64, tools: [], messages: request().messages, instructions: ['Be exact.'], model: 'fixture-model' })
      assert.equal(outcome.payload.outcome, 'completed')
      assert.deepEqual(outcome.payload.result.blocks, saved.entries[0]!.result.blocks)
      assert.deepEqual(outcome.payload.result.usage, { source: 'provider', completeness: 'unknown' })
      assert.notEqual(outcome.payload.result.responseId, saved.entries[0]!.result.responseId)
      const invocation = runner.snapshot().invocations[0]!
      assert.notEqual(invocation.prepared.payload.submission.fingerprint, saved.entries[0]!.preparedFingerprint)
      assert.equal(invocation.prepared.payload.submission.binding.protocol, 'scripted')
      assert.deepEqual(replay.finish('completed'), { total: 1, consumed: 1, remaining: [] })
    } finally { await runner.dispose(); await replay.provider.dispose(); await repo.dispose() }
  })

  it('changed requests and exhausted scripts fail without consuming or calling another Provider', async () => {
    const saved = await fixture(); const replay = createNormalizedCallFixtureReplay({ fixture: saved, providerId: 'normalized-test', streamLimits })
    const repo = repository(); const session = await repo.create(); const runner = new SessionModelRunner({ session, provider: replay.provider, limits: runnerLimits })
    try {
      await assert.rejects(runner.invoke({ ...request(), instructions: ['Changed'] }), hasCode('MODEL_BINDING_MISMATCH'))
      assert.equal(session.snapshot().localPosition, 0); assert.equal(replay.snapshot().consumed, 0)
      await runner.invoke(request())
      await assert.rejects(runner.invoke(request()), hasCode('MODEL_BINDING_MISMATCH'))
      assert.equal(session.snapshot().localPosition, 3); assert.equal(replay.snapshot().consumed, 1)
    } finally { await runner.dispose(); await replay.provider.dispose(); await repo.dispose() }
  })

  it('a prepared binding cancelled before exchange.start remains unconsumed', async () => {
    const saved = await fixture(); const replay = createNormalizedCallFixtureReplay({ fixture: saved, providerId: 'normalized-test', streamLimits })
    const abort = new AbortController(); const binding = replay.provider.prepare(request())
    const exchange = await binding.acquire(binding.submission, abort.signal)
    try {
      abort.abort()
      assert.throws(() => exchange.start(), hasCode('MODEL_CALL_CANCELLED'))
      assert.equal(replay.snapshot().consumed, 0)
      assert.equal(replay.finish('cancelled').remaining.length, 1)
    } finally { await exchange.close(); await replay.provider.dispose() }
  })

  it('cancellation after the committed start intent but before start does not consume', async () => {
    const saved = await fixture(); const replay = createNormalizedCallFixtureReplay({ fixture: saved, providerId: 'normalized-test', streamLimits })
    const abort = new AbortController(); const repo = repository(); const session = await repo.create()
    const runner = new SessionModelRunner({ session: intercept(session, type => { if (type === modelStartedEvent.type) abort.abort() }), provider: replay.provider, limits: runnerLimits })
    try {
      const settlement = await runner.invoke(request(), { signal: abort.signal })
      assert.equal(settlement.payload.outcome, 'cancelled'); assert.equal(settlement.payload.external, 'not-issued')
      assert.equal(replay.snapshot().consumed, 0)
      assert.equal(runner.snapshot().invocations[0]!.state, 'settled')
    } finally { await runner.dispose(); await replay.provider.dispose(); await repo.dispose() }
  })

  for (const phase of [modelPreparedEvent.type, modelStartedEvent.type]) it(`unknown ${phase} acceptance does not consume and a fresh Runner can use the same entry`, async () => {
    const saved = await fixture(); const replay = createNormalizedCallFixtureReplay({ fixture: saved, providerId: 'normalized-test', streamLimits })
    const repo = repository(); const session = await repo.create()
    const runner = new SessionModelRunner({ session: intercept(session, type => { if (type === phase) throw new SessionError('SESSION_APPEND_OUTCOME_UNKNOWN', 'injected') }), provider: replay.provider, limits: runnerLimits })
    let fresh: SessionModelRunner | undefined
    try {
      await assert.rejects(runner.invoke(request()), hasCode('MODEL_JOURNAL_COMMIT_UNKNOWN'))
      assert.equal(replay.snapshot().consumed, 0)
      fresh = new SessionModelRunner({ session: await repo.create(), provider: replay.provider, limits: runnerLimits })
      assert.equal((await fresh.invoke(request())).payload.outcome, 'completed')
      assert.equal(replay.snapshot().consumed, 1)
    } finally { await fresh?.dispose(); await runner.dispose().catch(() => undefined); await replay.provider.dispose(); await repo.dispose() }
  })

  it('a started call consumes its entry even when the explicit frame budget prevents completion', async () => {
    const saved = await fixture(2); const replay = createNormalizedCallFixtureReplay({ fixture: saved, providerId: 'normalized-test', streamLimits: { ...streamLimits, maxFrames: 1 } })
    const repo = repository(); const session = await repo.create(); const runner = new SessionModelRunner({ session, provider: replay.provider, limits: runnerLimits })
    try {
      const outcome = await runner.invoke(request())
      assert.equal(outcome.payload.outcome, 'incomplete')
      assert.equal(outcome.payload.failure?.code, 'MODEL_LIMIT_EXCEEDED')
      assert.deepEqual(replay.finish('failed'), { total: 2, consumed: 1, remaining: [saved.entries[1]!.invocationId] })
    } finally { await runner.dispose(); await replay.provider.dispose(); await repo.dispose() }
  })

  it('equal requests bind the next text result only after actual start consumption', async () => {
    const saved = await fixture(2); const replay = createNormalizedCallFixtureReplay({ fixture: saved, providerId: 'normalized-test', streamLimits })
    const repo = repository(); const session = await repo.create(); const runner = new SessionModelRunner({ session, provider: replay.provider, limits: runnerLimits })
    try {
      for (let index = 0; index < 2; index++) {
        assert.equal(replay.snapshot().consumed, index)
        assert.deepEqual((await runner.invoke(request())).payload.result.blocks, saved.entries[index]!.result.blocks)
      }
      assert.equal(replay.finish('completed').remaining.length, 0)
    } finally { await runner.dispose(); await replay.provider.dispose(); await repo.dispose() }
  })

  it('leftover entries reject normal success but preserve cancellation/failure classifications', async () => {
    const saved = await fixture(2); const replay = createNormalizedCallFixtureReplay({ fixture: saved, providerId: 'normalized-test', streamLimits })
    try {
      assert.throws(() => replay.finish('completed'), hasCode('EXPERIMENT_STATE_INVALID'))
      for (const outcome of ['cancelled', 'timed-out', 'failed', 'result-unknown', 'interrupted'] as const) {
        assert.deepEqual(replay.finish(outcome), { total: 2, consumed: 0, remaining: saved.entries.map(entry => entry.invocationId) })
      }
    } finally { await replay.provider.dispose() }
  })
})
