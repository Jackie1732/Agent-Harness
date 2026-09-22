import { expect, it } from 'vitest'
import { decodeHostConfig, resolveHostConfig, openHost, inspectHost, recoverHost } from '../../src/index.js'
import type { JsonObject } from '../../src/index.js'
import { controlClock, waitingDelegations } from './subagent-control-fixture.js'

it.each(['v1', 'removed-parent', 'disabled', 'removed-template'] as const)('discovers outstanding CP-D with %s configuration before any Provider is acquired', async kind => {
  const f = await waitingDelegations({ count: 1 })
  try {
    await f.host.shutdown()
    const { subagents, ...base } = f.config
    const observer = (base.members as JsonObject[])[1]!
    const config = { ...base, schemaVersion: kind === 'v1' ? 1 : 2,
      members: [observer], routes: (base.routes as JsonObject[]).filter(item => item.memberKey === 'observer'),
      ...(kind === 'v1' ? {} : { subagents: kind === 'disabled' ? { kind: 'disabled' } : { ...subagents as JsonObject,
        parents: [], ...(kind === 'removed-template' ? { templates: [] } : {}) } }) }
    const next = resolveHostConfig(decodeHostConfig(config, f.root))
    let acquired = 0
    await expect(openHost(next, { clock: controlClock, bindings: { createModelProvider: () => { acquired++; throw new Error('must not acquire') } } }))
      .rejects.toMatchObject({ code: 'HOST_RECOVERY_REQUIRED' })
    expect(acquired).toBe(0)
    await expect(inspectHost(next)).rejects.toMatchObject({ code: 'HOST_RECOVERY_REQUIRED' })
    await expect(recoverHost(next, { predecessorStopped: true, maxRecoveryWrites: 20, maxJournalConflicts: 4, clock: controlClock }))
      .rejects.toMatchObject({ code: 'HOST_RECOVERY_REQUIRED' })
  } finally { await f.close() }
}, 30000)

it('keeps a disabled parent in the managed obligation report without starting its Provider', async () => {
  const f = await waitingDelegations({ count: 1 })
  let reopened: Awaited<ReturnType<typeof openHost>> | undefined
  try {
    await f.host.shutdown()
    const members = (f.config.members as JsonObject[]).map(item => item.agentKey === 'writer' ? { ...item, enabled: false } : item)
    const spec = resolveHostConfig(decodeHostConfig({ ...f.config, members }, f.root))
    reopened = await openHost(spec, { clock: controlClock, bindings: f.bindings })
    expect(reopened.delegationReport()).toMatchObject({ count: 1, unresolved: 1 })
    expect(f.childCalls()).toBe(0)
  } finally { await reopened?.shutdown(); await f.close() }
})

it('allows a v1 member to run beside closed historical delegations and includes that history in explicit inspection', async () => {
  const f = await waitingDelegations({ count: 1 })
  let reopened: Awaited<ReturnType<typeof openHost>> | undefined
  try {
    await f.parents[0]!.cancel(f.receipts[0]!.delegationId, 'stop')
    await f.host.cancel('writer', f.host.delegationReport().delegations[0]!.parentRoot)
    await f.host.run()
    expect(f.host.delegationReport().unresolved).toBe(0)
    await f.host.shutdown()
    const { subagents: _domain, ...base } = f.config
    const observer = (base.members as JsonObject[])[1]!
    const spec = resolveHostConfig(decodeHostConfig({ ...base, schemaVersion: 1, members: [observer],
      routes: (base.routes as JsonObject[]).filter(item => item.memberKey === 'observer') }, f.root))
    const report = await inspectHost(spec, { protocolVersion: 2 })
    expect(report.subagents).toMatchObject({ count: 1, unresolved: 0 })
    reopened = await openHost(spec, { clock: controlClock })
    await reopened.submitTask('observer', 'Run the legacy Agent')
    expect((await reopened.run()).members[0]!.agent.final?.text).toBe('fixed answer')
  } finally { await reopened?.shutdown(); await f.close() }
}, 30000)
