import { rm } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { openHost } from '../../src/host/runtime.js'
import { openOperatorConnection } from '../../src/operator/connection.js'
import { localFixture } from '../step15-operator-fixture.js'
import { twoMemberHostConfig } from '../host/fixtures.js'
import { waitingDelegations } from '../host/subagent-control-fixture.js'

it('captures local input identity and text before authorization awaits', async () => {
  const fixture = await localFixture()
  const connection = await openOperatorConnection(fixture.profile, {})
  try {
    const params = { agentKey: 'writer', submissionKey: 'captured-key', text: 'Captured text' }
    const task = connection.request('input.submit', params)
    params.submissionKey = 'changed-key'; params.text = 'Changed text'
    const receipt = await task
    const observation = await connection.request('input.get', { agentKey: 'writer', inputEventId: receipt.inputEventId })
    expect(observation.submission?.key).toBe('captured-key')
    const page = await connection.request('session.events', { target: { kind: 'member', agentKey: 'writer' }, maxEvents: fixture.profile.observation.maxPageEvents })
    expect(page.events.find(event => event.eventId === receipt.inputEventId)?.payload).toMatchObject({ input: { text: 'Captured text' } })
  } finally {
    await connection.close('cancel'); await rm(fixture.directory, { recursive: true, force: true })
  }
})

it('captures public keyed Host input and submission before queued admission', async () => {
  const fixture = await localFixture(), host = await openHost(fixture.spec)
  try {
    const input = { kind: 'task' as const, text: 'Captured input', originLabel: 'api:test' }
    const submission = { namespace: 'api:test', key: 'captured-key' }
    const task = host.submitKeyedInput('writer', input, submission)
    input.text = 'Changed input'; submission.key = 'changed-key'; submission.namespace = 'api:changed'
    const receipt = await task
    expect(host.read().input('writer', { inputEventId: receipt.inputEventId }).submission).toEqual({ namespace: 'api:test', key: 'captured-key' })
    const page = await host.read().events({ kind: 'member', agentKey: 'writer' }, { maxEvents: 100 })
    expect(page.events.find(event => event.eventId === receipt.inputEventId)?.payload).toMatchObject({ input: { text: 'Captured input' } })
    expect(await host.submitKeyedInput('writer', { kind: 'task', text: 'Captured input', originLabel: 'api:test' },
      { namespace: 'api:test', key: 'captured-key' })).toEqual({ ...receipt, reused: true })
  } finally {
    await host.shutdown({ mode: 'cancel' }); await rm(fixture.directory, { recursive: true, force: true })
  }
})

it('captures the public Host message command before queued Outbox admission', async () => {
  const fixture = await localFixture(twoMemberHostConfig), host = await openHost(fixture.spec)
  try {
    const command = { kind: 'send' as const, peerKey: 'reviewer', type: 'test/note', payloadVersion: 1, payloadJson: '{"text":"Captured message"}' }
    const task = host.sendMessage('writer', command)
    command.payloadJson = '{"text":"Changed message"}'
    const result = await task
    expect(result.command.status).toBe('outbox-accepted')
    expect(host.read().message('writer', result.command.messageId!, 'outbox').fact.envelope.payload).toEqual({ text: 'Captured message' })
    expect(host.read().message('writer', result.command.messageId!, 'outbox').fact.status).toBe('pending')
  } finally {
    await host.shutdown({ mode: 'cancel' }); await rm(fixture.directory, { recursive: true, force: true })
  }
})

it('captures the event target and page budget before queued reads', async () => {
  const fixture = await localFixture(twoMemberHostConfig), host = await openHost(fixture.spec)
  try {
    const target = { kind: 'member' as const, agentKey: 'writer' }, query = { maxEvents: 1 }
    const task = host.read().events(target, query)
    target.agentKey = 'reviewer'; query.maxEvents = 100
    const page = await task
    expect(page.sessionId).toBe(fixture.spec.members[0]!.sessionId)
    expect(page.events).toHaveLength(1); expect(page.hasMore).toBe(true)
  } finally {
    await host.shutdown({ mode: 'cancel' }); await rm(fixture.directory, { recursive: true, force: true })
  }
})

it('captures the nested event cursor while retaining its original fixed cut', async () => {
  const fixture = await localFixture(), host = await openHost(fixture.spec)
  try {
    const target = { kind: 'member' as const, agentKey: 'writer' }
    const first = await host.read().events(target, { maxEvents: 1 })
    const original = first.nextCursor!, cursor = { ...original }
    const task = host.read().events(target, { maxEvents: 1, cursor })
    cursor.nextSequence++
    const page = await task
    expect(page.sessionId).toBe(original.sessionId); expect(page.through).toBe(original.through)
    expect(page.events[0]!.sequence).toBe(original.nextSequence)
    await host.submitTask('writer', 'Later input')
    const rest = await host.read().events(target, { maxEvents: 100, cursor: page.nextCursor! })
    expect(rest.through).toBe(original.through)
    expect(rest.events.every(event => event.sequence <= original.through)).toBe(true)
  } finally {
    await host.shutdown({ mode: 'cancel' }); await rm(fixture.directory, { recursive: true, force: true })
  }
})

it.each(['direct', 'keyed'] as const)('captures the nested Wait of a %s Host answer before queued acceptance', async method => {
  const fixture = await waitingDelegations({ count: 1 })
  try {
    const root = fixture.host.read().agent('writer').report.roots[0]!.id
    const original = fixture.host.read().root('writer', root).waits[0]!.reference
    const wait = { ...original }
    const task = method === 'direct' ? fixture.host.submitAnswer('writer', wait, 'Captured answer')
      : fixture.host.submitKeyedInput('writer', { kind: 'answer', text: 'Captured answer', originLabel: 'api:test', wait },
        { namespace: 'api:test', key: 'captured-answer' })
    wait.index = 63
    const receipt = await task
    const id = 'inputEventId' in receipt ? receipt.inputEventId : receipt.eventId
    expect(fixture.host.read().input('writer', { inputEventId: id })).toMatchObject({ kind: 'answer', wait: original })
    expect(fixture.host.read().root('writer', root).outcome).toBeNull()
  } finally { await fixture.close() }
}, 30000)

it.each(['finite', 'legacy'] as const)('keeps a %s Parent observation bound to its original closed condition', async mode => {
  const fixture = await waitingDelegations({ count: 1, childResponse: 'Child result' })
  const abort = new AbortController()
  try {
    await fixture.host.run()
    const parent = fixture.parents[0]!, id = fixture.receipts[0]!.delegationId
    const before = parent.inspect(id)
    expect(before).toMatchObject({ resultAvailable: true, closed: false })
    if (mode === 'finite') {
      const query = { until: 'closed' as 'closed' | 'business', timeoutMs: 1 }
      const task = parent.wait(id, query)
      query.until = 'business'
      expect(await task).toMatchObject({ status: 'timeout', observation: { resultAvailable: true, closed: false } })
    } else {
      const query = { until: 'closed' as 'closed' | 'business', signal: abort.signal }
      const task = parent.wait(id, query)
      const observed = task.then(result => ({ result }), error => ({ error }))
      query.until = 'business'
      await Promise.resolve()
      abort.abort(new Error('observer-left'))
      expect(await observed).toMatchObject({ error: new Error('observer-left') })
    }
    expect(parent.inspect(id)).toEqual(before)
  } finally { abort.abort(); await fixture.close() }
}, 30000)
