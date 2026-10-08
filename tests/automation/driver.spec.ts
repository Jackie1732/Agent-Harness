import { writeFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createHarnessClient } from '../../src/client/client.js'
import { openAutomationJournal, automationTriggerKey } from '../../src/automation/journal.js'
import { AutomationDriver } from '../../src/automation/driver.js'
import type { AutomationNotice } from '../../src/automation/driver.js'
import { openHarnessAutomation } from '../../src/automation/runtime.js'
import { runAutomationCli } from '../../src/automation/cli.js'
import { clientOptions } from '../api/fixtures.js'
import { setup, config, faultProxy, bearerToken, eventually } from './fixtures.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
describe('single-attempt automation driving', () => {
  it('observes a real human Wait without calling it complete and later reads externally completed business facts', async () => {
    const key = automationTriggerKey('research', 'review', 'human-question'), fixture = await setup({ submissionKey: key, text: 'research' }); cleanup.push(() => fixture.dispose())
    const client = createHarnessClient(await clientOptions(fixture.service.ready.listen.port)); cleanup.push(() => client.close())
    const store = await openAutomationJournal(fixture.config); cleanup.push(() => store.dispose())
    const trigger = (await store.journal.accept('review', 'human-question', 'research', 0, 1)).trigger
    await store.journal.append({ kind: 'submit-intent', triggerKey: trigger.triggerKey })
    await store.journal.append({ kind: 'submitted', triggerKey: trigger.triggerKey, inputEventId: fixture.seededReceipt!.inputEventId })
    const notices: AutomationNotice[] = [], driver = new AutomationDriver({ config: fixture.config, journal: store.journal, client, now: Date.now, notice: async notice => { notices.push(notice) } })
    await driver.drive(trigger.triggerKey)
    expect(store.journal.get(key)!.observation!.root).toMatchObject({ outcome: null, waitingForUser: true })
    const root = await client.request('root.get', { agentKey: 'writer', rootId: store.journal.get(key)!.observation!.input!.rootId! })
    await client.request('input.answer', { agentKey: 'writer', submissionKey: 'answer-from-operator', wait: root.waits[0]!.reference, text: 'Use text.' })
    await client.request('host.run', { expectedInstanceId: fixture.service.ready.instanceId }); await driver.observe(key)
    expect(store.journal.get(key)!.observation!.root).toMatchObject({ outcome: 'completed', executionPending: false, waitingForUser: false })
    expect(notices.map(notice => notice.observation.root?.outcome)).toEqual([null, 'completed'])
  }, 30000)
  it.each(['submit-intent', 'submitted', 'run-intent'] as const)('restarts the durable %s cut without repeating earlier mutation stages', async cut => {
    const fixture = await setup(); cleanup.push(() => fixture.dispose())
    const proxy = await faultProxy(fixture.service.ready.listen.port); cleanup.push(() => proxy.dispose())
    const settings = config(fixture.directory, proxy.port), client = createHarnessClient(await clientOptions(proxy.port)); cleanup.push(() => client.close())
    const store = await openAutomationJournal(settings), trigger = (await store.journal.accept('review', `cut:${cut}`, 'research', 0, 1)).trigger
    await store.journal.append({ kind: 'submit-intent', triggerKey: trigger.triggerKey })
    const receipt = await client.request('input.submit', { agentKey: 'writer', submissionKey: trigger.triggerKey, text: trigger.text })
    if (cut !== 'submit-intent') await store.journal.append({ kind: 'submitted', triggerKey: trigger.triggerKey, inputEventId: receipt.inputEventId })
    if (cut === 'run-intent') await store.journal.append({ kind: 'run-intent', triggerKey: trigger.triggerKey })
    await store.dispose()
    const service = await openHarnessAutomation({ config: settings, bearerToken }); cleanup.push(() => service.dispose())
    await eventually(() => cut === 'submitted' ? service.status().triggers[0]?.execution === 'closed' : service.status().triggers[0]?.observation?.input !== null && service.status().triggers[0]?.observation !== null)
    expect(proxy.methods.filter(method => method === 'input.submit')).toHaveLength(1)
    expect(proxy.methods.filter(method => method === 'host.run')).toHaveLength(cut === 'submitted' ? 1 : 0)
    expect(service.status().driverBlocked).toBe(cut === 'run-intent')
    if (cut === 'submit-intent') expect(service.status().triggers[0]).toMatchObject({ inputEventId: null, runIntent: null, runAcceptance: 'not-started', observation: { input: { status: 'queued' } } })
  }, 30000)
  it('uses real input and Root facts, once-only finite run and independent certified cuts', async () => {
    const fixture = await setup(); cleanup.push(() => fixture.dispose())
    const client = createHarnessClient(await clientOptions(fixture.service.ready.listen.port)); cleanup.push(() => client.close())
    const store = await openAutomationJournal(fixture.config); cleanup.push(() => store.dispose())
    const notices: AutomationNotice[] = [], driver = new AutomationDriver({ config: fixture.config, journal: store.journal, client, now: Date.now, notice: async notice => { notices.push(notice) } })
    const trigger = (await store.journal.accept('review', 'one', 'research', 0, 1)).trigger
    await driver.drive(trigger.triggerKey); await driver.drive(trigger.triggerKey)
    const current = store.journal.get(trigger.triggerKey)!
    expect(current.runReturned).toBe(true); expect(current.observation!.root).toMatchObject({ outcome: 'completed', executionPending: false, waitingForUser: false })
    expect(current.observation!.input!.cuts.length).toBeGreaterThan(0); expect(current.observation!.root!.cuts.length).toBeGreaterThan(0)
    expect(notices).toHaveLength(1); expect(notices[0]!.runAcceptance).toBe('returned')
    const events = store.journal.snapshot.history.at(-1)!.events
    expect(events.filter(event => event.kind === 'known' && (event.payload as { kind?: string }).kind === 'run-intent')).toHaveLength(1)
    expect((await client.request('agent.get', { agentKey: 'writer' })).report.counts.roots).toBe(1)
  }, 30000)
  it('after a real submitted response loss freezes the old trigger, observes its input and never starts its first run', async () => {
    const fixture = await setup(); cleanup.push(() => fixture.dispose())
    const proxy = await faultProxy(fixture.service.ready.listen.port, { lose: 'input.submit' }); cleanup.push(() => proxy.dispose())
    const settings = config(fixture.directory, proxy.port), client = createHarnessClient(await clientOptions(proxy.port)); cleanup.push(() => client.close())
    const store = await openAutomationJournal(settings), notices: AutomationNotice[] = []
    const trigger = (await store.journal.accept('review', 'lost-submit', 'research', 0, 1)).trigger
    const driver = new AutomationDriver({ config: settings, journal: store.journal, client, now: Date.now, notice: async notice => { notices.push(notice) } })
    await driver.drive(trigger.triggerKey)
    expect(store.journal.get(trigger.triggerKey)).toMatchObject({ inputEventId: null, runIntent: null, rejection: { operation: 'submit', acceptance: 'unknown' }, observation: { input: { status: 'queued' } } })
    await store.dispose()
    const reopened = await openAutomationJournal(settings); cleanup.push(() => reopened.dispose())
    await new AutomationDriver({ config: settings, journal: reopened.journal, client, now: Date.now, notice: async () => undefined }).drive(trigger.triggerKey)
    expect(proxy.methods.filter(method => method === 'input.submit')).toHaveLength(1)
    expect(proxy.methods.filter(method => method === 'host.run')).toHaveLength(0)
    expect(notices[0]!.runAcceptance).toBe('not-started')
  }, 30000)
  it('a run response loss blocks all new triggers across File reopen; local acknowledgement only releases future work', async () => {
    const fixture = await setup(); cleanup.push(() => fixture.dispose())
    const proxy = await faultProxy(fixture.service.ready.listen.port, { lose: 'host.run' }); cleanup.push(() => proxy.dispose())
    const settings = config(fixture.directory, proxy.port), client = createHarnessClient(await clientOptions(proxy.port)); cleanup.push(() => client.close())
    const store = await openAutomationJournal(settings), trigger = (await store.journal.accept('review', 'lost-run', 'research', 0, 1)).trigger
    await new AutomationDriver({ config: settings, journal: store.journal, client, now: Date.now, notice: async () => undefined }).drive(trigger.triggerKey)
    expect(store.journal.blockedRuns.map(trigger => trigger.triggerKey)).toEqual([trigger.triggerKey])
    expect(store.journal.get(trigger.triggerKey)!.observation!.root!.outcome).toBe('completed')
    await store.journal.accept('review', 'queued-before-restart', 'another task', 0, 4); await store.dispose()
    const runtime = await openHarnessAutomation({ config: settings, bearerToken });
    expect(runtime.status().driverBlocked).toBe(true)
    await runtime.accept('review', 'queued-after-restart', 'another new task')
    await new Promise(resolve => setTimeout(resolve, settings.limits.observeIntervalMs * 2))
    expect(proxy.methods.filter(method => method === 'host.run')).toHaveLength(1)
    expect(proxy.methods.filter(method => method === 'input.submit')).toHaveLength(1)
    await runtime.dispose()
    const saved = join(fixture.directory, 'automation.json'); await writeFile(saved, JSON.stringify(settings))
    const output = new PassThrough(); let text = ''; output.on('data', chunk => { text += chunk.toString() })
    const beforeAck = proxy.methods.length
    expect(await runAutomationCli(['--config', saved, '--acknowledge-run-unknown', trigger.triggerKey], { stdin: new PassThrough(), stdout: output, stderr: new PassThrough() })).toBe(0)
    expect(proxy.methods).toHaveLength(beforeAck); expect(JSON.parse(text)).toMatchObject({ kind: 'automation-run-unknown-acknowledged', runAcceptance: 'unknown' })
    const resumed = await openHarnessAutomation({ config: settings, bearerToken }); cleanup.push(() => resumed.dispose())
    await eventually(() => resumed.status().triggers.filter(trigger => trigger.execution === 'closed').length === 3)
    expect(resumed.status().driverBlocked).toBe(false)
    expect(resumed.status().triggers.find(value => value.triggerKey === trigger.triggerKey)).toMatchObject({ runAcceptance: 'unknown', runUnknownAcknowledged: true })
    expect(proxy.methods.filter(method => method === 'input.submit')).toHaveLength(3)
    expect(proxy.methods.filter(method => method === 'host.run')).toHaveLength(3)
    await resumed.dispose()
    const finalStore = await openAutomationJournal(settings); cleanup.push(() => finalStore.dispose())
    const old = finalStore.journal.get(trigger.triggerKey)!
    expect(old.runReturned).toBe(false); expect(old.rejection).toMatchObject({ operation: 'run', acceptance: 'unknown' }); expect(old.runUnknownAcknowledged).toBe(true)
    expect(finalStore.journal.snapshot.history.at(-1)!.events.filter(event => event.kind === 'known'
      && (event.payload as { kind?: string; triggerKey?: string }).triggerKey === trigger.triggerKey && (event.payload as { kind?: string }).kind === 'run-intent')).toHaveLength(1)
  }, 30000)
})
