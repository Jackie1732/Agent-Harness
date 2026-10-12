import { afterEach, describe, expect, it } from 'vitest'
import type { JsonObject } from '../../src/foundation/json.js'
import { SessionRepository } from '../../src/session/repository.js'
import { MemorySessionBackend } from '../../src/session/memory-backend.js'
import { formatSessionEventId, sessionSequence } from '../../src/session/ids.js'
import { AutomationJournal } from '../../src/automation/journal.js'
import { automationCatalog } from '../../src/automation/events.js'
import { automationTriggerStatus } from '../../src/automation/runtime.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function memory() {
  const repository = new SessionRepository({ backend: new MemorySessionBackend({ maxRecordBytes: 1048576 }), catalog: automationCatalog, maxLineageDepth: 0 })
  cleanup.push(() => repository.dispose())
  const session = await repository.create()
  const options = { automationKey: 'research', configDigest: 'a'.repeat(64), jobKeys: ['review'], maxTriggers: 2, maxEvents: 30 }
  const journal = new AutomationJournal(session, options)
  await journal.initialize()
  const trigger = (await journal.accept('review', 'one', 'research', 0, 1)).trigger
  return { repository, session, journal, options, trigger }
}
async function unknownRun(fixture: Awaited<ReturnType<typeof memory>>) {
  const { journal, trigger } = fixture
  await journal.append({ kind: 'submit-intent', triggerKey: trigger.triggerKey })
  await journal.append({ kind: 'submitted', triggerKey: trigger.triggerKey, inputEventId: trigger.acceptedEventId })
  const runIntent = await journal.append({ kind: 'run-intent', triggerKey: trigger.triggerKey })
  await journal.append({ kind: 'rejected', triggerKey: trigger.triggerKey, operation: 'run', acceptance: 'unknown', code: 'ClientTransportError' })
  return runIntent
}

describe('automation Journal admission and read-only uncertainty', () => {
  it('captures a submitted receipt before caller mutation while preserving FIFO phase admission', async () => {
    const { journal, session, trigger } = await memory()
    const receipt = { kind: 'submitted' as const, triggerKey: trigger.triggerKey, inputEventId: trigger.acceptedEventId }
    const intent = journal.append({ kind: 'submit-intent', triggerKey: trigger.triggerKey })
    const submitted = journal.append(receipt)
    receipt.inputEventId = formatSessionEventId(session.header.sessionId, sessionSequence(99))
    await intent; await submitted
    expect(journal.get(trigger.triggerKey)!.inputEventId).toBe(trigger.acceptedEventId)
    expect(session.snapshot().history[0]!.events.at(-1)!.stored.payload).toMatchObject({ inputEventId: trigger.acceptedEventId })
  })
  it('captures nested observation sources before caller mutation', async () => {
    const { journal, session, trigger } = await memory()
    await journal.append({ kind: 'submit-intent', triggerKey: trigger.triggerKey })
    const observation = { observedAt: '2026-10-12T00:00:00.000Z', readErrorCode: null, recoveryRequired: false,
      input: { eventId: trigger.acceptedEventId, status: 'queued' as const, rootId: null, reason: null,
        instanceId: '40000000-0000-4000-8000-000000000100', cuts: [] as JsonObject[] }, root: null }
    const pending = journal.append({ kind: 'observed', triggerKey: trigger.triggerKey, observation })
    observation.recoveryRequired = true; observation.input.cuts.push({ sessionId: session.header.sessionId, through: 1 })
    await pending
    expect(journal.get(trigger.triggerKey)!.observation).toMatchObject({ recoveryRequired: false, input: { cuts: [] } })
  })
  it('rejects JSON invalid at invocation even when repaired later without poisoning admission', async () => {
    const { journal, trigger, session } = await memory()
    const fact = { kind: 'submit-intent' as const, triggerKey: trigger.triggerKey, unexpected: 'invalid' }
    const pending = journal.append(fact)
    delete (fact as { unexpected?: string }).unexpected
    await expect(pending).rejects.toMatchObject({ code: 'AUTOMATION_JOURNAL_INVALID' })
    expect(session.snapshot().localPosition).toBe(2)
    await journal.append({ kind: 'submit-intent', triggerKey: trigger.triggerKey })
    expect(session.snapshot().localPosition).toBe(3)
  })
  it('rejects acknowledgement after the preceding returned-run commit', async () => {
    const { journal, trigger } = await memory()
    await journal.append({ kind: 'submit-intent', triggerKey: trigger.triggerKey })
    await journal.append({ kind: 'submitted', triggerKey: trigger.triggerKey, inputEventId: trigger.acceptedEventId })
    const runIntent = await journal.append({ kind: 'run-intent', triggerKey: trigger.triggerKey })
    const returned = journal.append({ kind: 'run-returned', triggerKey: trigger.triggerKey, instanceId: '40000000-0000-4000-8000-000000000100' })
    const acknowledged = journal.append({ kind: 'run-unknown-acknowledged', triggerKey: trigger.triggerKey, runIntent })
    await returned
    await expect(acknowledged).rejects.toMatchObject({ code: 'AUTOMATION_JOURNAL_INVALID' })
    expect(journal.blockedRuns).toEqual([])
  })
  it('preserves unknown-run blocking when a consumer modifies the returned status', async () => {
    const fixture = await memory(), runIntent = await unknownRun(fixture)
    const { journal, session, trigger } = fixture, before = JSON.stringify(session.snapshot())
    expect(journal.blockedRuns).toHaveLength(1)
    const status = automationTriggerStatus(journal.get(trigger.triggerKey)!)
    Reflect.set(status.rejection!, 'acceptance', 'not-accepted')
    expect(JSON.stringify(session.snapshot())).toBe(before)
    expect(journal.get(trigger.triggerKey)!.rejection).toMatchObject({ operation: 'run', acceptance: 'unknown' })
    expect(journal.blockedRuns).toHaveLength(1)
    await journal.append({ kind: 'run-unknown-acknowledged', triggerKey: trigger.triggerKey, runIntent })
    expect(journal.blockedRuns).toEqual([])
    expect(automationTriggerStatus(journal.get(trigger.triggerKey)!)).toMatchObject({ runAcceptance: 'unknown', runUnknownAcknowledged: true })
  })
  it('rebuilds immutable rejected-run evidence while acknowledgement only releases the driver block', async () => {
    const fixture = await memory(), runIntent = await unknownRun(fixture)
    const { repository, session, options, trigger } = fixture
    await session.dispose()
    const reopened = await repository.open(session.header.sessionId), journal = new AutomationJournal(reopened, options)
    expect(journal.blockedRuns).toHaveLength(1)
    Reflect.set(automationTriggerStatus(journal.get(trigger.triggerKey)!).rejection!, 'acceptance', 'not-accepted')
    expect(journal.blockedRuns).toHaveLength(1)
    expect(reopened.snapshot().history[0]!.events.at(-1)!.stored.payload).toMatchObject({ kind: 'rejected', acceptance: 'unknown' })
    await journal.append({ kind: 'run-unknown-acknowledged', triggerKey: trigger.triggerKey, runIntent })
    await reopened.dispose()
    const final = new AutomationJournal(await repository.open(session.header.sessionId), options)
    expect(final.blockedRuns).toEqual([])
    expect(automationTriggerStatus(final.get(trigger.triggerKey)!)).toMatchObject({ runAcceptance: 'unknown', runUnknownAcknowledged: true,
      rejection: { operation: 'run', acceptance: 'unknown' } })
  })
})
