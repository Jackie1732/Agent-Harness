import { expect, it } from 'vitest'
import { ApiAdmission } from '../../src/api/admission.js'
import { apiLimits } from './fixtures.js'

it('rejects saturation without queuing and releases a category at domain settlement', async () => {
  const admission = new ApiAdmission({ ...apiLimits, maxPendingInputs: 1, maxObservers: 1 })
  let release!: () => void, calls = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const first = admission.run('input.submit', async () => { calls++; await held; return 'accepted' })
  await expect(admission.run('input.submit', async () => { calls++; return 'queued' })).rejects.toMatchObject({ code: 'API_CAPACITY_EXCEEDED' })
  expect(calls).toBe(1)
  await expect(admission.run('host.shutdown', async () => 'management')).resolves.toBe('management')
  release(); await first
  await expect(admission.run('input.submit', async () => 'next')).resolves.toBe('next')
})

it('rejects a saturated shutdown category and admits the next request after management settlement', async () => {
  const admission = new ApiAdmission({ ...apiLimits, maxPendingShutdowns: 1 })
  let release!: () => void, calls = 0
  const held = new Promise<void>(resolve => { release = resolve })
  const first = admission.run('host.shutdown', async () => { calls++; await held; return 'closed' })
  try {
    await expect(admission.run('host.shutdown', async () => { calls++; return 'queued' })).rejects.toMatchObject({
      code: 'API_CAPACITY_EXCEEDED', acceptance: 'not-accepted' })
    expect(calls).toBe(1)
  } finally { release(); await first }
  await expect(admission.run('host.shutdown', async () => { calls++; return 'next' })).resolves.toBe('next')
  expect(calls).toBe(2)
})
