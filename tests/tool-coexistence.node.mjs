import assert from 'node:assert/strict'
import { test } from 'node:test'
import { h, fixture, deferred, catalog, toolLimits } from './helpers/tool-fixture.mjs'

for (const capacity of [1, 2]) {
  test(`T7-60 provider capacity ${capacity} is shared but Session facts stay isolated`, async () => {
    const entered = deferred(), release = deferred()
    await fixture(async f => {
      f.releaseOnCleanup(release)
      const peer = await f.repository.create()
      const second = f.makeRunner({ session: peer })
      const firstTask = f.runner.invoke({ name: 'echo', input: { n: 1 } })
      await entered.promise
      if (capacity === 1) {
        await assert.rejects(second.invoke({ name: 'echo', input: { n: 2 } }), { code: 'TOOL_PROVIDER_BUSY' })
        assert.equal(f.trace.starts, 1)
        assert.equal(second.snapshot().invocations[0].settled.payload.execution, 'not-started')
      } else {
        const peerResult = await second.invoke({ name: 'echo', input: { n: 2 } })
        assert.equal(peerResult.payload.outcome, 'succeeded')
        assert.deepEqual(peerResult.payload.result.value, { n: 2 })
        assert.equal(f.runner.snapshot().invocations[0].state, 'started')
        assert.equal(f.trace.starts, 2)
      }
      release.resolve(); const first = await firstTask
      assert.deepEqual(first.payload.result.value, { n: 1 })
      assert.equal(f.trace.closes, capacity === 1 ? 1 : 2)
      assert.notEqual(f.runner.snapshot().invocations[0].invocationId, second.snapshot().invocations[0].invocationId)
    }, { capacity, execute: async plan => {
      if (plan.input.n === 1) { entered.resolve(); await release.promise }
      return { kind: 'success', value: plan.input }
    } })
  })
}

test('T7-47/69 actual Mailbox appends between all Tool transitions without repeating policy or execution', async () => {
  await fixture(async f => {
    const directory = h.createSessionDirectory(), transport = h.createInProcessMessageTransport(directory)
    const service = new h.CommunicationService({ directory, transport, limits: {
      maxMessageBytes: 4096, maxPendingOutbox: 8, maxPendingInbox: 8, maxDeliveryAttempts: 4, maxAttemptsPerRun: 8,
    } })
    const definition = h.createMessageDefinition({ type: 'research/progress', payloadVersion: 1, decode: value => value })
    const messages = h.createMessageCatalog([definition])
    const peer = await f.repository.create()
    let sender, recipient
    try {
      sender = await service.attach(f.session, { catalog: messages, policy: h.allowAllCommunicationPolicy })
      recipient = await service.attach(peer, { catalog: messages, policy: h.allowAllCommunicationPolicy })
      const channelId = h.createChannelId(), seen = new Set()
      // This facade exposes the actual Handle and injects real Communication operations;
      // only the Tool's read->conditional-append window is delayed.
      const wrapped = {
        header: f.session.header, get status() { return f.session.status }, get maxRecordBytes() { return f.session.maxRecordBytes },
        supportsEventDefinition: value => f.session.supportsEventDefinition(value), snapshot: () => f.session.snapshot(),
        appendIfPosition: async (position, event, payload) => {
          if (!seen.has(event.type)) {
            seen.add(event.type)
            await sender.send(definition, { kind: 'root', recipient: recipient.address, channelId }, { point: event.type })
          }
          return f.session.appendIfPosition(position, event, payload)
        },
      }
      const runner = f.makeRunner({ session: wrapped, limits: { ...toolLimits, maxJournalConflicts: 2 } })
      const result = await runner.invoke({ name: 'echo', input: { n: 5 } })
      assert.equal(result.payload.outcome, 'succeeded'); assert.equal(seen.size, 4)
      assert.equal(f.trace.approvals, 1); assert.equal(f.trace.starts, 1)
      assert.equal(sender.snapshot().outbox.length, 4)
      const report = await service.createDispatcher(sender).dispatch()
      assert.equal(report.delivered, 4); assert.equal(recipient.snapshot().inbox.length, 4)
      for (const incoming of recipient.snapshot().inbox) await recipient.markProcessed(incoming.envelope.messageId)
      assert.equal(sender.snapshot().outbox.every(item => item.status === 'delivered'), true)
      assert.equal(h.projectToolSession(f.session.snapshot()).invocations.length, 1)
    } finally {
      await sender?.dispose(); await recipient?.dispose(); await service.dispose(); await transport.dispose(); await directory.dispose()
    }
  }, { catalog: catalog(h.communicationSessionEventDefinitions) })
})
