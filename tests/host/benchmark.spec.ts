import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { decodeHostConfig, initializeHost, openHost, resolveHostConfig } from '../../src/index.js'
import { hostConfig } from './fixtures.js'

it('records Host observation cost for a long backlog and bounded scans across many slots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-benchmark-'))
  const base = hostConfig(root)
  const first = (base.members as readonly Record<string, unknown>[])[0]!
  const members = Array.from({ length: 16 }, (_, index) => ({ ...first, agentKey: `agent-${index}`,
    sessionId: `70000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    profile: { ...(first.profile as object), profileKey: `profile-${index}` },
    spec: { ...(first.spec as object), limits: { ...((first.spec as Record<string, object>).limits), maxPendingInputs: 256 } },
  }))
  const spec = resolveHostConfig(decodeHostConfig({ ...base, members,
    routes: members.map(member => ({ memberKey: member.agentKey, ownerHost: 'test-host', origin: null, serverName: null })) }, root))
  await initializeHost(spec)
  const host = await openHost(spec)
  try {
    for (let index = 0; index < 200; index++) await host.submitTask('agent-0', `pending-${index}`)
    host.pause('agent-0')
    const start = performance.now()
    for (let index = 0; index < 20; index++) expect(host.report().counts.pendingInputs).toBe(200)
    const observationMs = performance.now() - start
    const scan = performance.now()
    const run = await host.run()
    const scanMs = performance.now() - scan
    expect(run.businessRuns).toBe(0)
    expect(run.counts.members).toBe(16)
    console.log(JSON.stringify({ benchmark: 'host-observation', slots: 16, acceptedInputs: 200,
      fullReports: 20, observationMs: Math.round(observationMs), scanMs: Math.round(scanMs),
      includes: 'Agent and Communication projection; cached Session snapshot access; excludes file reopen and acquisition' }))
  } finally { await host.shutdown() }
}, 30_000)
