import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { decodeHostConfig, initializeHost, openHost, resolveHostConfig } from '../../src/index.js'
import type { AtomicHost, JsonObject } from '../../src/index.js'
import { nodeHostTimer } from '../../src/host/timer.js'
import { twoMemberHostConfig } from './fixtures.js'
import { runnableWorkflowConfig } from '../workflow/host-fixture.js'

async function deliveryFixture(independentRecipient = false, pendingInbox = 1) {
  const directory = await mkdtemp(join(tmpdir(), 'host-head-cooldown-'))
  const config = twoMemberHostConfig(directory)
  const members: JsonObject[] = (config.members as readonly JsonObject[]).map(member => ({ ...member,
    spec: { ...(member.spec as JsonObject), maxDirectSendCommandsPerSession: 8 } }))
  if (independentRecipient) {
    const writer = members[0]!, reviewer = members[1]!
    const writerSpec = writer.spec as JsonObject
    members[0] = { ...writer, spec: { ...writerSpec, peers: [...(writerSpec.peers as readonly JsonObject[]),
      { key: 'observer', memberKey: 'observer', channelKey: 'shared' }] } }
    members.push({ ...reviewer, agentKey: 'observer', sessionId: '70000000-0000-4000-8000-000000000103',
      profile: { ...(reviewer.profile as JsonObject), profileKey: 'observer-generation' },
      model: { ...(reviewer.model as JsonObject), providerId: 'observer-provider' } })
  }
  const spec = resolveHostConfig(decodeHostConfig({ ...config, members,
    routes: [...(config.routes as readonly JsonObject[]), ...(independentRecipient ? [{ memberKey: 'observer', ownerHost: 'test-host', origin: null, serverName: null }] : [])],
    communication: { ...(config.communication as JsonObject), maxPendingInbox: pendingInbox },
    scheduling: { ...(config.scheduling as JsonObject), retryIntervalMs: 60_000, maxSlotsPerScan: members.length },
  }, directory))
  let now = Date.parse('2026-10-11T00:00:00.000Z'), interval = 0
  const clock = { now: () => now }
  await initializeHost(spec, { clock })
  const host = await openHost(spec, { clock, timer: { now: () => interval, wait: nodeHostTimer.wait } })
  for (const member of spec.members) host.pause(member.agentKey)
  return { host, advance: () => { now += 60_001; interval += 60_001 },
    close: async () => { await host.shutdown(); await rm(directory, { recursive: true, force: true }) } }
}

async function send(host: AtomicHost, text: string, peerKey = 'reviewer') {
  const accepted = await host.sendMessage('writer', { kind: 'send', peerKey, type: 'test/note', payloadVersion: 1, payloadJson: JSON.stringify({ text }) })
  expect(accepted.command.status).toBe('outbox-accepted')
  return accepted.command.messageId!
}

it('keeps a successor behind its cooling Channel head without consuming admission or writing facts', async () => {
  const f = await deliveryFixture()
  try {
    await send(f.host, 'fills recipient'); await f.host.run()
    const head = await send(f.host, 'retry head')
    expect(await f.host.run()).toMatchObject({ batches: 1, deliveryAttempts: 1, stoppedBy: 'no-progress' })
    const successor = await send(f.host, 'must remain behind')
    const cuts = f.host.report().cuts
    expect(await f.host.run()).toMatchObject({ batches: 0, deliveryAttempts: 0, stoppedBy: 'no-progress', counts: { pendingOutbox: 2 } })
    expect(f.host.report().cuts).toEqual(cuts)
    expect(f.host.read().message('writer', head, 'outbox').fact).toMatchObject({ status: 'pending', attemptCount: 1 })
    expect(f.host.read().message('writer', successor, 'outbox').fact).toMatchObject({ status: 'pending', attemptCount: 0 })
  } finally { await f.close() }
})

it('serves another recipient during a Channel cooldown and resumes the original head at its time gate', async () => {
  const f = await deliveryFixture(true)
  try {
    await send(f.host, 'fills reviewer'); await f.host.run()
    const head = await send(f.host, 'retry head'); await f.host.run()
    const successor = await send(f.host, 'later reviewer')
    const independent = await send(f.host, 'independent recipient', 'observer')
    expect(await f.host.run()).toMatchObject({ batches: 1, deliveryAttempts: 1, stoppedBy: 'no-progress', counts: { pendingOutbox: 2 } })
    expect(f.host.read().message('observer', independent, 'inbox').fact.status).toBe('pending')
    expect(f.host.read().message('writer', successor, 'outbox').fact).toMatchObject({ attemptCount: 0 })
    f.host.pauseRouting('writer'); f.host.resume('reviewer'); await f.host.run(); f.host.pause('reviewer')
    f.host.resumeRouting('writer'); f.advance()
    expect(await f.host.run()).toMatchObject({ batches: 1, deliveryAttempts: 2, counts: { pendingOutbox: 1 } })
    expect(f.host.read().message('writer', head, 'outbox').fact).toMatchObject({ status: 'delivered', attemptCount: 2 })
    expect(f.host.read().message('reviewer', head, 'inbox').fact.envelope.payload).toEqual({ text: 'retry head' })
    expect(f.host.read().message('writer', successor, 'outbox').fact).toMatchObject({ status: 'pending', attemptCount: 1 })
    expect(await f.host.run()).toMatchObject({ batches: 0, deliveryAttempts: 0, stoppedBy: 'no-progress' })
  } finally { await f.close() }
}, 30_000)

it('retains successive deliveries in one batch when their Channel head can proceed', async () => {
  const f = await deliveryFixture(false, 16)
  try {
    const first = await send(f.host, 'first'), second = await send(f.host, 'second')
    expect(await f.host.run()).toMatchObject({ batches: 1, deliveryAttempts: 2, stoppedBy: 'quiescent', counts: { pendingOutbox: 0 } })
    expect(f.host.read().message('reviewer', first, 'inbox').fact.envelope.channelSequence).toBe(1)
    expect(f.host.read().message('reviewer', second, 'inbox').fact.envelope.channelSequence).toBe(2)
  } finally { await f.close() }
})

it('keeps Agent observations consistent with the current Workflow execution selection through offline and replacement', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'host-read-selection-'))
  const config = runnableWorkflowConfig(directory)
  const spec = resolveHostConfig(decodeHostConfig({ ...config, scheduling: { ...config.scheduling, maxBatchesPerRun: 1 } }, directory))
  await initializeHost(spec)
  const host = await openHost(spec)
  const compare = () => {
    const report = host.report()
    for (const member of report.members) expect(host.read().agent(member.agentKey).readiness).toEqual(member.readiness)
    return report
  }
  try {
    await host.workflow('research').resume({ requestKey: 'begin' })
    for (let count = 0; count < 20 && !compare().members[0]!.readiness.canRun; count++) await host.run()
    expect(compare().members[0]!.readiness).toMatchObject({ canRun: true, counts: { runnableInputs: 1 } })
    await host.setMailboxOnline('writer', false)
    expect(host.read().agent('writer')).toMatchObject({ mailbox: 'known-offline', paused: true })
    expect(compare().counts.runnableInputs).toBe(0)
    await host.setMailboxOnline('writer', true)
    compare(); host.resume('writer')
    for (let count = 0; count < 100 && !host.read().workflow('research').closed; count++) { await host.run(); compare() }
    expect(host.read().workflow('research').closed).toBe(true)
    const ordinary = await host.submitTask('writer', 'ordinary work after Workflow')
    for (let count = 0; count < 5 && !compare().members[0]!.readiness.canRun; count++) await host.run()
    expect(compare().members[0]!.readiness.canRun).toBe(true)
    for (let count = 0; count < 6 && host.read().input('writer', { inputEventId: ordinary.eventId }).status !== 'handled'; count++) await host.run()
    const handled = host.read().input('writer', { inputEventId: ordinary.eventId })
    expect(handled.status).toBe('handled')
    expect(host.read().root('writer', handled.rootId!).outcome).toBe('completed')
    compare()
  } finally { await host.shutdown(); await rm(directory, { recursive: true, force: true }) }
}, 40_000)
