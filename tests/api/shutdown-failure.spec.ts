import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { expect, it, vi } from 'vitest'
import * as hostRuntime from '../../src/host/runtime.js'
import * as management from '../../src/host/storage-management.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { initializeHost } from '../../src/host/initialization.js'
import { openHarnessApiServer } from '../../src/api/server.js'
import { decodeApiConfig, resolveApiConfig } from '../../src/api/config.js'
import { createHarnessClient } from '../../src/client/client.js'
import { hostConfig } from '../host/fixtures.js'
import { apiConfig, clientOptions } from './fixtures.js'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(settle => { resolve = settle })
  return { promise, resolve }
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'api-shutdown-')), root = join(directory, 'store')
  const host = resolveHostConfig(decodeHostConfig(hostConfig(root), directory)); await initializeHost(host)
  const service = await openHarnessApiServer({ host, api: resolveApiConfig(decodeApiConfig(await apiConfig()), host, directory), credentials: {} })
  const client = createHarnessClient(await clientOptions(service.ready.listen.port))
  return { root, directory, service, client }
}
async function refused(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => { socket.destroy(); reject(new Error('Listener retained')) })
    socket.once('error', error => { if ('code' in error && error.code === 'ECONNREFUSED') resolve(); else reject(error) })
  })
}
it('releases control networking after a real storage-management conflict and retains the original root token', async () => {
  const f = await fixture(), entered = gate(), release = gate()
  let held: Promise<void> | undefined
  try {
    const marker = await readFile(join(f.root, '.atomic-harness.lock'), 'utf8')
    held = management.withHostStorageManagement(f.root, 'test-concurrent-administrator', async () => { entered.resolve(); await release.promise })
    await entered.promise
    const closed = expect(f.service.closed).rejects.toMatchObject({ code: 'HOST_CLEANUP_FAILED' })
    await expect(f.client.request('host.shutdown', { expectedInstanceId: f.service.ready.instanceId, mode: 'drain' })).rejects.toMatchObject({ code: 'API_INTERNAL_ERROR', acceptance: 'unknown' })
    await closed
    expect(f.service.status).toBe('failed')
    expect(await readFile(join(f.root, '.atomic-harness.lock'), 'utf8')).toBe(marker)
    expect(f.service.dispose()).toBe(f.service.dispose())
    await expect(f.service.dispose()).rejects.toMatchObject({ code: 'HOST_CLEANUP_FAILED' })
    await refused(f.service.ready.listen.port)
  } finally {
    release.resolve(); await held
    await f.client.dispose(); await f.service.dispose().catch(() => undefined)
    await rm(f.directory, { recursive: true, force: true })
  }
})
it('joins a late cancel during real storage release without upgrading the already fixed drain mode', async () => {
  const entered = gate(), release = gate(), cancelObserved = gate()
  const originalOpen = hostRuntime.openHost, originalManagement = management.withHostStorageManagement
  let ownedHost: hostRuntime.AtomicHost | undefined
  vi.spyOn(hostRuntime, 'openHost').mockImplementation(async (...args) => {
    ownedHost = await originalOpen(...args)
    const originalShutdown = ownedHost.shutdown.bind(ownedHost)
    vi.spyOn(ownedHost, 'shutdown').mockImplementation(options => {
      if (options?.mode === 'cancel') cancelObserved.resolve()
      return originalShutdown(options)
    })
    return ownedHost
  })
  vi.spyOn(management, 'withHostStorageManagement').mockImplementation((root, operation, action) => originalManagement(root, operation,
    async () => { if (operation === 'release' && ownedHost !== undefined) { entered.resolve(); await release.promise } return await action() }))
  let f: Awaited<ReturnType<typeof fixture>> | undefined
  let other: ReturnType<typeof createHarnessClient> | undefined
  try {
    f = await fixture(); other = createHarnessClient(await clientOptions(f.service.ready.listen.port))
    await other.request('host.status', {})
    const drain = f.client.request('host.shutdown', { expectedInstanceId: f.service.ready.instanceId, mode: 'drain' })
    await entered.promise
    expect(ownedHost!.shutdownState).toEqual({ status: 'stopping', mode: 'drain', releasing: true })
    const cancel = other.request('host.shutdown', { expectedInstanceId: f.service.ready.instanceId, mode: 'cancel' })
    await cancelObserved.promise
    expect(ownedHost!.shutdownState.mode).toBe('drain')
    release.resolve()
    for (const response of await Promise.all([drain, cancel])) expect(response.mode).toBe('drain')
    await f.service.closed; await refused(f.service.ready.listen.port)
  } finally {
    release.resolve(); await other?.dispose(); await f?.client.dispose(); await f?.service.dispose().catch(() => undefined)
    vi.restoreAllMocks()
    if (f !== undefined) await rm(f.directory, { recursive: true, force: true })
  }
})
