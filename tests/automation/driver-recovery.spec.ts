import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { openHarnessApiServer } from '../../src/api/server.js'
import { decodeApiConfig, resolveApiConfig } from '../../src/api/config.js'
import { createHarnessClient } from '../../src/client/client.js'
import { openAutomationJournal } from '../../src/automation/journal.js'
import { AutomationDriver } from '../../src/automation/driver.js'
import { openHarnessAutomation } from '../../src/automation/runtime.js'
import { apiConfig, clientOptions } from '../api/fixtures.js'
import { setup, config, bearerToken, eventually, faultProxy } from './fixtures.js'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

function loseInputAcknowledgement() {
  const original = FileSessionBackend.prototype.openWriter
  let armed = false
  const spy = vi.spyOn(FileSessionBackend.prototype, 'openWriter').mockImplementation(async function (this: FileSessionBackend, id) {
    const writer = await original.call(this, id)
    return { ...writer, append: async (position, event) => {
      const committed = await writer.append(position, event)
      if (armed && event.type === 'agent/input-accepted' && event.payloadVersion === 2) {
        armed = false; throw new Error('fixture durable input acknowledgement loss')
      }
      return committed
    } }
  })
  cleanup.push(() => { spy.mockRestore() })
  return { arm() { armed = true }, restore() { spy.mockRestore() } }
}

async function reopenApi(fixture: Awaited<ReturnType<typeof setup>>) {
  const port = fixture.service.ready.listen.port
  await fixture.service.dispose()
  const replacement = await openHarnessApiServer({ host: fixture.host,
    api: resolveApiConfig(decodeApiConfig({ ...await apiConfig(), listenPort: port }), fixture.host, fixture.directory), credentials: {} })
  cleanup.push(() => replacement.dispose())
  return replacement
}

describe('automation after live Host recovery', () => {
  it.each([false, true])('refreshes blocked observations before the first run and never repeats submit (refresh receipt lost: %s)', async loseRead => {
    const failure = loseInputAcknowledgement(), fixture = await setup(); cleanup.push(() => fixture.dispose())
    const proxy = await faultProxy(fixture.service.ready.listen.port); cleanup.push(() => proxy.dispose())
    const client = createHarnessClient(await clientOptions(proxy.port)); cleanup.push(() => client.close())
    const store = await openAutomationJournal(fixture.config); cleanup.push(() => store.dispose())
    const trigger = (await store.journal.accept('review', 'submitted-cut', 'research', 0, 1)).trigger
    await store.journal.append({ kind: 'submit-intent', triggerKey: trigger.triggerKey })
    const receipt = await client.request('input.submit', { agentKey: 'writer', submissionKey: trigger.triggerKey, text: trigger.text })
    await store.journal.append({ kind: 'submitted', triggerKey: trigger.triggerKey, inputEventId: receipt.inputEventId })
    failure.arm()
    await expect(client.request('input.submit', { agentKey: 'writer', submissionKey: 'other-input', text: 'other input' })).rejects.toMatchObject({ code: 'API_RECOVERY_REQUIRED' })
    const driver = new AutomationDriver({ config: fixture.config, journal: store.journal, client, now: Date.now, notice: async () => undefined })
    await driver.observe(trigger.triggerKey)
    expect(store.journal.get(trigger.triggerKey)!.observation!.recoveryRequired).toBe(true)
    await driver.drive(trigger.triggerKey)
    expect(store.journal.get(trigger.triggerKey)!.runIntent).toBeNull()
    expect(proxy.methods.filter(method => method === 'input.get')).toHaveLength(2)
    expect(proxy.methods.filter(method => method === 'host.run')).toHaveLength(0)
    failure.restore(); const replacement = await reopenApi(fixture)
    expect((await client.request('input.get', { agentKey: 'writer', inputEventId: receipt.inputEventId })).recoveryRequired).toBe(false)
    let activeDriver = driver
    if (loseRead) {
      const loss = await faultProxy(replacement.ready.listen.port, { lose: 'input.get' }); cleanup.push(() => loss.dispose())
      const losingClient = createHarnessClient(await clientOptions(loss.port)); cleanup.push(() => losingClient.close())
      activeDriver = new AutomationDriver({ config: fixture.config, journal: store.journal, client: losingClient, now: Date.now, notice: async () => undefined })
      await activeDriver.drive(trigger.triggerKey)
      expect(store.journal.get(trigger.triggerKey)).toMatchObject({ runIntent: null, observation: { readErrorCode: 'ClientTransportError' } })
      expect(loss.methods.filter(method => method === 'host.run')).toHaveLength(0)
      await activeDriver.drive(trigger.triggerKey); await activeDriver.drive(trigger.triggerKey)
      expect(loss.methods.filter(method => method === 'input.submit')).toHaveLength(0)
      expect(loss.methods.filter(method => method === 'host.run')).toHaveLength(1)
    } else {
      await activeDriver.drive(trigger.triggerKey); await activeDriver.drive(trigger.triggerKey)
      expect(proxy.methods.filter(method => method === 'host.run')).toHaveLength(1)
    }
    expect(proxy.methods.filter(method => method === 'input.submit')).toHaveLength(2)
    expect(store.journal.get(trigger.triggerKey)).toMatchObject({ runReturned: true, observation: {
      recoveryRequired: false, readErrorCode: null, root: { outcome: 'completed', instanceId: replacement.ready.instanceId } } })
  }, 30000)

  it('keeps a trigger read-only when its recovered Root was already completed by the operator', async () => {
    const failure = loseInputAcknowledgement(), fixture = await setup(); cleanup.push(() => fixture.dispose())
    const proxy = await faultProxy(fixture.service.ready.listen.port); cleanup.push(() => proxy.dispose())
    const client = createHarnessClient(await clientOptions(proxy.port)); cleanup.push(() => client.close())
    const store = await openAutomationJournal(fixture.config); cleanup.push(() => store.dispose())
    const trigger = (await store.journal.accept('review', 'externally-completed', 'research', 0, 1)).trigger
    await store.journal.append({ kind: 'submit-intent', triggerKey: trigger.triggerKey })
    const receipt = await client.request('input.submit', { agentKey: 'writer', submissionKey: trigger.triggerKey, text: trigger.text })
    await store.journal.append({ kind: 'submitted', triggerKey: trigger.triggerKey, inputEventId: receipt.inputEventId })
    failure.arm()
    await expect(client.request('input.submit', { agentKey: 'writer', submissionKey: 'other-input', text: 'other input' })).rejects.toMatchObject({ code: 'API_RECOVERY_REQUIRED' })
    const driver = new AutomationDriver({ config: fixture.config, journal: store.journal, client, now: Date.now, notice: async () => undefined })
    await driver.observe(trigger.triggerKey)
    expect(store.journal.get(trigger.triggerKey)!.observation!.recoveryRequired).toBe(true)
    failure.restore(); const replacement = await reopenApi(fixture)
    await client.request('host.run', { expectedInstanceId: replacement.ready.instanceId })
    await driver.drive(trigger.triggerKey)
    expect(store.journal.get(trigger.triggerKey)).toMatchObject({ runIntent: null, runReturned: false, observation: {
      recoveryRequired: false, readErrorCode: null, root: { outcome: 'completed', executionPending: false } } })
    expect(proxy.methods.filter(method => method === 'host.run')).toHaveLength(1)
  }, 30000)

  it('resumes a submitted restart cut after manual acknowledgement and Host recovery without replaying the unknown run', async () => {
    const failure = loseInputAcknowledgement(), fixture = await setup(); cleanup.push(() => fixture.dispose())
    const proxy = await faultProxy(fixture.service.ready.listen.port); cleanup.push(() => proxy.dispose())
    const client = createHarnessClient(await clientOptions(proxy.port)); cleanup.push(() => client.close())
    const settings = config(fixture.directory, proxy.port), first = await openAutomationJournal(settings); cleanup.push(() => first.dispose())
    const trigger = (await first.journal.accept('review', 'pending-submitted-cut', 'research', 0, 4)).trigger
    const blocker = (await first.journal.accept('review', 'unknown-run-cut', 'blocker task', 1, 4)).trigger
    for (const current of [trigger, blocker]) {
      await first.journal.append({ kind: 'submit-intent', triggerKey: current.triggerKey })
      const receipt = await client.request('input.submit', { agentKey: 'writer', submissionKey: current.triggerKey, text: current.text })
      await first.journal.append({ kind: 'submitted', triggerKey: current.triggerKey, inputEventId: receipt.inputEventId })
    }
    const runIntent = await first.journal.append({ kind: 'run-intent', triggerKey: blocker.triggerKey })
    await first.dispose()
    failure.arm()
    await expect(client.request('input.submit', { agentKey: 'writer', submissionKey: 'other-recovery-input', text: 'other input' })).rejects.toMatchObject({ code: 'API_RECOVERY_REQUIRED' })
    const blocked = await openHarnessAutomation({ config: settings, bearerToken }); cleanup.push(() => blocked.dispose())
    await eventually(() => blocked.status().triggers.find(value => value.triggerKey === trigger.triggerKey)?.observation?.recoveryRequired === true)
    expect(blocked.status().driverBlocked).toBe(true)
    await blocked.dispose(); failure.restore(); await reopenApi(fixture)
    const acknowledged = await openAutomationJournal(settings); cleanup.push(() => acknowledged.dispose())
    await acknowledged.journal.append({ kind: 'run-unknown-acknowledged', triggerKey: blocker.triggerKey, runIntent }); await acknowledged.dispose()
    const resumed = await openHarnessAutomation({ config: settings, bearerToken }); cleanup.push(() => resumed.dispose())
    expect(resumed.status().driverBlocked).toBe(false)
    await eventually(() => resumed.status().triggers.find(value => value.triggerKey === trigger.triggerKey)?.execution === 'closed')
    expect(resumed.status().triggers.find(value => value.triggerKey === trigger.triggerKey)!.runAcceptance).toBe('returned')
    expect(resumed.status().triggers.find(value => value.triggerKey === blocker.triggerKey)).toMatchObject({ runAcceptance: 'unknown', runUnknownAcknowledged: true })
    expect(proxy.methods.filter(method => method === 'input.submit')).toHaveLength(3)
    expect(proxy.methods.filter(method => method === 'host.run')).toHaveLength(1)
    await resumed.dispose()
    const final = await openAutomationJournal(settings); cleanup.push(() => final.dispose())
    const events = final.journal.snapshot.history.at(-1)!.events
    expect(events.filter(event => event.kind === 'known' && (event.payload as { kind?: string }).kind === 'run-intent')).toHaveLength(2)
    expect(final.journal.get(blocker.triggerKey)!.runReturned).toBe(false)
  }, 30000)
})
