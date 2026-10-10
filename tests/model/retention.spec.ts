import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { queryObjects } from 'node:v8'
import { expect, it } from 'vitest'
import { SessionModelRunner } from '../../src/model/runner.js'
import { parseModelInvocationId } from '../../src/model/ids.js'
import { deferred, hasCode, repository, request, runnerLimits, scripted } from './fixtures.js'

async function releasedRunner(invoke: boolean, keepSnapshot: boolean, cleanupFails: boolean) {
  const repo = repository()
  const provider = scripted({ onClose: () => { if (cleanupFails) throw new Error('private provider cleanup') } })
  const session = await repo.create()
  const identities = { nextInvocationId: () => parseModelInvocationId('11111111-1111-4111-8111-111111111111') }
  const lifetime = new AbortController()
  const runner = new SessionModelRunner({ session, provider, limits: runnerLimits, identities, signal: lifetime.signal })
  if (invoke) {
    if (cleanupFails) await assert.rejects(runner.invoke(request()), hasCode('MODEL_CLEANUP_FAILED'))
    else await runner.invoke(request())
  }
  const snapshot = keepSnapshot ? runner.snapshot() : undefined
  const refs = {
    session: new WeakRef(session), provider: new WeakRef(provider), identities: new WeakRef(identities), signal: new WeakRef(lifetime.signal),
  }
  const close = runner.dispose()
  if (cleanupFails) await assert.rejects(close, hasCode('MODEL_CLEANUP_FAILED'))
  else await close
  expect(session.status).toBe('open')
  await provider.dispose().catch(() => undefined)
  await repo.dispose()
  return { runner, snapshot, refs, close }
}

it.each([
  [false, false, false], [true, false, false], [true, true, false], [true, true, true],
])('retires borrowed Model resources: invocation=%s, retained snapshot=%s, failed cleanup=%s', async (invoke, keepSnapshot, cleanupFails) => {
  const { runner, snapshot, refs, close } = await releasedRunner(invoke, keepSnapshot, cleanupFails)
  await setImmediate()
  queryObjects(SessionModelRunner, { format: 'count' })
  expect(Object.fromEntries(Object.entries(refs).map(([key, ref]) => [key, ref.deref() !== undefined]))).toEqual({
    session: false, provider: false, identities: false, signal: false,
  })
  expect(runner.status).toBe('disposed')
  expect(runner.limits).toEqual(runnerLimits)
  expect(() => runner.invoke(request())).toThrowError(expect.objectContaining({ code: 'MODEL_RUNNER_INACTIVE' }))
  expect(() => runner.snapshot()).toThrowError(expect.objectContaining({ code: 'MODEL_RUNNER_INACTIVE' }))
  expect(runner.dispose()).toBe(close)
  if (keepSnapshot) {
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(snapshot?.invocations[0]).toMatchObject({ state: 'settled', settled: { payload: {
      outcome: cleanupFails ? 'failed' : 'completed', result: { protocolComplete: true },
      cleanup: { status: cleanupFails ? 'incomplete' : 'complete' },
    } } })
  } else expect(snapshot).toBeUndefined()
})

it('keeps the borrowed runtime until cancellation, exchange close, and settlement finish', async () => {
  const repo = repository()
  const closing = deferred()
  const release = deferred()
  const provider = scripted({ onClose: async () => { closing.resolve(); await release.promise } })
  const session = await repo.create()
  const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
  const pending = runner.invoke(request())
  try {
    await closing.promise
    const close = runner.dispose()
    let finished = false
    void close.then(() => { finished = true })
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(runner.status).toBe('disposing')
    expect(runner.snapshot().invocations[0]?.state).toBe('started')
    release.resolve()
    expect((await pending).payload.outcome).toBe('completed')
    await close
    expect(() => runner.snapshot()).toThrowError(expect.objectContaining({ code: 'MODEL_RUNNER_INACTIVE' }))
    expect(session.snapshot().localPosition).toBe(3)
  } finally {
    release.resolve(); await pending; await runner.dispose(); await provider.dispose(); await repo.dispose()
  }
})
