import { expect, it } from 'vitest'
import type { HostTimer } from '../../src/index.js'
import { waitingDelegations } from './subagent-control-fixture.js'

function controlledTimer() {
  const pending = new Set<() => void>()
  const timer: HostTimer = { now: () => 0, wait: (_ms, signal) => new Promise(resolve => {
    const done = () => { pending.delete(done); signal.removeEventListener('abort', done); resolve() }
    pending.add(done); signal.addEventListener('abort', done, { once: true }); if (signal.aborted) done()
  }) }
  return { timer, pending, flush: () => { for (const done of [...pending]) done() } }
}

it.each(['drain', 'cancel', 'offline', 'caller'] as const)('settles a managed observer before %s completes without waiting for its long timer', async mode => {
  const time = controlledTimer()
  const f = await waitingDelegations({ count: 1, timer: time.timer })
  const abort = new AbortController()
  let observation: Promise<unknown> | undefined
  try {
    let settled = false
    observation = f.parents[0]!.wait(f.receipts[0]!.delegationId, { until: 'closed', signal: abort.signal }).then(
      value => { settled = true; return value }, error => { settled = true; return error })
    await new Promise(resolve => setImmediate(resolve))
    expect(time.pending.size).toBe(1)
    expect(f.host.report().unfinishedOperations).toBe(1)
    if (mode === 'caller') {
      abort.abort(new Error('observer-left'))
      await observation
      expect(f.parents[0]!.inspect(f.receipts[0]!.delegationId).businessResolved).toBe(false)
    } else if (mode === 'offline') await f.host.setMailboxOnline('writer', false)
    else {
      const closing = f.host.shutdown({ mode })
      expect(f.host.shutdown({ mode })).toBe(closing)
      await closing
    }
    expect(settled).toBe(true)
    expect(time.pending.size).toBe(0)
    if (f.host.status === 'ready') expect(f.host.report().unfinishedOperations).toBe(0)
    else expect(f.host.status).toBe('stopped')
  } finally { abort.abort(); time.flush(); await observation; await f.close() }
}, 30000)
