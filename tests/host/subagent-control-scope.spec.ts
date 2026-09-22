import { expect, it } from 'vitest'
import { openHost, formatSessionAddress, parseSessionId } from '../../src/index.js'
import { controlClock, waitingDelegations } from './subagent-control-fixture.js'

it('scopes an external cancel key to its delegation, including concurrent duplicate requests', async () => {
  const f = await waitingDelegations()
  let reopened: Awaited<ReturnType<typeof openHost>> | undefined
  try {
    const [a, b] = f.receipts
    const requests = await Promise.all([f.parents[0]!.cancel(a!.delegationId, 'same-cancel-key'), f.parents[0]!.cancel(a!.delegationId, 'same-cancel-key')])
    expect(requests[1]).toEqual(requests[0])
    const other = await f.parents[1]!.cancel(b!.delegationId, 'same-cancel-key')
    expect(other).not.toEqual(requests[0])
    const parentRoot = f.parents[0]!.inspect(a!.delegationId).parentRoot
    for (const relation of f.host.delegationReport().delegations) await f.host.cancel('writer', relation.parentRoot)
    await f.host.run()
    expect(f.host.delegationReport().unresolved).toBe(0)
    expect(f.childCalls()).toBe(0)
    expect(await f.parents[0]!.cancel(a!.delegationId, 'same-cancel-key')).toEqual(requests[0])
    await f.host.shutdown()
    reopened = await openHost(f.spec, { clock: controlClock, bindings: f.bindings })
    const parent = reopened.bindParent(formatSessionAddress(parseSessionId(f.spec.members[0]!.sessionId)), parentRoot)
    expect(await parent.cancel(a!.delegationId, 'same-cancel-key')).toEqual(requests[0])
    expect(await parent.cancel(a!.delegationId, 'new-cancel-key')).toEqual({ kind: 'already-closed' })
  } finally { await reopened?.shutdown(); await f.close() }
}, 30000)

it('takes a multi-root parent offline, releases both children and resumes only their protocol after restart', async () => {
  const f = await waitingDelegations()
  let reopened: Awaited<ReturnType<typeof openHost>> | undefined
  try {
    await f.host.run()
    expect(f.childCalls()).toBe(2)
    await f.host.setMailboxOnline('writer', false, 'cancel')
    await f.host.shutdown()
    reopened = await openHost(f.spec, { clock: controlClock, bindings: f.bindings })
    expect(reopened.resume('writer')).toMatchObject([{ status: 'resumed' }, { status: 'resumed' }])
    for (const relation of reopened.delegationReport().delegations) await reopened.cancel('writer', relation.parentRoot)
    await reopened.run()
    expect(reopened.delegationReport()).toMatchObject({ unresolved: 0, blocked: 0 })
    expect(f.childCalls()).toBe(2)
  } finally { await reopened?.shutdown(); await f.close() }
}, 40000)
