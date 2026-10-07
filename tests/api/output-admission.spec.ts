import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as io from '../../src/api/http-io.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { initializeHost } from '../../src/host/initialization.js'
import { decodeApiConfig, resolveApiConfig } from '../../src/api/config.js'
import { openHarnessApiServer } from '../../src/api/server.js'
import { createHarnessClient } from '../../src/client/client.js'
import { hostConfig } from '../host/fixtures.js'
import { apiConfig, clientOptions } from './fixtures.js'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(settle => { resolve = settle })
  return { promise, resolve }
}

it('admits a second settled control while the first response still occupies network output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'api-output-admission-'))
  const host = resolveHostConfig(decodeHostConfig(hostConfig(join(directory, 'store')), directory))
  await initializeHost(host)
  const config = await apiConfig()
  const service = await openHarnessApiServer({ host, api: resolveApiConfig(decodeApiConfig({ ...config,
    limits: { ...config.limits, maxPendingControls: 1 } }), host, directory), credentials: {} })
  const firstClient = createHarnessClient(await clientOptions(service.ready.listen.port))
  const secondClient = createHarnessClient(await clientOptions(service.ready.listen.port))
  const firstWriting = gate(), secondWriting = gate(), releaseOutput = gate()
  const originalWrite = io.writeResponse, pending: Promise<unknown>[] = []
  let writes = 0
  vi.spyOn(io, 'writeResponse').mockImplementation(async (response, status, body, timeoutMs) => {
    const envelope = JSON.parse(body.toString('utf8')) as { kind: string; result?: { agentKey?: string; paused?: boolean } }
    if (status === 200 && envelope.kind === 'result' && envelope.result?.agentKey === 'writer' && envelope.result.paused === true) {
      writes++
      expect(response.writableFinished).toBe(false)
      if (writes === 1) firstWriting.resolve()
      else secondWriting.resolve()
      await releaseOutput.promise
    }
    await originalWrite(response, status, body, timeoutMs)
  })
  try {
    const first = firstClient.request('agent.pause', { agentKey: 'writer', expectedInstanceId: service.ready.instanceId })
    pending.push(first)
    await Promise.race([firstWriting.promise, first.then(() => { throw new Error('First output was not held') })])
    const second = secondClient.request('agent.pause', { agentKey: 'writer', expectedInstanceId: service.ready.instanceId })
    pending.push(second)
    await Promise.race([secondWriting.promise, second.then(() => { throw new Error('Second output was not held') })])
    expect(writes).toBe(2)
    releaseOutput.resolve()
    for (const result of await Promise.all([first, second])) expect(result).toMatchObject({ agentKey: 'writer', paused: true })
    await Promise.all([firstClient.dispose(), secondClient.dispose()])
    await service.dispose()
    expect(service.status).toBe('closed')
  } finally {
    releaseOutput.resolve(); await Promise.allSettled(pending)
    await Promise.all([firstClient.dispose(), secondClient.dispose()])
    await service.dispose(); vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  }
})
