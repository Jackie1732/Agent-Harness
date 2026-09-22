import { expect, it, vi } from 'vitest'
import { FileSessionBackend, SessionRepository, hostRuntimeEventCatalog, parseSessionId, projectAgentSession, projectCommunicationFacts } from '../../src/index.js'
import { SessionMailboxImpl } from '../../src/communication/mailbox.js'
import { ChildInstance } from '../../src/host/child-instance.js'
import { nodeHostTimer } from '../../src/host/timer.js'
import { waitingDelegations } from './subagent-control-fixture.js'

it.each(['rejected', 'exhausted'] as const)('settles a %s result with management evidence and no copied result body', async kind => {
  const secret = 'child-result-that-was-never-delivered'
  let now = Date.parse('2026-09-22T00:00:00Z')
  const f = await waitingDelegations({ count: 1, childResponse: secret, clock: { now: () => now },
    timer: { now: () => now, wait: nodeHostTimer.wait } })
  const receive = SessionMailboxImpl.prototype.acceptDelivery
  let attempts = 0
  const rejection = vi.spyOn(SessionMailboxImpl.prototype, 'acceptDelivery').mockImplementation(function (this: SessionMailboxImpl, envelope, ...rest) {
    if (envelope.type === 'subagent/result') {
      attempts++
      return Promise.resolve(kind === 'rejected' ? { kind: 'rejected', code: 'receive-forbidden' } : { kind: 'retry', code: 'recipient-backpressure' })
    }
    return receive.call(this, envelope, ...rest)
  })
  try {
    await f.host.run()
    const id = f.receipts[0]!.delegationId
    if (kind === 'exhausted') {
      for (let i = 0; i < f.spec.communication.maxDeliveryAttempts; i++) {
        now += f.spec.scheduling.retryIntervalMs + 1
        await f.host.run()
      }
    }
    await f.host.cancel('writer', f.host.delegationReport().delegations[0]!.parentRoot)
    await f.host.run()
    expect(f.parents[0]!.inspect(id)).toMatchObject({ closed: true, adopted: false, failed: true })
    await f.host.shutdown()
    const repo = new SessionRepository({ backend: new FileSessionBackend({ root: f.root, maxRecordBytes: f.spec.storage.maxRecordBytes }), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      const snapshot = await repo.read(parseSessionId(f.spec.members[0]!.sessionId))
      expect(JSON.stringify(snapshot)).not.toContain(secret)
      expect(projectCommunicationFacts(snapshot).inbox.filter(item => item.envelope.type === 'subagent/result')).toHaveLength(0)
      expect(projectAgentSession(snapshot).subagents.delegations).toHaveLength(1)
    } finally { await repo.dispose() }
    expect(attempts).toBe(kind === 'rejected' ? 1 : f.spec.communication.maxDeliveryAttempts)
    expect(f.childCalls()).toBe(1)
  } finally { rejection.mockRestore(); await f.close() }
}, 30000)

it('attempts every child release even when one release reports an error', async () => {
  const f = await waitingDelegations()
  const released: string[] = []
  const dispose = ChildInstance.prototype.dispose
  const failure = vi.spyOn(ChildInstance.prototype, 'dispose').mockImplementation(async function (this: ChildInstance) {
    await dispose.call(this)
    released.push(this.identity.delegation)
    if (released.length === 1) throw new Error('injected release acknowledgement loss')
  })
  try {
    await f.host.run()
    await expect(f.host.setMailboxOnline('writer', false, 'cancel')).rejects.toMatchObject({ code: 'HOST_CLEANUP_FAILED' })
    expect(new Set(released).size).toBe(2)
    expect(f.host.delegationReport().unresolved).toBe(2)
  } finally { failure.mockRestore(); await f.close() }
}, 30000)
