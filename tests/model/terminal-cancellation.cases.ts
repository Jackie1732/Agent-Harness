import { strict as assert } from 'node:assert'
import { InvocationControl } from '../../src/model/control.js'
import { ModelError } from '../../src/model/errors.js'
import { SessionModelRunner } from '../../src/model/runner.js'
import { createAnthropicModelProvider } from '../../src/model/providers/anthropic.js'
import { createDeepSeekModelProvider } from '../../src/model/providers/deepseek.js'
import type { ModelFrame, ModelProvider } from '../../src/model/contract.js'
import {
  anthropicText, deepSeekText, deferred, hasCode, httpFixture,
  repository, request, runnerLimits, scripted, streamLimits, textFrames,
} from './fixtures.js'
import type { RegisterCase } from './fixtures.js'

type TerminalReason = 'stop' | 'length'

/** Signals only after the consumer has processed the terminal frame and pulled again. */
async function* terminalFrames(reason: TerminalReason): AsyncGenerator<ModelFrame> {
  for await (const frame of textFrames()) {
    yield frame.kind === 'complete' ? { ...frame, stopReason: reason } : frame
  }
}

/** Observes the real adapter without manufacturing, dropping or reordering its frames. */
function observeTerminal(provider: ModelProvider, entered: () => void, signalSeen: (signal: AbortSignal) => void): ModelProvider {
  return {
    descriptor: provider.descriptor,
    prepare(input) {
      const prepared = provider.prepare(input)
      return {
        submission: prepared.submission,
        async acquire(committed, signal) {
          signalSeen(signal)
          const exchange = await prepared.acquire(committed, signal)
          return {
            async start() {
              const stream = await exchange.start()
              return (async function* () {
                for await (const frame of stream) {
                  yield frame
                  if (frame.kind === 'complete') entered()
                }
              })()
            },
            close: () => exchange.close(),
          }
        },
      }
    },
    dispose: () => provider.dispose(),
  }
}

export function terminalCancellationCases(test: RegisterCase): void {
  for (const outcome of ['completed', 'incomplete'] as const) {
    test(`R6-T01: cancellation still aborts transport after claiming ${outcome}`, () => {
      const control = new InvocationControl()
      assert.equal(control.claim(outcome), outcome)
      control.requestCancel()
      assert.equal(control.signal.aborted, true)
      assert.equal(control.desired, 'cancel')
      assert.equal(control.decision, outcome)
      control.requestCancel()
      assert.equal(control.claim('cancelled'), outcome)
    })
  }

  for (const reason of ['stop', 'length'] as const) {
    for (const cancelBy of ['caller', 'runner'] as const) {
      test(`R6-T02: ${cancelBy} releases a stalled ${reason} tail without changing its result`, async () => {
        const entered = deferred()
        const release = deferred()
        let observed: AbortSignal | undefined
        const provider = scripted({
          script: async function* (_submission, signal) {
            yield* terminalFrames(reason)
            observed = signal
            const unblock = (): void => release.resolve()
            signal.addEventListener('abort', unblock, { once: true })
            try {
              entered.resolve()
              await release.promise
            } finally { signal.removeEventListener('abort', unblock) }
          },
        })
        const repo = repository()
        const session = await repo.create()
        const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
        const caller = new AbortController()
        const invocation = runner.invoke(request(), { signal: caller.signal })
        try {
          await entered.promise
          assert.equal(session.snapshot().localPosition, 2)
          if (cancelBy === 'caller') caller.abort()
          else {
            const disposal = runner.dispose()
            assert.equal(runner.dispose(), disposal)
          }
          assert.equal(observed?.aborted, true, 'shutdown must reach the still-open transport')
          const result = await invocation
          assert.equal(result.payload.outcome, reason === 'length' ? 'incomplete' : 'completed')
          assert.equal(result.payload.result.protocolComplete, true)
          assert.equal(result.payload.cleanup.status, 'complete')
          assert.equal(result.payload.failure, undefined)
          assert.equal(session.snapshot().localPosition, 3)
        } finally {
          // This releases the pre-fix implementation too, so a red assertion cannot hang.
          release.resolve()
          await invocation.catch(() => undefined)
          await runner.dispose()
          await provider.dispose()
          await repo.dispose()
        }
      })
    }
  }

  test('R6-T03: late cancellation preserves completion but still waits for cleanup', async () => {
    const entered = deferred()
    const tail = deferred()
    const closing = deferred()
    const releaseCleanup = deferred()
    const provider = scripted({
      script: async function* (_submission, signal) {
        yield* textFrames()
        const cancel = (): void => tail.resolve()
        signal.addEventListener('abort', cancel, { once: true })
        try { entered.resolve(); await tail.promise }
        finally { signal.removeEventListener('abort', cancel) }
      },
      onClose: async () => { closing.resolve(); await releaseCleanup.promise },
    })
    const repo = repository()
    const session = await repo.create()
    const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    const invocation = runner.invoke(request())
    try {
      await entered.promise
      const disposal = runner.dispose()
      tail.resolve()
      await closing.promise
      assert.equal(session.snapshot().localPosition, 2, 'CP2 cannot precede cleanup')
      releaseCleanup.resolve()
      assert.equal((await invocation).payload.outcome, 'completed')
      await disposal
      assert.equal(session.status, 'open', 'Runner does not own the borrowed Session')
    } finally {
      tail.resolve(); releaseCleanup.resolve()
      await invocation.catch(() => undefined)
      await runner.dispose(); await provider.dispose(); await repo.dispose()
    }
  })

  test('R6-T04: a genuine protocol failure is not hidden by a concurrent late cancellation', async () => {
    const entered = deferred()
    const release = deferred()
    const provider = scripted({ script: async function* () {
      yield* textFrames()
      entered.resolve()
      await release.promise
      throw new ModelError('MODEL_PROTOCOL_INVALID', 'invalid tail already observed')
    } })
    const repo = repository()
    const runner = new SessionModelRunner({ session: await repo.create(), provider, limits: runnerLimits })
    const caller = new AbortController()
    const invocation = runner.invoke(request(), { signal: caller.signal })
    try {
      await entered.promise
      caller.abort()
      release.resolve()
      const result = await invocation
      assert.equal(result.payload.outcome, 'failed')
      assert.equal(result.payload.failure?.code, 'MODEL_PROTOCOL_INVALID')
    } finally {
      release.resolve(); await invocation.catch(() => undefined)
      await runner.dispose(); await provider.dispose(); await repo.dispose()
    }
  })

  for (const adapter of [
    { name: 'DeepSeek', create: createDeepSeekModelProvider, payload: deepSeekText },
    { name: 'Anthropic', create: createAnthropicModelProvider, payload: anthropicText },
  ]) {
    test(`R6-T05: ${adapter.name} real HTTP terminal without EOF remains cancellable`, async () => {
      const entered = deferred()
      let observed: AbortSignal | undefined
      const fixture = await httpFixture(response => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(adapter.payload())
        // Intentionally no response.end(): receiving a terminal is not receiving EOF.
      })
      const raw = adapter.create({ providerId: 'tail-fixture', endpoint: fixture.endpoint, apiKey: 'test-only', maxConcurrentExchanges: 1, streamLimits })
      const provider = observeTerminal(raw, () => entered.resolve(), signal => { observed = signal })
      const repo = repository()
      const session = await repo.create()
      const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
      const invocation = runner.invoke(request())
      try {
        await entered.promise
        const disposal = runner.dispose()
        assert.equal(observed?.aborted, true)
        const result = await invocation
        assert.equal(result.payload.outcome, 'completed')
        assert.equal(result.payload.failure, undefined, 'our Abort must not become a malformed-tail failure')
        assert.equal(result.payload.result.protocolComplete, true)
        assert.equal(result.payload.cleanup.status, 'complete')
        assert.equal(fixture.requests.length, 1)
        await disposal
      } finally {
        // Also releases an unpatched stalled client before awaiting its settlement.
        await fixture.close()
        await invocation.catch(() => undefined)
        await runner.dispose(); await provider.dispose(); await repo.dispose()
      }
    })
  }

  test('R6-T06: late cancellation never hides a failed cleanup or its committed result', async () => {
    const entered = deferred()
    const release = deferred()
    const provider = scripted({
      script: async function* () { yield* textFrames(); entered.resolve(); await release.promise },
      onClose: () => { throw new Error('cleanup fault') },
    })
    const repo = repository()
    const session = await repo.create()
    const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    const invocation = runner.invoke(request())
    try {
      await entered.promise
      const disposal = runner.dispose()
      release.resolve()
      await assert.rejects(invocation, hasCode('MODEL_CLEANUP_FAILED'))
      await assert.rejects(disposal, hasCode('MODEL_CLEANUP_FAILED'))
      const snapshot = runner.snapshot().invocations[0]
      assert.ok(snapshot?.state === 'settled')
      assert.equal(snapshot.settled.payload.result.protocolComplete, true)
      assert.equal(snapshot.settled.payload.cleanup.status, 'incomplete')
    } finally {
      release.resolve(); await invocation.catch(() => undefined)
      await runner.dispose().catch(() => undefined)
      await provider.dispose().catch(() => undefined)
      await repo.dispose()
    }
  })
}
