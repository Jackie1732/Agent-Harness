import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { initializeHost } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { HostReads } from '../../src/host/reads.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { SessionEventId } from '../../src/session/ids.js'
import { decodeApiConfig, resolveApiConfig } from '../../src/api/config.js'
import type { ApiLimits } from '../../src/api/config.js'
import { openHarnessApiServer } from '../../src/api/server.js'
import { createHarnessClient } from '../../src/client/client.js'
import { hostConfig } from '../host/fixtures.js'
import { apiConfig, clientOptions } from './fixtures.js'

async function fixture(limits: Partial<ApiLimits>, question = false) {
  const directory = await mkdtemp(join(tmpdir(), 'api-response-json-'))
  const rawHost = hostConfig(join(directory, 'store'))
  if (question) {
    const member = (rawHost.members as Array<Record<string, unknown>>)[0]!
    member.spec = { ...(member.spec as object), nativeActions: ['agent_ask_user'] }
    const model = member.model as Record<string, unknown>
    model.runnerLimits = { ...(model.runnerLimits as object), maxToolCalls: 1 }
  }
  const spec = resolveHostConfig(decodeHostConfig(rawHost, directory))
  await initializeHost(spec)
  let rootId: SessionEventId | undefined
  if (question) {
    const seed = await openHost(spec, { bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* () {
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'ask' }
        yield { kind: 'block-start', index: 0, block: 'tool-call', name: 'agent_ask_user', callId: 'ask' }
        yield { kind: 'arguments-delta', index: 0, text: '{"question":"Confirm?","timeoutMs":60000}' }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
      } }) } })
    try {
      await seed.submitTask('writer', 'Confirm the task'); await seed.run()
      rootId = seed.read().agent('writer').report.roots[0]!.id
    } finally { await seed.shutdown({ mode: 'drain' }) }
  }
  const raw = await apiConfig()
  const api = resolveApiConfig(decodeApiConfig({ ...raw, limits: { ...raw.limits, ...limits } }), spec, directory)
  const service = await openHarnessApiServer({ host: spec, api, credentials: {} })
  const client = createHarnessClient(await clientOptions(service.ready.listen.port))
  return { directory, spec, service, client, rootId }
}

it.each([{ maxJsonDepth: 2 }, { maxJsonNodes: 10 }])('reports response JSON budget %j after retaining actual domain acceptance', async limits => {
  const f = await fixture(limits)
  try {
    const readError: unknown = await f.client.request('host.status', {}).catch(error => error)
    const receipt = await f.client.request('input.submit', { agentKey: 'writer', submissionKey: 'response-budget', text: 'Complete this task' })
    const runError: unknown = await f.client.request('host.run', { expectedInstanceId: f.service.ready.instanceId }).catch(error => error)
    await f.client.dispose(); await f.service.dispose()
    const host = await openHost(f.spec)
    try {
      const input = host.read().input('writer', { inputEventId: receipt.inputEventId })
      expect(input.rootId).not.toBeNull()
      expect(host.read().root('writer', input.rootId!).outcome).toBe('completed')
    } finally { await host.shutdown({ mode: 'drain' }) }
    expect(readError).toMatchObject({ code: 'API_LIMIT_EXCEEDED', acceptance: 'not-applicable' })
    expect(runError).toMatchObject({ code: 'API_LIMIT_EXCEEDED', acceptance: 'unknown' })
  } finally {
    await f.client.dispose(); await f.service.dispose()
    await rm(f.directory, { recursive: true, force: true })
  }
})

it('keeps an invalid produced DTO distinct from a response resource limit', async () => {
  const f = await fixture({})
  const originalStatus = HostReads.prototype.status
  vi.spyOn(HostReads.prototype, 'status').mockImplementation(function (this: HostReads) {
    const status = originalStatus.call(this)
    return { ...status, activity: 'invalid-produced-activity' as 'idle' }
  })
  try {
    await expect(f.client.request('host.status', {})).rejects.toMatchObject({ code: 'API_INTERNAL_ERROR', acceptance: 'not-applicable' })
  } finally {
    vi.restoreAllMocks(); await f.client.dispose(); await f.service.dispose()
    await rm(f.directory, { recursive: true, force: true })
  }
})

it('uses read-only acceptance for actual forbidden and observation-capacity responses', async () => {
  const f = await fixture({ maxObservers: 1 }, true)
  const abort = new AbortController(), originalRoot = HostReads.prototype.root
  let readStarted!: () => void
  const reading = new Promise<void>(resolve => { readStarted = resolve })
  vi.spyOn(HostReads.prototype, 'root').mockImplementation(function (this: HostReads, ...args) {
    const root = originalRoot.call(this, ...args)
    readStarted(); return root
  })
  let waiting: Promise<unknown> | undefined
  try {
    const forbidden: unknown = await f.client.request('agent.get', { agentKey: 'reviewer' }).catch(error => error)
    waiting = f.client.request('root.wait', { agentKey: 'writer', rootId: f.rootId!, timeoutMs: 3000 }, { signal: abort.signal }).catch(error => error)
    await reading
    const capacity: unknown = await f.client.request('host.status', {}).catch(error => error)
    abort.abort(); await waiting
    expect(capacity).toMatchObject({ code: 'API_CAPACITY_EXCEEDED', acceptance: 'not-applicable' })
    expect(forbidden).toMatchObject({ code: 'API_FORBIDDEN', acceptance: 'not-applicable' })
  } finally {
    abort.abort(); await waiting
    vi.restoreAllMocks(); await f.client.dispose(); await f.service.dispose()
    await rm(f.directory, { recursive: true, force: true })
  }
})
