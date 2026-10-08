import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionRepository } from '../../src/session/repository.js'
import { MemorySessionBackend } from '../../src/session/memory-backend.js'
import { createFileSessionBackendForTest } from '../../src/session/file-backend.js'
import { parseSessionId } from '../../src/session/ids.js'
import { AutomationJournal, automationTriggerKey, openAutomationJournal } from '../../src/automation/journal.js'
import { automationCatalog } from '../../src/automation/events.js'
import { automationConfigDigest } from '../../src/automation/config.js'
import { config } from './fixtures.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function memory() {
  const repository = new SessionRepository({ backend: new MemorySessionBackend({ maxRecordBytes: 1048576 }), catalog: automationCatalog, maxLineageDepth: 0 })
  cleanup.push(() => repository.dispose())
  const session = await repository.create({ sessionId: parseSessionId('40000000-0000-4000-8000-000000000014') })
  const journal = new AutomationJournal(session, { automationKey: 'research', configDigest: 'a'.repeat(64), jobKeys: ['review'], maxTriggers: 2, maxEvents: 30 })
  await journal.initialize(); return { journal, session }
}
describe('automation durable journal', () => {
  it('deduplicates concurrent exact events and rejects altered contents or queue/lifetime overflow', async () => {
    const { journal } = await memory()
    const receipts = await Promise.all(Array.from({ length: 5 }, () => journal.accept('review', 'external/1', 'research', 0, 1)))
    expect(receipts.filter(receipt => !receipt.reused)).toHaveLength(1)
    expect(new Set(receipts.map(receipt => receipt.trigger.acceptedEventId)).size).toBe(1)
    expect(receipts[0]!.trigger.triggerKey).toBe(automationTriggerKey('research', 'review', 'external/1'))
    await expect(journal.accept('review', 'external/1', 'changed', 1, 1)).rejects.toMatchObject({ code: 'AUTOMATION_CONFLICT' })
    await expect(journal.accept('review', 'external/2', 'research', 1, 1)).rejects.toMatchObject({ code: 'AUTOMATION_LIMIT' })
    await journal.accept('review', 'external/2', 'research', 0, 1)
    await expect(journal.accept('review', 'external/3', 'research', 0, 1)).rejects.toMatchObject({ code: 'AUTOMATION_LIMIT' })
    expect(journal.triggers).toHaveLength(2)
  })
  it('rejects invalid phase order and acknowledgement of a returned run without writing it', async () => {
    const { journal, session } = await memory(), trigger = (await journal.accept('review', 'one', 'research', 0, 1)).trigger
    await expect(journal.append({ kind: 'run-intent', triggerKey: trigger.triggerKey })).rejects.toMatchObject({ code: 'AUTOMATION_JOURNAL_INVALID' })
    expect(session.snapshot().localPosition).toBe(2)
    await journal.append({ kind: 'submit-intent', triggerKey: trigger.triggerKey })
    await journal.append({ kind: 'submitted', triggerKey: trigger.triggerKey, inputEventId: trigger.acceptedEventId })
    const runIntent = await journal.append({ kind: 'run-intent', triggerKey: trigger.triggerKey })
    expect(journal.blockedRuns).toHaveLength(1)
    await journal.append({ kind: 'run-returned', triggerKey: trigger.triggerKey, instanceId: '40000000-0000-4000-8000-000000000100' })
    await expect(journal.append({ kind: 'run-unknown-acknowledged', triggerKey: trigger.triggerKey, runIntent })).rejects.toMatchObject({ code: 'AUTOMATION_JOURNAL_INVALID' })
    expect(journal.blockedRuns).toEqual([])
  })
  it('reopens the original File facts and rejects changed config while releasing its acquired lock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'automation-journal-')); cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const settings = config(directory, 1), first = await openAutomationJournal(settings)
    const accepted = await first.journal.accept('review', 'one', 'research', 0, 1); await first.dispose()
    await expect(openAutomationJournal({ ...settings, hostKey: 'changed' })).rejects.toThrow()
    const reopened = await openAutomationJournal(settings); cleanup.push(() => reopened.dispose())
    expect(reopened.journal.triggers[0]!.acceptedEventId).toBe(accepted.trigger.acceptedEventId)
    expect((await reopened.journal.accept('review', 'one', 'research', 1, 1)).reused).toBe(true)
  })
  it('retains a fully synced run intent after append acknowledgement loss and blocks after reopen', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'automation-ack-loss-')); cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const settings = config(directory, 1)
    let lose = false
    const backend = createFileSessionBackendForTest({ root: settings.journal.root, maxRecordBytes: settings.journal.maxRecordBytes }, {
      async writeAll(handle, bytes, position) { let offset = 0; while (offset < bytes.length) { const part = await handle.write(bytes, offset, bytes.length - offset, position + offset); offset += part.bytesWritten } },
      async sync(handle) { await handle.sync(); if (lose) { lose = false; throw new Error('fixture lost synced append acknowledgement') } } })
    const repository = new SessionRepository({ backend, catalog: automationCatalog, maxLineageDepth: 0 })
    const session = await repository.create({ sessionId: settings.journal.sessionId }), journal = new AutomationJournal(session,
      { automationKey: settings.automationKey, configDigest: automationConfigDigest(settings), jobKeys: settings.jobs.map(job => job.jobKey), maxTriggers: settings.journal.maxTriggers, maxEvents: settings.journal.maxEvents })
    await journal.initialize()
    const trigger = (await journal.accept('review', 'one', 'research', 0, 1)).trigger
    await journal.append({ kind: 'submit-intent', triggerKey: trigger.triggerKey }); await journal.append({ kind: 'submitted', triggerKey: trigger.triggerKey, inputEventId: trigger.acceptedEventId })
    lose = true; await expect(journal.append({ kind: 'run-intent', triggerKey: trigger.triggerKey })).rejects.toThrow()
    expect(journal.healthy).toBe(false); expect(journal.blockedRuns).toEqual([])
    await repository.dispose()
    const reopened = await openAutomationJournal(settings); cleanup.push(() => reopened.dispose())
    expect(reopened.journal.blockedRuns.map(value => value.triggerKey)).toEqual([trigger.triggerKey])
  })
})
