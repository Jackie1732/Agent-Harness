import { setImmediate } from 'node:timers/promises'
import { queryObjects } from 'node:v8'
import { expect, it } from 'vitest'
import type { ModelFrame } from '../../src/model/contract.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import { createAnthropicModelProvider } from '../../src/model/providers/anthropic.js'
import { createDeepSeekModelProvider } from '../../src/model/providers/deepseek.js'
import { ModelHttpClient } from '../../src/model/providers/http/request.js'
import { anthropicText, deepSeekText, deferred, httpFixture, request, streamLimits, textFrames } from './fixtures.js'

class Resource { readonly value = 'callback-owned-resource' }

async function closedProvider() {
  const resource = new Resource()
  const provider = new ScriptedModelProvider({ providerId: 'retirement', streamLimits, maxConcurrentExchanges: 1,
    script: () => textFrames(resource.value),
  })
  const prepared = provider.prepare(request())
  await provider.dispose()
  return { provider, prepared, ref: new WeakRef(resource) }
}

async function closedExchange(fail: boolean, partial: boolean) {
  const resource = new Resource()
  const provider = new ScriptedModelProvider({ providerId: 'retirement', streamLimits, maxConcurrentExchanges: 1,
    script: () => textFrames(resource.value), onClose: () => { if (fail) throw new Error(resource.value) },
  })
  const prepared = provider.prepare(request())
  const caller = new AbortController()
  caller.signal.addEventListener('abort', () => { void resource.value })
  const exchange = await prepared.acquire(prepared.submission, caller.signal)
  const stream = await exchange.start()
  if (partial) await stream[Symbol.asyncIterator]().next()
  else for await (const frame of stream) void frame
  const close = exchange.close()
  await close.catch(() => undefined)
  await provider.dispose().catch(() => undefined)
  return { exchange, stream, close, refs: {
    resource: new WeakRef(resource), provider: new WeakRef(provider), signal: new WeakRef(caller.signal),
  } }
}

async function collect(): Promise<void> {
  await setImmediate()
  queryObjects(Resource, { format: 'count' })
}

it('retires Provider callbacks while its descriptor and unused prepared binding remain observable', async () => {
  const { provider, prepared, ref } = await closedProvider()
  await collect()
  expect(ref.deref()).toBeUndefined()
  expect(Object.isFrozen(provider.descriptor)).toBe(true)
  expect(provider.descriptor.providerId).toBe('retirement')
  expect(provider.dispose()).toBe(provider.dispose())
  expect(() => provider.prepare(request())).toThrowError(expect.objectContaining({ code: 'MODEL_PROVIDER_INACTIVE' }))
  await expect(prepared.acquire(prepared.submission, new AbortController().signal)).rejects.toMatchObject({ code: 'MODEL_PROVIDER_INACTIVE' })
})

it.each([[false, false], [true, false], [false, true]])(
  'retires closed Exchange borrows with failed cleanup=%s and partially read stream=%s', async (fail, partial) => {
    const { exchange, stream, close, refs } = await closedExchange(fail, partial)
    await collect()
    expect(Object.fromEntries(Object.entries(refs).map(([key, ref]) => [key, ref.deref() !== undefined]))).toEqual({
      resource: false, provider: false, signal: false,
    })
    expect(exchange.close()).toBe(close)
    expect(() => exchange.start()).toThrowError(expect.objectContaining({ code: 'MODEL_STATE_INVALID' }))
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: 'MODEL_PROVIDER_INACTIVE' })
    if (fail) await expect(close).rejects.toMatchObject({ code: 'MODEL_CLEANUP_FAILED', details: { failedResources: 1 } })
    else await close
  },
)

it('keeps Provider and Exchange resources until the admitted pull and close settle', async () => {
  const entered = deferred(), releaseRead = deferred(), closing = deferred(), releaseClose = deferred()
  let reads = 0, releases = 0
  const provider = new ScriptedModelProvider({ providerId: 'drain', streamLimits, maxConcurrentExchanges: 1,
    script: async function* (_submission, signal): AsyncGenerator<ModelFrame> {
      const release = (): void => { reads++ }
      signal.addEventListener('abort', release, { once: true })
      try { entered.resolve(); await releaseRead.promise; yield* textFrames() }
      finally { signal.removeEventListener('abort', release) }
    },
    onClose: async () => { releases++; closing.resolve(); await releaseClose.promise },
  })
  const prepared = provider.prepare(request())
  const exchange = await prepared.acquire(prepared.submission, new AbortController().signal)
  const stream = await exchange.start()
  const read = stream[Symbol.asyncIterator]().next()
  const finish = { exchange: false, provider: false }
  try {
    await entered.promise
    const dispose = provider.dispose()
    const close = exchange.close()
    void dispose.then(() => { finish.provider = true })
    void close.then(() => { finish.exchange = true })
    expect(exchange.close()).toBe(close)
    expect(provider.dispose()).toBe(dispose)
    expect(reads).toBe(1)
    expect(releases).toBe(0)
    expect(finish).toEqual({ exchange: false, provider: false })
    releaseRead.resolve()
    expect((await read).done).toBe(false)
    await closing.promise
    expect(releases).toBe(1)
    expect(finish).toEqual({ exchange: false, provider: false })
    releaseClose.resolve()
    await close; await dispose
    expect(finish).toEqual({ exchange: true, provider: true })
  } finally {
    releaseRead.resolve(); releaseClose.resolve()
    await read.catch(() => undefined)
    await exchange.close(); await provider.dispose()
  }
})

for (const adapter of [
  { name: 'DeepSeek', create: createDeepSeekModelProvider, fixture: deepSeekText },
  { name: 'Anthropic', create: createAnthropicModelProvider, fixture: anthropicText },
]) {
  it(`${adapter.name} retires its socket-pool owner while the Provider and consumed binding remain observable`, async () => {
    const baseline = queryObjects(ModelHttpClient, { format: 'count' })
    const fixture = await httpFixture(response => {
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(adapter.fixture())
    })
    const provider = adapter.create({ providerId: 'pool-retirement', endpoint: fixture.endpoint,
      apiKey: 'test-only', maxConcurrentExchanges: 1, streamLimits })
    const prepared = provider.prepare(request())
    const exchange = await prepared.acquire(prepared.submission, new AbortController().signal)
    try {
      const stream = await exchange.start()
      for await (const frame of stream) void frame
      await exchange.close(); await provider.dispose()
      await collect()
      expect(queryObjects(ModelHttpClient, { format: 'count' })).toBe(baseline)
      expect(fixture.requests).toHaveLength(1)
      expect(provider.descriptor.protocol).toBe(adapter.name === 'DeepSeek' ? 'deepseek.chat' : 'anthropic.messages')
      expect(provider.dispose()).toBe(provider.dispose())
      expect(() => prepared.acquire(prepared.submission, new AbortController().signal)).toThrowError(expect.objectContaining({ code: 'MODEL_STATE_INVALID' }))
    } finally { await exchange.close(); await provider.dispose(); await fixture.close() }
  })
}
