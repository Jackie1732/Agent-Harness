import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { X509Certificate } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { initializeHost } from '../../src/host/initialization.js'
import { openHarnessApiServer } from '../../src/api/server.js'
import { decodeApiConfig, resolveApiConfig } from '../../src/api/config.js'
import { createHarnessClient } from '../../src/client/client.js'
import { openHost } from '../../src/host/runtime.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import { hostConfig, twoMemberHostConfig } from '../host/fixtures.js'
import { apiConfig, certificateDirectory, clientOptions } from './fixtures.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function setup(two = false, configure?: (raw: ReturnType<typeof hostConfig>, api: Awaited<ReturnType<typeof apiConfig>>) => void, question = false) {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-control-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const rawHost = (two ? twoMemberHostConfig : hostConfig)(join(directory, 'store')), rawApi = await apiConfig()
  configure?.(rawHost, rawApi)
  const host = resolveHostConfig(decodeHostConfig(rawHost, directory))
  await initializeHost(host)
  if (question) {
    const seed = await openHost(host, { bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* () {
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'ask' }
        yield { kind: 'block-start', index: 0, block: 'tool-call', name: 'agent_ask_user', callId: 'ask' }
        yield { kind: 'arguments-delta', index: 0, text: '{"question":"Confirm?","timeoutMs":60000}' }
        yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
      } }) } })
    try { await seed.submitTask('writer', 'question'); await seed.run() } finally { await seed.shutdown({ mode: 'drain' }) }
  }
  const raw = rawApi
  const config = decodeApiConfig(two ? { ...raw, principals: [{ ...raw.principals[0], agentKeys: ['writer', 'reviewer'] }] } : raw)
  const service = await openHarnessApiServer({ host, api: resolveApiConfig(config, host, directory), credentials: { LOCAL_TEST_KEY: 'local-test-only' } })
  cleanup.push(() => service.dispose())
  const client = createHarnessClient(await clientOptions(service.ready.listen.port)); cleanup.push(() => client.dispose())
  return { host, service, client }
}
describe('mutual TLS control service', () => {
  it('starts idle, persists deduplicated tasks and exposes exact completed Root and fixed event pages', async () => {
    const { client } = await setup()
    const status = await client.request('host.status', {})
    expect(status.activity).toBe('idle')
    const receipt = await client.request('input.submit', { agentKey: 'writer', submissionKey: 'task1', text: 'research' })
    expect(receipt.reused).toBe(false)
    expect(await client.request('input.submit', { agentKey: 'writer', submissionKey: 'task1', text: 'research' })).toEqual({ ...receipt, reused: true })
    await expect(client.request('input.submit', { agentKey: 'writer', submissionKey: 'task1', text: 'changed' })).rejects.toMatchObject({ code: 'API_KEY_CONFLICT', acceptance: 'not-accepted' })
    const before = await client.request('input.get', { agentKey: 'writer', submissionKey: 'task1' })
    expect(before.rootId).toBeNull()
    const run = await client.request('host.run', { expectedInstanceId: status.instanceId })
    expect(run.report.businessRuns).toBeGreaterThan(0)
    const input = await client.request('input.get', { agentKey: 'writer', inputEventId: receipt.inputEventId })
    expect(input.rootId).not.toBeNull()
    const root = await client.request('root.get', { agentKey: 'writer', rootId: input.rootId! })
    expect(root.outcome).toBe('completed'); expect(root.final?.text).toBe('fixed answer')
    const pages = []; for await (const page of client.events({ target: { kind: 'member', agentKey: 'writer' }, maxEvents: 2 })) pages.push(page)
    expect(pages.length).toBeGreaterThan(1)
    expect(new Set(pages.map(page => page.through)).size).toBe(1)
    expect(pages.at(-1)?.nextCursor).toBeNull()
    await expect(client.request('host.run', { expectedInstanceId: '00000000-0000-4000-8000-000000000099' })).rejects.toMatchObject({ code: 'API_INSTANCE_MISMATCH' })
  })
  it('keeps certificate registration and exact method grants independent', async () => {
    const { client, service } = await setup()
    const other = createHarnessClient(await clientOptions(service.ready.listen.port, 'client-b')); cleanup.push(() => other.dispose())
    await expect(other.request('host.status', {})).rejects.toMatchObject({ code: 'API_UNAUTHORIZED', acceptance: 'not-accepted' })
    const noName = createHarnessClient({ ...await clientOptions(service.ready.listen.port), serverName: 'wrong.example' }); cleanup.push(() => noName.dispose())
    await expect(noName.request('input.submit', { agentKey: 'writer', submissionKey: 'bad', text: 'bad' })).rejects.toMatchObject({ name: 'ClientTransportError', acceptance: 'not-accepted' })
    await expect(client.request('agent.get', { agentKey: 'ungranted' })).rejects.toMatchObject({ code: 'API_FORBIDDEN' })
  })
  it('uses local member permissions without an implicit global status request', async () => {
    const { client } = await setup(false, (_raw, config) => Object.assign(config, { principals: [{ ...config.principals[0], methods: ['agent.get', 'input.submit', 'input.get'] }] }))
    const agent = await client.request('agent.get', { agentKey: 'writer' }); expect(agent.instanceId).toMatch(/^[a-f0-9-]{36}$/)
    await client.request('input.submit', { agentKey: 'writer', submissionKey: 'local', text: 'local permissions' })
    await expect(client.request('host.status', {})).rejects.toMatchObject({ code: 'API_FORBIDDEN' })
    await expect(client.request('session.events', { target: { kind: 'member', agentKey: 'writer' }, maxEvents: 1 })).rejects.toMatchObject({ code: 'API_FORBIDDEN' })
  })
  it('isolates submission namespaces while allowing authorized EventId reads across principals', async () => {
    const fingerprint = new X509Certificate(await readFile(`${certificateDirectory}client-b.pem`)).fingerprint256.replaceAll(':', '').toLowerCase()
    const { client, service } = await setup(false, (_raw, config) => Object.assign(config, { principals: [...config.principals,
      { ...config.principals[0], principalKey: 'reviewer', certificateFingerprints: [fingerprint] }] }))
    const reviewer = createHarnessClient(await clientOptions(service.ready.listen.port, 'client-b')); cleanup.push(() => reviewer.dispose())
    const first = await client.request('input.submit', { agentKey: 'writer', submissionKey: 'shared', text: 'first' })
    const second = await reviewer.request('input.submit', { agentKey: 'writer', submissionKey: 'shared', text: 'second' })
    expect(first.inputEventId).not.toBe(second.inputEventId)
    expect((await reviewer.request('input.get', { agentKey: 'writer', submissionKey: 'shared' })).inputEventId).toBe(second.inputEventId)
    expect((await reviewer.request('input.get', { agentKey: 'writer', inputEventId: first.inputEventId })).inputEventId).toBe(first.inputEventId)
  })
  it('returns the exact Message receipt and actual delivery facts', async () => {
    const { client } = await setup(true)
    const status = await client.request('host.status', {})
    const receipt = await client.request('message.send', { agentKey: 'writer', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1, payloadJson: JSON.stringify({ text: 'review' }) })
    expect(receipt.status).toBe('outbox-accepted')
    expect(receipt.messageId).not.toBeNull(); expect(receipt.action).not.toBeNull(); expect(receipt.outboxAcceptedEventId).not.toBeNull()
    await client.request('host.run', { expectedInstanceId: status.instanceId })
    const message = await client.request('message.get', { agentKey: 'writer', direction: 'outbox', messageId: receipt.messageId! })
    expect(message.fact.status).toBe('delivered')
    expect(await client.request('message.wait', { agentKey: 'writer', direction: 'outbox', until: 'terminal', messageId: receipt.messageId!, timeoutMs: 50 })).toMatchObject({ status: 'condition-met' })
  })
  it('joins drain/cancel managers independently of a full observer quota and closes cached observers', async () => {
    const restrictedFingerprint = new X509Certificate(await readFile(`${certificateDirectory}client-b.pem`)).fingerprint256.replaceAll(':', '').toLowerCase()
    let modelReceived!: () => void
    const received = new Promise<void>(resolve => { modelReceived = resolve })
    const provider = createServer((request, response) => {
      request.resume(); request.once('end', () => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(': connected\n\n')
        modelReceived()
      })
    })
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>(resolve => { provider.close(() => resolve()); provider.closeAllConnections() }))
    const address = provider.address(); if (address === null || typeof address === 'string') throw new Error('provider address')
    const { client, service } = await setup(false, (rawHost, rawApi) => {
      const member = (rawHost.members as Array<Record<string, unknown>>)[0]!, model = member.model as Record<string, unknown>
      member.model = { ...model, kind: 'deepseek', endpoint: `http://127.0.0.1:${address.port}/chat/completions`, credentialRef: 'LOCAL_TEST_KEY' }
      delete (member.model as Record<string, unknown>).text
      Object.assign(rawApi, { limits: { ...rawApi.limits, maxObservers: 1 } })
      Object.assign(rawApi, { principals: [...rawApi.principals, { principalKey: 'limited', certificateFingerprints: [restrictedFingerprint],
        methods: ['input.submit', 'agent.get'], agentKeys: ['writer'], workflowKeys: [] }] })
    })
    const manager = createHarnessClient(await clientOptions(service.ready.listen.port)); cleanup.push(() => manager.dispose())
    const restricted = createHarnessClient(await clientOptions(service.ready.listen.port, 'client-b')); cleanup.push(() => restricted.dispose())
    await manager.request('host.status', {})
    const { instanceId } = service.ready
    await client.request('input.submit', { agentKey: 'writer', submissionKey: 'held', text: 'hold model' })
    const run = client.request('host.run', { expectedInstanceId: instanceId })
    await received
    await expect(restricted.request('host.run', { expectedInstanceId: instanceId })).rejects.toMatchObject({ code: 'API_FORBIDDEN' })
    await expect(manager.request('message.send', { agentKey: 'writer', peerKey: 'unused', type: 'unused', payloadVersion: 1, payloadJson: '{}' })).rejects.toMatchObject({ code: 'API_BUSY' })
    const input = await client.request('input.get', { agentKey: 'writer', submissionKey: 'held' })
    const observer = client.request('root.wait', { agentKey: 'writer', rootId: input.rootId!, timeoutMs: 3000 })
    // This second read proves the first long observer has occupied its independent lane.
    await expect(manager.request('agent.get', { agentKey: 'writer' })).rejects.toMatchObject({ code: 'API_CAPACITY_EXCEEDED' })
    const drain = manager.request('host.shutdown', { expectedInstanceId: instanceId, mode: 'drain' })
    expect((await observer).status).toBe('host-closed')
    await expect(client.request('agent.get', { agentKey: 'writer' })).rejects.toMatchObject({ code: 'API_INACTIVE' })
    const cancel = client.request('host.shutdown', { expectedInstanceId: instanceId, mode: 'cancel' })
    const results = await Promise.all([drain, cancel])
    expect(results).toEqual([{ instanceId, mode: 'cancel', hostStatus: 'stopped', serviceStatus: 'closing' }, { instanceId, mode: 'cancel', hostStatus: 'stopped', serviceStatus: 'closing' }])
    await run; await service.closed; expect(service.status).toBe('closed')
    expect(service.dispose()).toBe(service.dispose())
  })
  it('omits only final text at the actual response budget and preserves already-run acceptance', async () => {
    const { client, service } = await setup(false, (rawHost, rawApi) => {
      const member = (rawHost.members as Array<Record<string, unknown>>)[0]!
      member.model = { ...(member.model as object), text: 'x'.repeat(16000) }
      Object.assign(rawApi, { limits: { ...rawApi.limits, maxResponseBytes: 4096 } })
    })
    await client.request('input.submit', { agentKey: 'writer', submissionKey: 'large', text: 'large final' })
    await expect(client.request('host.run', { expectedInstanceId: service.ready.instanceId })).rejects.toMatchObject({ code: 'API_LIMIT_EXCEEDED', acceptance: 'unknown' })
    const input = await client.request('input.get', { agentKey: 'writer', submissionKey: 'large' })
    const root = await client.request('root.get', { agentKey: 'writer', rootId: input.rootId! })
    expect(root.final).toMatchObject({ text: null, textBytes: 16000, textOmitted: true })
    expect(root.outcome).toBe('completed')
  })
  it('releases a complete-body disconnected observer without cancelling its waiting Root', async () => {
    const { client } = await setup(false, rawHost => {
      const member = (rawHost.members as Array<Record<string, unknown>>)[0]!
      member.spec = { ...(member.spec as object), nativeActions: ['agent_ask_user'] }
      const model = member.model as Record<string, unknown>
      model.runnerLimits = { ...(model.runnerLimits as object), maxToolCalls: 1 }
    }, true)
    const agent = await client.request('agent.get', { agentKey: 'writer' }), rootId = agent.report.roots[0]!.id
    const abort = new AbortController()
    const wait = client.request('root.wait', { agentKey: 'writer', rootId, timeoutMs: 3000 }, { signal: abort.signal })
    const rejected = expect(wait).rejects.toMatchObject({ name: 'ClientAbortError', acceptance: 'not-applicable' })
    await client.request('host.status', {})
    abort.abort(); await rejected
    const root = await client.request('root.get', { agentKey: 'writer', rootId })
    expect(root.outcome).toBeNull(); expect(root.waits).toHaveLength(1)
    await expect(client.request('root.wait', { agentKey: 'writer', rootId, timeoutMs: 10 })).resolves.toMatchObject({ status: 'timeout' })
  })
})
