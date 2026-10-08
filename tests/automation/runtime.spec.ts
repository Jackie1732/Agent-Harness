import { afterEach, describe, expect, it } from 'vitest'
import { createHarnessClient } from '../../src/client/client.js'
import { openAutomationJournal } from '../../src/automation/journal.js'
import { openHarnessAutomation } from '../../src/automation/runtime.js'
import { decodeAutomationConfig } from '../../src/automation/config.js'
import { clientOptions } from '../api/fixtures.js'
import { setup, config, bearerToken, faultProxy, eventually, webhookRequest } from './fixtures.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
describe('automation ingress and lifecycle', () => {
  it('rejects a webhook that cannot fit the actual RPC envelope before accepting or driving it', async () => {
    const fixture = await setup(); cleanup.push(() => fixture.dispose())
    const settings = decodeAutomationConfig({ ...fixture.config, client: { ...fixture.config.client, limits: { ...fixture.config.client.limits, maxRequestBytes: 512 } } })
    const service = await openHarnessAutomation({ config: settings, bearerToken }); cleanup.push(() => service.dispose())
    expect((await webhookRequest(service.ready.listen.port, { eventId: 'too-large-for-rpc', text: 'x'.repeat(400) })).status).toBe(429)
    expect(service.status().triggers).toEqual([])
  }, 30000)
  it('receives authenticated fixed Jobs and preserves receipts across restart without exposing secrets', async () => {
    const fixture = await setup(); cleanup.push(() => fixture.dispose())
    let service = await openHarnessAutomation({ config: fixture.config, bearerToken })
    const body = { eventId: 'external/one', text: 'research' }, first = await webhookRequest(service.ready.listen.port, body)
    expect(first.status).toBe(202)
    await eventually(() => service.status().triggers[0]?.execution === 'closed')
    const status = service.status()
    expect(JSON.stringify(status)).not.toContain(bearerToken); expect(JSON.stringify(status)).not.toContain(fixture.config.client.tls.keyFile)
    await service.dispose()
    service = await openHarnessAutomation({ config: fixture.config, bearerToken }); cleanup.push(() => service.dispose())
    const again = await webhookRequest(service.ready.listen.port, body)
    expect(again.status).toBe(202); expect(again.body).toMatchObject({ reused: true, trigger: { acceptedEventId: (first.body as { trigger: { acceptedEventId: string } }).trigger.acceptedEventId } })
    expect((await webhookRequest(service.ready.listen.port, { ...body, text: 'different' })).status).toBe(409)
    expect(service.status().triggers).toHaveLength(1)
  }, 30000)
  it('joins owned run acknowledgement during close, rejects new work and leaves the Host ready', async () => {
    const fixture = await setup(); cleanup.push(() => fixture.dispose())
    const proxy = await faultProxy(fixture.service.ready.listen.port, { hold: 'host.run' }); cleanup.push(() => proxy.dispose())
    const service = await openHarnessAutomation({ config: config(fixture.directory, proxy.port), bearerToken }); cleanup.push(() => service.dispose())
    await service.accept('review', 'held', 'research'); await proxy.held
    let closed = false
    const first = service.dispose(), second = service.dispose(); expect(first).toBe(second)
    void first.then(() => { closed = true })
    await expect(service.accept('review', 'after-close', 'research')).rejects.toMatchObject({ code: 'AUTOMATION_INACTIVE' })
    await new Promise(resolve => setTimeout(resolve, 50)); expect(closed).toBe(false)
    proxy.release(); await first
    expect(service.status().lifecycle).toBe('closed')
    const client = createHarnessClient(await clientOptions(fixture.service.ready.listen.port)); cleanup.push(() => client.close())
    expect((await client.request('host.status', {})).hostStatus).toBe('ready')
  }, 30000)
  it('skips interval ticks while a real finite RPC is busy and admits only a future tick after release', async () => {
    const fixture = await setup(); cleanup.push(() => fixture.dispose())
    const proxy = await faultProxy(fixture.service.ready.listen.port, { hold: 'host.run' }); cleanup.push(() => proxy.dispose())
    const base = config(fixture.directory, proxy.port), settings = decodeAutomationConfig({ ...base, limits: { ...base.limits, observeIntervalMs: 5000 },
      jobs: [...base.jobs, { jobKey: 'periodic', agentKey: 'writer', trigger: { kind: 'interval', anchor: new Date(Date.now()).toISOString(), intervalMs: 100, text: 'scheduled' } }] })
    const service = await openHarnessAutomation({ config: settings, bearerToken }); cleanup.push(() => service.dispose())
    await service.accept('review', 'held', 'research'); await proxy.held
    await new Promise(resolve => setTimeout(resolve, 350))
    expect(service.status().triggers.filter(trigger => trigger.jobKey === 'periodic')).toHaveLength(0)
    proxy.release()
    await eventually(() => service.status().triggers.some(trigger => trigger.jobKey === 'periodic'))
    const scheduled = service.status().triggers.filter(trigger => trigger.jobKey === 'periodic')
    expect(scheduled).toHaveLength(1)
    expect(Number(scheduled[0]!.externalEventId.slice(5))).toBeGreaterThanOrEqual(4)
    await service.dispose()
  }, 30000)
  it('keeps webhook admission bounded while an unknown run blocks all driving', async () => {
    const fixture = await setup(); cleanup.push(() => fixture.dispose())
    const base = fixture.config, settings = decodeAutomationConfig({ ...base, limits: { ...base.limits, maxQueued: 1 } })
    const client = createHarnessClient(await clientOptions(fixture.service.ready.listen.port)); cleanup.push(() => client.close())
    const store = await openAutomationJournal(settings), old = (await store.journal.accept('review', 'unknown', 'research', 0, 1)).trigger
    await store.journal.append({ kind: 'submit-intent', triggerKey: old.triggerKey })
    const input = await client.request('input.submit', { agentKey: 'writer', submissionKey: old.triggerKey, text: old.text })
    await store.journal.append({ kind: 'submitted', triggerKey: old.triggerKey, inputEventId: input.inputEventId })
    await store.journal.append({ kind: 'run-intent', triggerKey: old.triggerKey }); await store.dispose()
    const service = await openHarnessAutomation({ config: settings, bearerToken }); cleanup.push(() => service.dispose())
    const body = { eventId: 'queued', text: 'new task' }
    expect((await webhookRequest(service.ready.listen.port, body)).status).toBe(202)
    expect((await webhookRequest(service.ready.listen.port, body)).body).toMatchObject({ reused: true })
    expect((await webhookRequest(service.ready.listen.port, { eventId: 'overflow', text: 'new task' })).status).toBe(429)
    expect(service.status()).toMatchObject({ driverBlocked: true, queued: 1 })
    expect((await client.request('input.get', { agentKey: 'writer', inputEventId: input.inputEventId })).status).toBe('queued')
    const queued = service.status().triggers.find(trigger => trigger.externalEventId === 'queued')!
    await expect(client.request('input.get', { agentKey: 'writer', submissionKey: queued.triggerKey })).rejects.toMatchObject({ code: 'API_TARGET_NOT_FOUND' })
  }, 30000)
  it.each([false, true])('keeps an unconfirmed submit read-only without reserving queue capacity (rejection recorded: %s)', async rejected => {
    const fixture = await setup(); cleanup.push(() => fixture.dispose())
    const proxy = await faultProxy(fixture.service.ready.listen.port); cleanup.push(() => proxy.dispose())
    const base = config(fixture.directory, proxy.port), settings = decodeAutomationConfig({ ...base, limits: { ...base.limits, maxQueued: 1 } })
    const client = createHarnessClient(await clientOptions(fixture.service.ready.listen.port)); cleanup.push(() => client.close())
    const store = await openAutomationJournal(settings), old = (await store.journal.accept('review', 'unconfirmed-submit', 'old input', 0, 1)).trigger
    await store.journal.append({ kind: 'submit-intent', triggerKey: old.triggerKey })
    await client.request('input.submit', { agentKey: 'writer', submissionKey: old.triggerKey, text: old.text })
    if (rejected) await store.journal.append({ kind: 'rejected', triggerKey: old.triggerKey, operation: 'submit', acceptance: 'unknown', code: 'ClientTransportError' })
    await store.dispose()
    const service = await openHarnessAutomation({ config: settings, bearerToken }); cleanup.push(() => service.dispose())
    await eventually(() => service.status().triggers[0]?.observation?.input?.status === 'queued')
    expect(service.status()).toMatchObject({ queued: 0, driverBlocked: false })
    expect((await webhookRequest(service.ready.listen.port, { eventId: 'new-trigger', text: 'new input' })).status).toBe(202)
    await eventually(() => service.status().triggers.every(trigger => trigger.execution === 'closed'))
    expect(proxy.methods.filter(method => method === 'input.submit')).toHaveLength(1)
    expect(proxy.methods.filter(method => method === 'host.run')).toHaveLength(1)
    expect(service.status().triggers[0]).toMatchObject({ inputEventId: null, runIntent: null, runAcceptance: 'not-started' })
  }, 30000)
  it('resumes accepted work with no intent and rejects a second writer or changed config without leaking its lock', async () => {
    const fixture = await setup(); cleanup.push(() => fixture.dispose())
    const store = await openAutomationJournal(fixture.config); await store.journal.accept('review', 'unstarted', 'research', 0, 1)
    await expect(openAutomationJournal(fixture.config)).rejects.toThrow(); await store.dispose()
    await expect(openAutomationJournal({ ...fixture.config, hostKey: 'different' })).rejects.toThrow()
    const service = await openHarnessAutomation({ config: fixture.config, bearerToken }); cleanup.push(() => service.dispose())
    await eventually(() => service.status().triggers[0]?.execution === 'closed')
    expect(service.status().triggers[0]).toMatchObject({ externalEventId: 'unstarted', runAcceptance: 'returned' })
  }, 30000)
  it('propagates notice emission failure after committing observation and releases local resources', async () => {
    const fixture = await setup(); cleanup.push(() => fixture.dispose())
    const service = await openHarnessAutomation({ config: fixture.config, bearerToken, onNotice: () => { throw new Error('fixture output failure') } })
    const closed = service.closed.catch(error => error as unknown)
    await service.accept('review', 'notice-failure', 'research')
    expect(await closed).toBeInstanceOf(Error)
    expect(service.status().lifecycle).toBe('failed')
    const store = await openAutomationJournal(fixture.config); cleanup.push(() => store.dispose())
    expect(store.journal.triggers[0]!.observation!.root!.outcome).toBe('completed')
  }, 30000)
})
