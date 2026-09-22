import { expect, it, vi } from 'vitest'
import { HostSubagents } from '../../src/host/subagents.js'
import { waitingDelegations } from './subagent-control-fixture.js'

it.each(['run', 'serve'] as const)('preserves maintenance fairness across one-batch %s runs and one-member pages', async mode => {
  const f = await waitingDelegations({ batches: 1, ...(mode === 'serve' ? {
    timer: { now: () => 0, wait: () => new Promise<void>(resolve => setImmediate(resolve)) },
  } : {}) })
  let protocol = 0
  // Keep only the competing protocol candidate continuously eligible; Agent maintenance uses real durable waits.
  const candidate = vi.spyOn(HostSubagents.prototype, 'nextAction').mockImplementation(() => async () => { protocol++ })
  const stop = new AbortController()
  let serving: ReturnType<typeof f.host.serve> | undefined
  try {
    f.host.pause('writer')
    const waits = f.host.report().members[0]!.agent.waits
    expect(waits).toHaveLength(2)
    for (const wait of waits) await f.host.submitAnswer('writer', wait.reference, 'answer')
    if (mode === 'run') {
      for (let i = 0; i < 8; i++) expect((await f.host.run()).batches).toBe(1)
    } else {
      candidate.mockImplementation(() => async () => {
        protocol++
        if (protocol === 8) stop.abort()
      })
      serving = f.host.serve({ signal: stop.signal })
      await serving
    }
    expect(protocol).toBeGreaterThan(0)
    expect(f.host.report().members[0]!.agent.waits).toHaveLength(0)
  } finally { stop.abort(); await serving; candidate.mockRestore(); await f.close() }
}, 30000)
