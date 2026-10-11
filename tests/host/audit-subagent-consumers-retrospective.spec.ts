import { expect, it } from 'vitest'
import { waitingDelegations } from './subagent-control-fixture.js'
import { authorizeControl, dispatchControl, localControlCaller, controlFailure } from '../../src/control/index.js'
import type { AnyControlOperation, ControlRequest } from '../../src/control/index.js'
import type { ControlMethod } from '../../src/protocol/index.js'
import type { AtomicHost } from '../../src/host/runtime.js'
import { collectExperimentMetrics } from '../../src/experiment/metrics.js'
import { SessionRepository } from '../../src/session/repository.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { parseSessionId } from '../../src/session/ids.js'

const limits = { maxWaitMs: 1000, observerScanIntervalMs: 5, maxPageEvents: 1000, pageBytes: 1048576 }
const profileKey = '16000000-0000-4000-8000-000000000161'

async function driveUntil(host: AtomicHost, condition: () => boolean): Promise<void> {
  while (!condition()) {
    const report = await host.run()
    if (!condition() && ['quiescent', 'no-progress'].includes(report.stoppedBy)) throw new Error('Host stopped before the observed condition')
  }
}

it('keeps Child cancellation within its Root, reads its released log and counts actual calls independently of grants', async () => {
  const fixture = await waitingDelegations({ count: 2 })
  const caller = localControlCaller(fixture.spec, profileKey)
  const invoke = async <M extends ControlMethod>(request: ControlRequest<M>) => {
    await authorizeControl(fixture.host, fixture.spec, caller, request as AnyControlOperation)
    return dispatchControl(fixture.host, fixture.spec, caller, request, limits, new AbortController().signal,
      mode => fixture.host.shutdown({ mode }), { domainReturned: false })
  }
  try {
    await driveUntil(fixture.host, () => fixture.childCalls() === 2)
    const first = fixture.parents[0]!.inspect(fixture.receipts[0]!.delegationId)
    const second = fixture.parents[1]!.inspect(fixture.receipts[1]!.delegationId)
    const target = { kind: 'child' as const, parentAgentKey: 'writer', parentRoot: first.parentRoot, delegationId: first.delegationId }
    const cut = await invoke({ method: 'session.events', params: { target, maxEvents: 1 } })
    const cancelled = await invoke({ method: 'delegation.cancel', params: { parentAgentKey: 'writer', parentRoot: first.parentRoot,
      delegationId: first.delegationId, requestKey: 'cancel-only-first' } })
    expect(cancelled.status).toBe('requested')
    await driveUntil(fixture.host, () => fixture.parents[0]!.inspect(first.delegationId).executionReleased)
    expect(await invoke({ method: 'delegation.get', params: { parentAgentKey: 'writer', parentRoot: first.parentRoot, delegationId: first.delegationId } }))
      .toMatchObject({ closed: false, executionReleased: true, businessResolved: true, adopted: false })
    expect(await invoke({ method: 'delegation.get', params: { parentAgentKey: 'writer', parentRoot: second.parentRoot, delegationId: second.delegationId } }))
      .toMatchObject({ closed: false, businessResolved: false, recoveryRequired: false })
    expect(fixture.host.read().root('writer', first.parentRoot).outcome).toBeNull()
    expect(fixture.host.read().root('writer', second.parentRoot).outcome).toBeNull()
    await invoke({ method: 'root.cancel', params: { agentKey: 'writer', rootId: first.parentRoot, reason: 'cancel-first-root' } })
    await driveUntil(fixture.host, () => fixture.parents[0]!.inspect(first.delegationId).closed)
    expect(fixture.parents[0]!.inspect(first.delegationId)).toMatchObject({ closed: true, inputDisposed: true, adopted: false })
    expect(fixture.host.read().root('writer', second.parentRoot).outcome).toBeNull()
    expect(fixture.parents[1]!.inspect(second.delegationId)).toMatchObject({ businessResolved: false, closed: false })
    const released = await invoke({ method: 'session.events', params: { target, maxEvents: 1000 } })
    expect(released.events.some(event => event.type === 'agent/run-settled')).toBe(true)
    const frozen = await invoke({ method: 'session.events', params: { target, maxEvents: 1000, cursor: cut.nextCursor! } })
    expect(frozen.through).toBe(cut.through)
    expect(frozen.events.some(event => event.sequence > cut.through)).toBe(false)
    expect(released.through).toBeGreaterThan(cut.through)
    const reader = new SessionRepository({ backend: new FileSessionBackend({ root: fixture.spec.storage.root,
      maxRecordBytes: fixture.spec.storage.maxRecordBytes }), catalog: hostRuntimeEventCatalog,
    maxLineageDepth: fixture.spec.storage.maxLineageDepth })
    try {
      const snapshots = await Promise.all([fixture.spec.members[0]!.sessionId, ...fixture.receipts.map(receipt => receipt.childSessionId)]
        .map(id => reader.read(parseSessionId(id))))
      const calls = fixture.childCalls()
      const metrics = collectExperimentMetrics({ snapshots, selectedSessionIds: snapshots.map(snapshot => snapshot.header.sessionId),
        scope: 'unit-local/v1', mode: 'fixture', maxMetricSamples: 1000,
        coverage: { complete: true, expectedSessions: 3, observedSessions: 3, reasons: [] } })
      expect(metrics.counts['subagent.requested'].value).toBe(2)
      expect(metrics.counts['subagent.closed'].value).toBe(1)
      expect(metrics.counts['model.prepared'].value).toBe(4)
      expect(metrics.tokens.outputTokens).toMatchObject({ total: null, eligibleCount: 4 })
      expect(fixture.childCalls()).toBe(calls)
    } finally { await reader.dispose() }
  } finally { await fixture.close() }
}, 60000)

it('rejects a Child selected under another owned Root as a missing target without appending control facts', async () => {
  const fixture = await waitingDelegations({ count: 2 })
  const caller = localControlCaller(fixture.spec, profileKey)
  const first = fixture.parents[0]!.inspect(fixture.receipts[0]!.delegationId)
  const second = fixture.parents[1]!.inspect(fixture.receipts[1]!.delegationId)
  const params = { parentAgentKey: 'writer', parentRoot: first.parentRoot, delegationId: second.delegationId }
  try {
    const before = await fixture.host.read().events({ kind: 'member', agentKey: 'writer' }, { maxEvents: 1000 })
    for (const method of ['delegation.get', 'delegation.wait', 'delegation.cancel'] as const) {
      const request = { method, params: method === 'delegation.wait' ? { ...params, until: 'closed', timeoutMs: 1 }
        : method === 'delegation.cancel' ? { ...params, requestKey: 'wrong-root' } : params } as AnyControlOperation
      let invoked = false
      const progress = { domainReturned: false }
      let failure: ReturnType<typeof controlFailure> | undefined
      try {
        await authorizeControl(fixture.host, fixture.spec, caller, request)
        invoked = true
        await dispatchControl(fixture.host, fixture.spec, caller, request, limits, new AbortController().signal,
          mode => fixture.host.shutdown({ mode }), progress)
      } catch (cause) { failure = controlFailure(cause, method, invoked, progress.domainReturned) }
      expect(failure).toMatchObject({ code: 'API_TARGET_NOT_FOUND',
        acceptance: method === 'delegation.cancel' ? 'not-accepted' : 'not-applicable', domainCode: 'HOST_TARGET_NOT_FOUND' })
    }
    const after = await fixture.host.read().events({ kind: 'member', agentKey: 'writer' }, { maxEvents: 1000 })
    expect(after.through).toBe(before.through)
  } finally { await fixture.close() }
}, 30000)
