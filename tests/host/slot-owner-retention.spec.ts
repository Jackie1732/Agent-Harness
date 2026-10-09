import { setImmediate } from 'node:timers/promises'
import { queryObjects } from 'node:v8'
import { expect, it } from 'vitest'
import { EffectDisposalFailedError } from '../../src/effect/errors.js'
import { HostError } from '../../src/host/errors.js'
import { HostSlotOwner } from '../../src/host/slot-owner.js'

it('releases the last private slot value while its Host generation owner remains usable', async () => {
  class Resource {}
  let acquisitions = 0, releases = 0
  const owner = new HostSlotOwner('writer', async () => {
    acquisitions++
    return { resource: new Resource(), async dispose() { releases++ } }
  })
  expect(queryObjects(Resource, { format: 'count' })).toBe(0)
  async function generation() {
    const view = await owner.open()
    expect(view.resource instanceof Resource).toBe(true)
    expect(queryObjects(Resource, { format: 'count' })).toBe(1)
    await view.dispose()
    await owner.release()
  }
  try {
    for (let index = 0; index < 20; index++) await generation()
    await setImmediate()
    expect(queryObjects(Resource, { format: 'count' })).toBe(0)
    expect(acquisitions).toBe(20)
    expect(releases).toBe(20)
  } finally { await owner.dispose() }
})

it('retains the failed inverse reason and rejects reopening without retrying the same release', async () => {
  const reason = new Error('provider release failed')
  let acquisitions = 0, attempts = 0
  const owner = new HostSlotOwner('writer', async () => {
    acquisitions++
    return { async dispose() { attempts++; throw reason } }
  })
  const view = await owner.open()
  try {
    const failure = await owner.release().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(EffectDisposalFailedError)
    const inverseReason = (failure as EffectDisposalFailedError).cleanupFailures[0]?.reason
    expect(inverseReason).toBeInstanceOf(HostError)
    expect((inverseReason as HostError).cause).toBe(reason)
    expect(await owner.release().catch((error: unknown) => error)).toBe(failure)
    expect(await view.dispose().catch((error: unknown) => error)).toBe(failure)
    const reopen = await owner.open().catch((error: unknown) => error)
    expect(reopen).toBeInstanceOf(HostError)
    expect((reopen as HostError).cause).toBe(inverseReason)
    const closing = owner.dispose()
    const closeFailure = await closing.catch((error: unknown) => error)
    expect(closeFailure).toBeInstanceOf(EffectDisposalFailedError)
    expect((closeFailure as EffectDisposalFailedError).cleanupFailures[0]?.reason).toBe(inverseReason)
    expect(owner.dispose()).toBe(closing)
    expect(acquisitions).toBe(1)
    expect(attempts).toBe(1)
  } finally { await owner.dispose().catch(() => undefined) }
})
