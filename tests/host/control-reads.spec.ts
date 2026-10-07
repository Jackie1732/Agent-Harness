import { expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeHostConfig, resolveHostConfig, initializeHost, openHost, parseSessionId, formatSessionAddress, formatSessionEventId, sessionSequence, sessionLogPosition } from '../../src/index.js'
import { hostConfig, twoMemberHostConfig } from './fixtures.js'
import { mergeCuts } from '../../src/host/read-cuts.js'
import { readEventPage } from '../../src/host/read-events.js'
import { waitingDelegations, controlRequest } from './subagent-control-fixture.js'
import { runnableWorkflowConfig } from '../workflow/host-fixture.js'

async function fixture(two = false) {
  const directory = await mkdtemp(join(tmpdir(), 'control-reads-'))
  const spec = resolveHostConfig(decodeHostConfig(two ? twoMemberHostConfig(directory) : hostConfig(directory), directory))
  await initializeHost(spec)
  const host = await openHost(spec)
  return { directory, host, close: async () => { await host.shutdown(); await rm(directory, { recursive: true, force: true }) } }
}

it('queries the exact local input and completed Root through their persistent identities', async () => {
  const f = await fixture()
  try {
    const accepted = await f.host.submitKeyedInput('writer', { kind: 'task', text: 'First', originLabel: 'api:researcher' }, { namespace: 'api:researcher', key: 'first' })
    const queued = f.host.read().input('writer', { inputEventId: accepted.inputEventId })
    expect(queued).toMatchObject({ kind: 'task', status: 'queued', rootId: null, claimedBy: null, wait: null })
    await f.host.run()
    const first = f.host.read().input('writer', { namespace: 'api:researcher', key: 'first' })
    expect(first).toMatchObject({ status: 'handled', rootId: expect.any(String) })
    const root = f.host.read().root('writer', first.rootId!)
    expect(root).toMatchObject({ outcome: 'completed', executionPending: false, recoveryRequired: false, final: { text: 'fixed answer', textBytes: 12, textOmitted: false } })
    await f.host.submitTask('writer', 'Second')
    await f.host.run()
    expect(f.host.read().root('writer', first.rootId!).final).toEqual(root.final)
    expect(f.host.read().root('writer', first.rootId!, 2).final).toMatchObject({ text: null, textOmitted: true, textBytes: 12 })
    expect(f.host.read().status().cuts).toEqual(f.host.report().cuts)
    const read = f.host.read()
    expect(Object.keys(read)).toEqual([])
    // @ts-expect-error Online reads do not expose Host resource assembly.
    expect(read.options).toBeUndefined()
    expect(() => f.host.read().input('writer', { namespace: 'api:other', key: 'first' })).toThrowError(/input-not-certified/)
  } finally { await f.close() }
})

it('observes a closed delegation after its Parent goes offline and rejects mutations through either binding', async () => {
  const f = await waitingDelegations({ count: 1 })
  try {
    await f.host.run()
    const root = f.host.read().agent('writer').report.roots[0]!.id, id = f.receipts[0]!.delegationId
    await f.host.cancel('writer', root)
    await f.host.run()
    expect(f.host.read().delegation('writer', root, id)).toMatchObject({ closed: true, recoveryRequired: false })
    const online = f.parents[0]!
    await f.host.setMailboxOnline('writer', false)
    expect(f.host.read().agent('writer').mailbox).toBe('known-offline')
    await expect(online.spawn('same-spawn-key', controlRequest)).rejects.toMatchObject({ code: 'HOST_INACTIVE' })
    await expect(online.cancel(id, 'after-offline')).rejects.toMatchObject({ code: 'HOST_INACTIVE' })
    const offline = f.host.bindParent(formatSessionAddress(parseSessionId(f.spec.members[0]!.sessionId)), root)
    expect(offline.inspect(id)).toMatchObject({ closed: true })
    expect(await offline.wait(id, { until: 'closed', timeoutMs: 1 })).toMatchObject({ status: 'condition-met', observation: { closed: true, recoveryRequired: false } })
    await expect(offline.spawn('same-spawn-key', controlRequest)).rejects.toMatchObject({ code: 'HOST_INACTIVE' })
    await expect(offline.cancel(id, 'after-offline')).rejects.toMatchObject({ code: 'HOST_INACTIVE' })
    await f.host.setMailboxOnline('writer', true)
    f.host.resume('writer')
    for (const previous of [online, offline]) {
      await expect(previous.spawn('same-spawn-key', controlRequest)).rejects.toMatchObject({ code: 'HOST_INACTIVE' })
      await expect(previous.cancel(id, 'after-reattach')).rejects.toMatchObject({ code: 'HOST_INACTIVE' })
    }
    const current = f.host.bindParent(formatSessionAddress(parseSessionId(f.spec.members[0]!.sessionId)), root)
    expect(await current.spawn('same-spawn-key', controlRequest)).toEqual(f.receipts[0])
    expect(await current.cancel(id, 'after-reattach')).toEqual({ kind: 'already-closed' })
  } finally { await f.close() }
}, 30000)

it('reads a fixed event cut while new inputs append and rejects cross-target or byte-limited cursors', async () => {
  const f = await fixture()
  try {
    const first = await f.host.read().events({ kind: 'member', agentKey: 'writer' }, { maxEvents: 1 })
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor!.nextSequence).toBe(2)
    await f.host.submitTask('writer', 'Appended after the cut')
    const rest = await f.host.read().events({ kind: 'member', agentKey: 'writer' }, { maxEvents: 100, cursor: first.nextCursor! })
    expect(rest.through).toBe(first.through)
    expect(rest.events.at(-1)!.sequence).toBe(first.through)
    expect(rest).toMatchObject({ hasMore: false, nextCursor: null })
    const later = await f.host.read().events({ kind: 'member', agentKey: 'writer' }, { maxEvents: 100, after: first.through })
    expect(later.events).toHaveLength(1)
    expect(later.events[0]!.type).toBe('agent/input-accepted')
    const empty = await f.host.read().events({ kind: 'member', agentKey: 'writer' }, { maxEvents: 100, after: later.through })
    expect(empty).toMatchObject({ events: [], nextCursor: null, hasMore: false })
    await expect(f.host.read().events({ kind: 'member', agentKey: 'writer' }, { maxEvents: 100, cursor: { ...first.nextCursor!, sessionId: parseSessionId('70000000-0000-4000-8000-000000000199') } })).rejects.toMatchObject({ code: 'HOST_CURSOR_INVALID' })
    await expect(f.host.read().events({ kind: 'member', agentKey: 'writer' }, { maxEvents: 100, maxBytes: 10 })).rejects.toMatchObject({ code: 'HOST_LIMIT_EXCEEDED' })
  } finally { await f.close() }
})

it('returns exact command receipts beyond the displayed report limit and preserves Outbox versus Inbox facts', async () => {
  const f = await fixture(true)
  try {
    const sent = await f.host.sendMessage('writer', { kind: 'send', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1, payloadJson: '{"text":"review"}' })
    expect(sent.command).toMatchObject({ status: 'outbox-accepted', commandEventId: expect.any(String), action: { index: 0 }, messageId: expect.any(String), outboxAcceptedEventId: expect.any(String), reason: null })
    expect(sent.command.action!.eventId).toBe(sent.command.commandEventId)
    expect(f.host.read().message('writer', sent.command.messageId!, 'outbox').fact.status).toBe('pending')
    await f.host.run()
    expect(f.host.read().message('writer', sent.command.messageId!, 'outbox').fact.status).toBe('delivered')
    expect(f.host.read().message('reviewer', sent.command.messageId!, 'inbox').fact.status).toBe('processed')
    await f.host.sendMessage('writer', { kind: 'send', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1, payloadJson: '{"text":"second"}' })
    const rejected = await f.host.sendMessage('writer', { kind: 'send', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1, payloadJson: '{"text":"third"}' })
    expect(rejected.command).toMatchObject({ status: 'not-accepted', commandEventId: null, action: null, messageId: null, outboxAcceptedEventId: null, reason: 'direct-send-budget' })
  } finally { await f.close() }
})

it('keeps scalar shutdown state usable after resource release and stops all online reads', async () => {
  const f = await fixture()
  try {
    await f.host.shutdown({ mode: 'drain' })
    expect(f.host.shutdownState).toEqual({ status: 'stopped', mode: 'drain', releasing: true })
    await f.host.shutdown({ mode: 'cancel' })
    expect(f.host.shutdownState.mode).toBe('drain')
    expect(() => f.host.read()).toThrowError(/host-not-ready/)
  } finally { await f.close() }
})

it('normalizes inherited and local coverage by the longest certified prefix without asserting a shared observation time', () => {
  const sessionId = parseSessionId('70000000-0000-4000-8000-000000000101')
  expect(mergeCuts([{ sessionId, through: sessionLogPosition(3) }, { sessionId, through: sessionLogPosition(8) }, { sessionId, through: sessionLogPosition(5) }])).toEqual([{ sessionId, through: 8 }])
})

it('preserves unknown ignorable envelopes and rejects a missing local prefix', async () => {
  const sessionId = parseSessionId('70000000-0000-4000-8000-000000000101')
  const stored = { envelopeVersion: 1 as const, sessionId, sequence: sessionSequence(1), eventId: formatSessionEventId(sessionId, sessionSequence(1)), recordedAt: '2026-10-07T00:00:00.000Z', type: 'future/observation', payloadVersion: 1, ignorable: true as const, payload: { arbitrary: 'retained' } }
  const header = { formatVersion: 1 as const, sessionId, address: formatSessionAddress(sessionId), createdAt: stored.recordedAt }
  const snapshot = { header, address: header.address, lifecycle: 'active' as const, localPosition: sessionLogPosition(1), history: [{ header, localLifecycle: 'active' as const, through: sessionLogPosition(1), events: [{ kind: 'opaque' as const, stored }] }] }
  expect(readEventPage(snapshot, { maxEvents: 1 }).events).toEqual([stored])
  expect(() => readEventPage({ ...snapshot, localPosition: sessionLogPosition(2) }, { maxEvents: 2 })).toThrowError(/event-cursor-prefix-missing/)
})

it('preserves one unresolved Child per Root and lets another Root produce protocol facts after a targeted cancel', async () => {
  const f = await waitingDelegations({ count: 2, childResponse: 'independent result' })
  try {
    const parent = f.parents[0]!, a = f.receipts[0]!
    const other = f.parents[1]!, b = f.receipts[1]!
    await expect(parent.spawn('second-child', { ...controlRequest, task: 'Same Root concurrent Child' })).rejects.toMatchObject({ code: 'SUBAGENT_STATE_INVALID', message: 'unresolved-delegation' })
    await parent.cancel(a.delegationId, 'cancel-A')
    await f.host.run()
    expect(f.childCalls()).toBe(1)
    expect(other.inspect(b.delegationId)).toMatchObject({ resultAvailable: true, businessResolved: true, executionReleased: true })
    const relation = f.host.read().delegation('writer', other.inspect(b.delegationId).parentRoot, b.delegationId)
    const child = await f.host.read().events({ kind: 'child', parentAgentKey: 'writer', parentRoot: relation.parentRoot, delegationId: b.delegationId }, { maxEvents: 1000 })
    expect(child.events.some(item => item.type === 'subagent/protocol-recorded' && (item.payload as { kind?: string }).kind === 'result')).toBe(true)
    expect(child.events.some(item => item.type === 'subagent/control-requested')).toBe(false)
    await f.host.cancel('writer', relation.parentRoot)
    await f.host.run()
    expect(other.inspect(b.delegationId).closed).toBe(true)
    const retired = await f.host.read().events({ kind: 'child', parentAgentKey: 'writer', parentRoot: relation.parentRoot, delegationId: b.delegationId }, { maxEvents: 1000 })
    expect(retired.events.length).toBeGreaterThanOrEqual(child.events.length)
  } finally { await f.close() }
}, 40000)

it('observes a Parent deadline in its original owner without running or cancelling the Child', async () => {
  const f = await waitingDelegations({ count: 1 })
  try {
    const result = await f.parents[0]!.wait(f.receipts[0]!.delegationId, { until: 'closed', timeoutMs: 5 })
    expect(result).toMatchObject({ status: 'timeout', observation: { delegationId: f.receipts[0]!.delegationId, closed: false, recoveryRequired: false } })
    expect(result.observation.cuts).toHaveLength(1)
    expect(f.childCalls()).toBe(0)
    expect(f.host.report().unfinishedOperations).toBe(0)
  } finally { await f.close() }
})

it('reads only accepted Workflow values and frozen text artifacts with their exact decision sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-workflow-'))
  const spec = resolveHostConfig(decodeHostConfig(runnableWorkflowConfig(directory), directory))
  await initializeHost(spec)
  const host = await openHost(spec)
  try {
    expect(host.read().output('research', 'read').status).toBe('not-available')
    expect(host.read().workflow('research').recoveryRequired).toBe(false)
    await host.workflow('research').resume({ requestKey: 'begin' })
    await host.run()
    const value = host.read().output('research', 'read')
    expect(value).toMatchObject({ status: 'available', value: { text: 'accepted upstream' }, decisionRef: { address: expect.any(String), eventId: expect.any(String) } })
    const observation = host.read().workflow('research')
    expect(observation).toMatchObject({ settled: true, closed: true, recoveryRequired: false })
    const artifact = host.read().artifact('research', observation.artifacts[0]!.ref)
    expect(artifact).toMatchObject({ text: 'final report', byteLength: 12, mediaType: 'text/plain' })
    expect(host.read().output('research', 'write')).toMatchObject({ status: 'available', value: 'final report', decisionRef: { eventId: expect.any(String) } })
    expect(artifact.assignmentRef).not.toEqual(artifact.decisionRef)
    expect(() => host.read().artifact('research', { address: formatSessionAddress(parseSessionId('87000000-0000-4000-8000-000000000099')), eventId: formatSessionEventId(parseSessionId('87000000-0000-4000-8000-000000000099'), sessionSequence(1)) })).toThrowError(/accepted-artifact-not-certified/)
    expect(() => host.read().output('research', 'missing')).toThrowError(/workflow-node-unknown/)
  } finally { await host.shutdown(); await rm(directory, { recursive: true, force: true }) }
}, 40000)
