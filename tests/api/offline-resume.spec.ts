import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { initializeHost } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { dispatchControl } from '../../src/api/dispatch.js'
import { authorizeRequest } from '../../src/api/authorization.js'
import { CONTROL_PROTOCOL, CONTROL_VERSION, decodeControlRequest } from '../../src/protocol/index.js'
import { hostConfig } from '../host/fixtures.js'
import { apiConfig, apiLimits } from './fixtures.js'

it('rejects API resume of a retained offline slot while preserving the original local Host control', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'api-offline-resume-'))
  const spec = resolveHostConfig(decodeHostConfig(hostConfig(join(directory, 'store')), directory))
  await initializeHost(spec)
  const host = await openHost(spec)
  try {
    await host.setMailboxOnline('writer', false)
    const before = host.read().agent('writer')
    expect(before).toMatchObject({ mailbox: 'known-offline', paused: true })
    const principal = (await apiConfig()).principals[0]!
    const request = decodeControlRequest({ protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId: 'offline-resume',
      method: 'agent.resume', params: { agentKey: 'writer', expectedInstanceId: host.instanceId } },
    { maxBytes: apiLimits.maxRequestBytes, maxDepth: apiLimits.maxJsonDepth, maxNodes: apiLimits.maxJsonNodes })
    await authorizeRequest(principal, request, host, spec)
    await expect(dispatchControl(host, spec, principal, request, apiLimits, new AbortController().signal,
      mode => host.shutdown({ mode }))).rejects.toMatchObject({ code: 'API_INACTIVE', acceptance: 'not-accepted' })
    expect(host.read().agent('writer')).toEqual(before)
    expect(() => host.resume('writer')).not.toThrow()
    expect(host.read().agent('writer').mailbox).toBe('known-offline')
  } finally { await host.shutdown({ mode: 'cancel' }); await rm(directory, { recursive: true, force: true }) }
})
