import { strict as assert } from 'node:assert'
import { SessionModelRunner } from '../../src/model/runner.js'
import { createDeepSeekModelProvider } from '../../src/model/providers/deepseek.js'
import { createAnthropicModelProvider } from '../../src/model/providers/anthropic.js'
import { readServerSentEvents } from '../../src/model/providers/http/sse.js'
import { encodeModelWireBody } from '../../src/model/submission.js'
import { anthropicText, deepSeekText, deferred, hasCode, httpFixture, repository, request, runnerLimits, sse, streamLimits, tool } from './fixtures.js'
import type { RegisterCase } from './fixtures.js'
import type { ModelRequest } from '../../src/model/contract.js'

const adapters = [
  { name: 'DeepSeek', create: createDeepSeekModelProvider, fixture: deepSeekText },
  { name: 'Anthropic', create: createAnthropicModelProvider, fixture: anthropicText },
]

export function protocolCases(test: RegisterCase): void {
  for (const adapter of adapters) {
    test(`S6-02/23/32/45/46/48: ${adapter.name} real HTTP, exact committed bytes and tail usage`, async () => {
      const fixture = await httpFixture(response => { response.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': 'safe-request-id' }); for (const byte of Buffer.from(adapter.fixture())) response.write(Buffer.from([byte])); response.end() })
      const repo = repository(); const provider = adapter.create({ providerId: 'http-fixture', endpoint: fixture.endpoint, apiKey: 'private-fixture-key', maxConcurrentExchanges: 1, streamLimits })
      const session = await repo.create(); const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
      try {
        const result = await runner.invoke(request()); assert.equal(result.payload.outcome, 'completed'); assert.equal(result.payload.result.usage.inputTokens, 3); assert.equal(result.payload.result.usage.outputTokens, 5)
        assert.equal(result.payload.result.usage.completeness, 'complete'); assert.equal(result.payload.result.requestId, 'safe-request-id')
        const block = result.payload.result.blocks[0]; assert.ok(block?.kind === 'text'); assert.equal(block.text, '你好')
        const prepared = runner.snapshot().invocations[0]?.prepared.payload.submission; assert.ok(prepared)
        assert.deepEqual(fixture.requests[0]?.body, Buffer.from(encodeModelWireBody(prepared)))
        assert.ok(!JSON.stringify(session.snapshot()).includes('private-fixture-key'))
        assert.equal(fixture.requests.length, 1)
        if (adapter.name === 'DeepSeek') assert.deepEqual(prepared.wireBody.thinking, { type: 'disabled' })
      } finally { await runner.dispose(); await provider.dispose(); await repo.dispose(); await fixture.close() }
    })
    test(`S6-30: ${adapter.name} EOF without its terminal is failed, not complete text`, async () => {
      const fixture = await httpFixture(response => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(adapter.fixture().replace(adapter.name === 'DeepSeek' ? sse('', '[DONE]') : sse('message_stop', { type: 'message_stop' }), '')) })
      const repo = repository(); const provider = adapter.create({ providerId: 'fixture', endpoint: fixture.endpoint, apiKey: 'fixture-key', maxConcurrentExchanges: 1, streamLimits })
      const runner = new SessionModelRunner({ session: await repo.create(), provider, limits: runnerLimits })
      try { const result = await runner.invoke(request()); assert.equal(result.payload.outcome, 'failed'); assert.equal(result.payload.result.protocolComplete, false); assert.equal(result.payload.failure?.code, 'MODEL_PROTOCOL_INVALID') }
      finally { await runner.dispose(); await provider.dispose(); await repo.dispose(); await fixture.close() }
    })
    for (const status of [401, 429, 503, 302]) {
      test(`S6-47/48: ${adapter.name} HTTP ${status} is not retried or redirected`, async () => {
        const fixture = await httpFixture(response => { response.writeHead(status, { location: 'https://do-not-follow.invalid/secret', 'content-type': 'text/plain' }); response.end('private-fixture-key') })
        const repo = repository(); const provider = adapter.create({ providerId: 'fixture', endpoint: fixture.endpoint, apiKey: 'private-fixture-key', maxConcurrentExchanges: 1, streamLimits })
        const session = await repo.create(); const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
        try { const result = await runner.invoke(request()); assert.equal(result.payload.outcome, 'failed'); assert.equal(result.payload.failure?.httpStatus, status); assert.equal(result.payload.failure?.retryable, status === 429 || status >= 500); assert.equal(fixture.requests.length, 1); assert.ok(!JSON.stringify(session.snapshot()).includes('private-fixture-key')) }
        finally { await runner.dispose(); await provider.dispose(); await repo.dispose(); await fixture.close() }
      })
    }
  }
  test('S6-23/58: every UTF-8 and CRLF split, coalescing and multiline data decode identically', async () => {
    const bytes = Buffer.from(': ping\r\nevent: message\r\ndata: 中文🌍\r\ndata: next\r\n\r\n')
    const expected = [{ event: 'message', data: '中文🌍\nnext' }]
    for (let split = 0; split <= bytes.length; split++) {
      const source = (async function* () { yield bytes.subarray(0, split); yield bytes.subarray(split) })()
      const actual = []; for await (const record of readServerSentEvents(source, streamLimits)) actual.push(record)
      assert.deepEqual(actual, expected)
    }
    const actual = []; for await (const record of readServerSentEvents((async function* () { for (const byte of bytes) yield Buffer.from([byte]) })(), streamLimits)) actual.push(record)
    assert.deepEqual(actual, expected)
  })
  for (const [name, bytes, limits] of [
    ['invalid UTF-8', Buffer.from([0xff]), streamLimits],
    ['incomplete event', Buffer.from('data: pending'), streamLimits],
    ['line limit', Buffer.from(`:${'a'.repeat(100)}\n\n`), { ...streamLimits, maxFrameBytes: 16 }],
    ['stream limit', Buffer.from(':a\n\n'.repeat(100)), { ...streamLimits, maxStreamBytes: 32 }],
    ['ping count', Buffer.from(':a\n\n'.repeat(5)), { ...streamLimits, maxFrames: 2 }],
  ] as const) {
    test(`S6-31/33: SSE ${name} fails within a receive budget`, async () => {
      await assert.rejects(async () => { for await (const _ of readServerSentEvents((async function* () { yield bytes })(), limits)) { /* fully consume */ } }, hasCode(name.startsWith('invalid') || name.startsWith('incomplete') ? 'MODEL_PROTOCOL_INVALID' : 'MODEL_LIMIT_EXCEEDED'))
    })
  }
  test('S6-29: finish is not complete before tail usage and protocol termination', async () => {
    const atTail = deferred(); const release = deferred()
    const wire = deepSeekText(); const tail = wire.lastIndexOf('data: [DONE]')
    const fixture = await httpFixture(response => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(wire.slice(0, tail)); atTail.resolve(); void release.promise.then(() => response.end(wire.slice(tail))) })
    const repo = repository(); const provider = createDeepSeekModelProvider({ providerId: 'fixture', endpoint: fixture.endpoint, apiKey: 'key', maxConcurrentExchanges: 1, streamLimits })
    const session = await repo.create(); const runner = new SessionModelRunner({ session, provider, limits: runnerLimits }); const pending = runner.invoke(request())
    try { await atTail.promise; assert.equal(session.snapshot().localPosition, 2); release.resolve(); assert.equal((await pending).payload.result.usage.outputTokens, 5) }
    finally { release.resolve(); await pending; await runner.dispose(); await provider.dispose(); await repo.dispose(); await fixture.close() }
  })
  test('S6-17: HTTP abort closes the actual request and preserves cancelled outcome', async () => {
    const entered = deferred(); const fixture = await httpFixture(response => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': connected\n\n'); entered.resolve() })
    const repo = repository(); const provider = createDeepSeekModelProvider({ providerId: 'fixture', endpoint: fixture.endpoint, apiKey: 'key', maxConcurrentExchanges: 1, streamLimits }); const abort = new AbortController()
    const runner = new SessionModelRunner({ session: await repo.create(), provider, limits: runnerLimits }); const pending = runner.invoke(request(), { signal: abort.signal })
    try { await entered.promise; abort.abort(); const result = await pending; assert.equal(result.payload.outcome, 'cancelled'); assert.equal(result.payload.cleanup.status, 'complete'); assert.equal(fixture.requests.length, 1) }
    finally { abort.abort(); await pending; await runner.dispose(); await provider.dispose(); await repo.dispose(); await fixture.close() }
  })
  test('S6-25/43/44: thinking continuation and interleaved tool arguments survive two HTTP invocations', async () => {
    const chunk = (delta: object, finish: string | null = null) => sse('', { id: 'ds-tools', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finish }] })
    const wire = chunk({ role: 'assistant', reasoning_content: '有限推理' })
      + chunk({ tool_calls: [{ index: 0, id: 'a', type: 'function', function: { name: 'lookup', arguments: '{"query":' } }, { index: 1, id: 'b', type: 'function', function: { name: 'lookup', arguments: '{"query":' } }] })
      + chunk({ tool_calls: [{ index: 1, function: { arguments: '"B"}' } }, { index: 0, function: { arguments: '"A"}' } }] }, 'tool_calls') + sse('', '[DONE]')
    const fixture = await httpFixture((response, count) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(count === 1 ? wire : deepSeekText()) })
    const repo = repository(); const provider = createDeepSeekModelProvider({ providerId: 'fixture', endpoint: fixture.endpoint, apiKey: 'key', maxConcurrentExchanges: 1, streamLimits })
    const session = await repo.create(); const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    const input: ModelRequest = { ...request(), tools: [tool], profile: { namespace: 'deepseek.chat', version: 1, options: { thinking: 'enabled' } } }
    try {
      const first = await runner.invoke(input); assert.equal(first.payload.outcome, 'completed')
      const [reasoning, a, b] = first.payload.result.blocks
      assert.ok(reasoning?.kind === 'continuation' && a?.kind === 'tool-call' && b?.kind === 'tool-call')
      assert.equal(a.argumentsText, '{"query":"A"}'); assert.equal(b.argumentsText, '{"query":"B"}')
      const sourceA = { invocationId: first.payload.invocationId, outputBlockIndex: a.index }; const sourceB = { invocationId: first.payload.invocationId, outputBlockIndex: b.index }
      const continued: ModelRequest = { ...input, messages: [...input.messages,
        { role: 'assistant', continuation: reasoning.capsule, content: [
          { kind: 'tool-call', callId: a.callId, name: a.name, argumentsText: a.argumentsText, source: sourceA },
          { kind: 'tool-call', callId: b.callId, name: b.name, argumentsText: b.argumentsText, source: sourceB },
        ] }, { role: 'user', content: [
          { kind: 'tool-result', callId: a.callId, source: sourceA, result: 'A-result', isError: false },
          { kind: 'tool-result', callId: b.callId, source: sourceB, result: 'B-error', isError: true },
        ] }] }
      await runner.invoke(continued)
      const sent = JSON.parse(fixture.requests[1]?.body.toString() ?? '{}')
      assert.equal(sent.messages[2].reasoning_content, reasoning.capsule.text)
      assert.equal(JSON.parse(sent.messages[4].content).isError, true)
      const anthropic = createAnthropicModelProvider({ providerId: 'other', endpoint: fixture.endpoint, apiKey: 'key', maxConcurrentExchanges: 1, streamLimits })
      try { assert.throws(() => anthropic.prepare(continued), hasCode('MODEL_FEATURE_UNSUPPORTED')) } finally { await anthropic.dispose() }
    } finally { await runner.dispose(); await provider.dispose(); await repo.dispose(); await fixture.close() }
  })
  test('S6-28/31/45: Anthropic stream errors and fallback blocks fail through real adapter', async () => {
    for (const suffix of [sse('error', { type: 'error', error: { type: 'overloaded_error', message: 'secret-service-error' } }),
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'fallback', model: 'other-model' } })]) {
      const initial = anthropicText().split('event: content_block_start')[0]
      const fixture = await httpFixture(response => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(initial + suffix) })
      const repo = repository(); const provider = createAnthropicModelProvider({ providerId: 'fixture', endpoint: fixture.endpoint, apiKey: 'key', maxConcurrentExchanges: 1, streamLimits })
      const runner = new SessionModelRunner({ session: await repo.create(), provider, limits: runnerLimits })
      try { const event = await runner.invoke(request()); assert.equal(event.payload.outcome, 'failed'); assert.ok(!JSON.stringify(event).includes('secret-service-error')) }
      finally { await runner.dispose(); await provider.dispose(); await repo.dispose(); await fixture.close() }
    }
  })
  test('S6-08/44/48: unsafe endpoint and silently ignored controls reject before HTTP', async () => {
    assert.throws(() => createDeepSeekModelProvider({ providerId: 'fixture', endpoint: 'https://user:secret@example.invalid/api', apiKey: 'key', maxConcurrentExchanges: 1, streamLimits }), hasCode('MODEL_REQUEST_INVALID'))
    const provider = createDeepSeekModelProvider({ providerId: 'fixture', endpoint: 'https://example.invalid/api', apiKey: 'key', maxConcurrentExchanges: 1, streamLimits })
    try {
      assert.throws(() => provider.prepare({ ...request(), topP: 0.5 }), hasCode('MODEL_FEATURE_UNSUPPORTED'))
      assert.throws(() => provider.prepare({ ...request(), temperature: 0.5, profile: { namespace: 'deepseek.chat', version: 1, options: { thinking: 'enabled' } } }), hasCode('MODEL_FEATURE_UNSUPPORTED'))
    } finally { await provider.dispose() }
  })
}
