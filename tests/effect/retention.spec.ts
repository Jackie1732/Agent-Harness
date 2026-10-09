import { setImmediate } from 'node:timers/promises'
import { queryObjects } from 'node:v8'
import { expect, it } from 'vitest'
import { EffectOwner } from '../../src/effect/owner.js'
import { EffectDisposalFailedError } from '../../src/effect/errors.js'

it('retires released resources while their owner continues accepting new Effects', async () => {
  class Resource { released = false }
  const owner = new EffectOwner('observation-owner')
  expect(queryObjects(Resource, { format: 'count' })).toBe(0)
  const first = await owner.run('observer', async effect => {
    await effect.apply('resource', () => new Resource(), value => { value.released = true })
  })
  expect(queryObjects(Resource, { format: 'count' })).toBe(1)
  try {
    await first.dispose()
    for (let index = 0; index < 20; index++) {
      const lease = await owner.run('replacement-observer', async effect => {
        await effect.apply('resource', () => new Resource(), value => { value.released = true })
      })
      await lease.dispose()
    }
    await setImmediate()
    expect(queryObjects(Resource, { format: 'count' })).toBe(0)
    expect(owner.status).toBe('accepting')
  } finally { await owner.dispose() }
})

it('retires successful startup rollback resources without closing their owner', async () => {
  class Resource { released = false }
  const owner = new EffectOwner('retrying-owner'), reason = new Error('setup failed')
  expect(queryObjects(Resource, { format: 'count' })).toBe(0)
  try {
    for (let index = 0; index < 20; index++) {
      await expect(owner.run('failed-startup', async effect => {
        await effect.apply('resource', () => new Resource(), value => { value.released = true })
        throw reason
      })).rejects.toBe(reason)
    }
    await setImmediate()
    expect(queryObjects(Resource, { format: 'count' })).toBe(0)
    expect(owner.status).toBe('accepting')
  } finally { await owner.dispose() }
})

it('retires terminal Owner resources while the disposed Owner remains reachable', async () => {
  class Resource { released = false }
  const owner = new EffectOwner('terminal-owner')
  expect(queryObjects(Resource, { format: 'count' })).toBe(0)
  for (let index = 0; index < 20; index++) {
    await owner.run('resource', async effect => {
      await effect.apply('resource', () => new Resource(), value => { value.released = true })
    })
  }
  expect(queryObjects(Resource, { format: 'count' })).toBe(20)
  await owner.dispose()
  await setImmediate()
  expect(queryObjects(Resource, { format: 'count' })).toBe(0)
  expect(owner.status).toBe('disposed')
})

it('retains an explicit Lease value after its release without promising an active resource', async () => {
  class Resource { released = false }
  const owner = new EffectOwner('public-value-owner')
  expect(queryObjects(Resource, { format: 'count' })).toBe(0)
  const lease = await owner.run('resource', effect => effect.apply('resource', () => new Resource(), value => { value.released = true }))
  await lease.dispose()
  await owner.dispose()
  await setImmediate()
  expect(queryObjects(Resource, { format: 'count' })).toBe(1)
  expect(lease.value).toBeInstanceOf(Resource)
  expect(lease.value.released).toBe(true)
  expect(owner.status).toBe('disposed')
})

it('retires successful neighbors while preserving failed cleanup identity for Owner release', async () => {
  class ReleasedResource { released = false }
  const owner = new EffectOwner('failed-cleanup-owner'), reason = new Error('inverse failed')
  let attempts = 0
  const lease = await owner.run('resources', async effect => {
    await effect.apply('successful-resource', () => new ReleasedResource(), value => { value.released = true })
    await effect.apply('failed-resource', () => undefined, () => { attempts++; throw reason })
  })
  expect(queryObjects(ReleasedResource, { format: 'count' })).toBe(1)
  try {
    const release = lease.dispose()
    await expect(release).rejects.toBeInstanceOf(EffectDisposalFailedError)
    const failure = await release.catch(error => error as EffectDisposalFailedError)
    expect(failure && failure.cleanupFailures[0]?.reason).toBe(reason)
    expect(lease.dispose()).toBe(release)
    await setImmediate()
    expect(queryObjects(ReleasedResource, { format: 'count' })).toBe(0)
    expect(owner.status).toBe('accepting')
    const closing = owner.dispose()
    await expect(closing).rejects.toBeInstanceOf(EffectDisposalFailedError)
    const finalFailure = await closing.catch(error => error as EffectDisposalFailedError)
    expect(finalFailure && finalFailure.cleanupFailures[0]?.reason).toBe(reason)
    expect(owner.dispose()).toBe(closing)
    expect(owner.status).toBe('disposed')
    expect(attempts).toBe(1)
  } finally { await owner.dispose().catch(() => undefined) }
})
