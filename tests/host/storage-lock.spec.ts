import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireHostStorageLock, unlockHostStorage } from '../../src/index.js'

describe('Host storage ownership', () => {
  it('excludes aliases and removes only the current owner token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-host-lock-'))
    const first = await acquireHostStorageLock(root, 'first')
    await expect(acquireHostStorageLock(join(root, '.'), 'second')).rejects.toMatchObject({ code: 'HOST_LOCKED' })
    await first.dispose()
    const second = await acquireHostStorageLock(root, 'second')
    await second.dispose()
  })

  it('requires the exact residual token for administrative unlock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-host-unlock-'))
    const lock = await acquireHostStorageLock(root, 'owner')
    await expect(unlockHostStorage(root, { predecessorStopped: true, expectedToken: 'wrong' })).rejects.toMatchObject({ code: 'HOST_LOCKED' })
    await lock.dispose()
  })

  it('bounds both new and residual records without removing unreadable ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-host-lock-budget-'))
    await expect(acquireHostStorageLock(root, 'x'.repeat(8192))).rejects.toMatchObject({ code: 'HOST_CONFIG_INVALID' })
    const lease = await acquireHostStorageLock(root, 'bounded')
    await lease.dispose()
    const path = join(root, '.atomic-harness.lock')
    await writeFile(path, 'x'.repeat(8193))
    await expect(unlockHostStorage(root, { predecessorStopped: true, expectedToken: 'token' })).rejects.toMatchObject({ code: 'HOST_LOCKED' })
    await expect(acquireHostStorageLock(root, 'next')).rejects.toMatchObject({ code: 'HOST_LOCKED' })
    expect((await readFile(path)).length).toBe(8193)
  })
})
