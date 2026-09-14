import { strict as assert } from 'node:assert'
import { SessionModelRunner } from '../../src/model/runner.js'
import { createAnthropicModelProvider } from '../../src/model/providers/anthropic.js'
import { createDeepSeekModelProvider } from '../../src/model/providers/deepseek.js'
import { decodeDeepSeekStream } from '../../src/model/providers/deepseek/stream.js'
import { decodeAnthropicStream } from '../../src/model/providers/anthropic/stream.js'
import { readServerSentEvents } from '../../src/model/providers/http/sse.js'
import type { ModelExchange, ModelFrame, ModelRequest } from '../../src/model/contract.js'
import { anthropicText, deepSeekText, deferred, hasCode, httpFixture, repository, request, runnerLimits, scripted, sse, streamLimits, tool } from './fixtures.js'
import type { RegisterCase } from './fixtures.js'

export function transportToolsCases(test: RegisterCase): void {
  for (const parameters of ['{"query":"中文"}', '{}', '{invalid']) {
    test(`S6-26/45: Anthropic tool JSON ${parameters} goes through actual HTTP normalization`, async () => {
      const start = anthropicText().split('event: content_block_start')[0]
      const jsonDeltas = parameters === '{}' ? '' : Array.from(parameters).map(character => sse('content_block_delta', {
        type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: character },
      })).join('')
      const wire = start
        + sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-1', name: 'lookup', input: {} } })
        + jsonDeltas
        + sse('content_block_stop', { type: 'content_block_stop', index: 0 })
        + sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 7 } })
        + sse('message_stop', { type: 'message_stop' })
      const fixture = await httpFixture((response, count) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(count === 1 ? wire : anthropicText())
      })
      const repo = repository()
      const provider = createAnthropicModelProvider({ providerId: 'anthropic-fixture', endpoint: fixture.endpoint, apiKey: 'key', maxConcurrentExchanges: 1, streamLimits })
      const runner = new SessionModelRunner({ session: await repo.create(), provider, limits: runnerLimits })
      try {
        const input: ModelRequest = { ...request(), tools: [tool] }
        const result = await runner.invoke(input)
        assert.equal(result.payload.outcome, 'completed')
        const block = result.payload.result.blocks[0]
        assert.ok(block?.kind === 'tool-call')
        assert.equal(block.argumentsText, parameters)
        assert.equal(block.argumentsStatus, parameters === '{invalid' ? 'invalid-json' : 'valid-json')
        assert.equal(result.payload.result.usage.outputTokens, 7)
        if (block.argumentsStatus === 'valid-json') {
          const source = { invocationId: result.payload.invocationId, outputBlockIndex: block.index }
          await runner.invoke({ ...input, messages: [...input.messages,
            { role: 'assistant', content: [{ kind: 'tool-call', callId: block.callId, name: block.name, argumentsText: block.argumentsText, source }] },
            { role: 'user', content: [{ kind: 'tool-result', callId: block.callId, source, result: { denied: true }, isError: true }] },
          ] })
          const sent = JSON.parse(fixture.requests[1]?.body.toString() ?? '{}')
          assert.deepEqual(sent.messages[1].content[0].input, JSON.parse(parameters))
          assert.equal(sent.messages[2].content[0].is_error, true)
          assert.equal(sent.messages[2].content[0].tool_use_id, 'call-1')
        }
      } finally { await runner.dispose(); await provider.dispose(); await repo.dispose(); await fixture.close() }
    })
  }

  for (const create of [createDeepSeekModelProvider, createAnthropicModelProvider]) {
    test(`S6-17/47: ${create.name} abort before response headers releases the actual socket`, async () => {
      const entered = deferred()
      const fixture = await httpFixture(() => entered.resolve())
      const provider = create({ providerId: 'fixture', endpoint: fixture.endpoint, apiKey: 'key', maxConcurrentExchanges: 1, streamLimits })
      const repo = repository(); const controller = new AbortController()
      const runner = new SessionModelRunner({ session: await repo.create(), provider, limits: runnerLimits })
      const pending = runner.invoke(request(), { signal: controller.signal })
      try {
        await entered.promise
        controller.abort()
        const result = await pending
        assert.equal(result.payload.outcome, 'cancelled')
        assert.equal(result.payload.cleanup.status, 'complete')
        assert.equal(fixture.requests.length, 1)
      } finally { controller.abort(); await pending; await runner.dispose(); await provider.dispose(); await repo.dispose(); await fixture.close() }
    })
  }

  for (const adapter of [
    { name: 'DeepSeek', create: createDeepSeekModelProvider, decode: decodeDeepSeekStream, wire: deepSeekText },
    { name: 'Anthropic', create: createAnthropicModelProvider, decode: decodeAnthropicStream, wire: anthropicText },
  ]) {
    test(`S6-18/29: ${adapter.name} valid terminal is normalized before the transport EOF`, async () => {
      const atEof = deferred(); const release = deferred()
      const provider = adapter.create({ providerId: 'fixture', endpoint: 'https://example.invalid/model', apiKey: 'key', maxConcurrentExchanges: 1, streamLimits })
      const input = provider.prepare(request()).submission
      const source = (async function* () { yield Buffer.from(adapter.wire()); atEof.resolve(); await release.promise })()
      const frames = adapter.decode(readServerSentEvents(source, streamLimits), input)[Symbol.asyncIterator]()
      try {
        for (;;) {
          const item = await frames.next()
          assert.equal(item.done, false)
          if (item.value?.kind === 'complete') break
        }
        const tail = frames.next()
        await atEof.promise
        release.resolve()
        assert.equal((await tail).done, true)
      } finally { release.resolve(); await frames.return?.(undefined); await provider.dispose() }
    })
    test(`S6-24/30: ${adapter.name} illegal content after terminal preserves evidence but fails the invocation`, async () => {
      const fixture = await httpFixture(response => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(adapter.wire() + sse('', { invalid: true })) })
      const provider = adapter.create({ providerId: 'fixture', endpoint: fixture.endpoint, apiKey: 'key', maxConcurrentExchanges: 1, streamLimits })
      const repo = repository(); const runner = new SessionModelRunner({ session: await repo.create(), provider, limits: runnerLimits })
      try {
        const result = await runner.invoke(request())
        assert.equal(result.payload.outcome, 'failed')
        assert.equal(result.payload.result.protocolComplete, true)
        assert.equal(result.payload.failure?.code, 'MODEL_PROTOCOL_INVALID')
      } finally { await runner.dispose(); await provider.dispose(); await repo.dispose(); await fixture.close() }
    })
  }

  test('S6-21: iterator-return failure does not skip the remaining exchange release', async () => {
    const entered = deferred(); const releaseRead = deferred(); const abort = new AbortController()
    let returned = 0; let closed = 0
    const source: AsyncIterable<ModelFrame> = {
      [Symbol.asyncIterator]: () => ({
        next: async () => { entered.resolve(); await releaseRead.promise; return { done: false, value: { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'r' } as ModelFrame } },
        return: async () => { returned++; throw new Error('private cleanup failure') },
      }),
    }
    // Cancel a pending next(), then fail iterator.return() during the unwind.
    const provider = scripted({ script: () => source, onClose: () => { closed++ } })
    const repo = repository(); const runner = new SessionModelRunner({ session: await repo.create(), provider, limits: runnerLimits })
    const pending = runner.invoke(request(), { signal: abort.signal }); void pending.catch(() => undefined)
    try {
      await entered.promise; abort.abort(); releaseRead.resolve()
      await assert.rejects(pending, hasCode('MODEL_CLEANUP_FAILED'))
      assert.equal(returned, 1); assert.equal(closed, 1)
      const entry = runner.snapshot().invocations[0]
      assert.ok(entry?.state === 'settled')
      assert.equal(entry.settled.payload.cleanup.status, 'incomplete')
    } finally { releaseRead.resolve(); await pending.catch(() => undefined); await runner.dispose().catch(() => undefined); await provider.dispose().catch(() => undefined); await repo.dispose() }
  })

  test('S6-22: an exchange cannot await its own start/read through close', async () => {
    let exchange: ModelExchange | undefined
    const provider = scripted({ script: async () => {
      assert.ok(exchange)
      await assert.rejects(exchange.close(), hasCode('MODEL_REENTRANT_WAIT'))
      return (async function* () { /* cancellation leaves no output */ })()
    } })
    const bound = provider.prepare(request())
    exchange = await bound.acquire(bound.submission, new AbortController().signal)
    try { await exchange.start(); await exchange.close() }
    finally { await exchange.close(); await provider.dispose() }
  })
}
