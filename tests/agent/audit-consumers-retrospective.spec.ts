import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { decodeHostConfig, resolveHostConfig, initializeHost, openHost } from '../../src/index.js'
import type { AtomicHost } from '../../src/index.js'
import { ChildInstance } from '../../src/host/child-instance.js'
import { HostObservations } from '../../src/host/observation.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { hostConfig } from '../host/fixtures.js'
import { waitingDelegations } from '../host/subagent-control-fixture.js'
import { runnableWorkflowConfig } from '../workflow/host-fixture.js'

it('reads retained input facts after taking a member offline and executes them through a fresh generation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-consumer-offline-'))
  let host: AtomicHost | undefined
  try {
    const spec = resolveHostConfig(decodeHostConfig(hostConfig(directory), directory))
    await initializeHost(spec)
    host = await openHost(spec)
    const input = await host.submitTask('writer', 'Retain this task while offline')
    await host.setMailboxOnline('writer', false)
    const report = host.report()
    expect(report.members[0]).toMatchObject({ mailbox: 'known-offline', paused: true,
      agent: { counts: { pendingInputs: 1, queuedInputs: 1 } } })
    expect(host.read().status().report).toEqual(report)
    expect(host.read().input('writer', { inputEventId: input.eventId })).toMatchObject({ status: 'queued', rootId: null })
    await host.setMailboxOnline('writer', true)
    host.resume('writer')
    await host.run()
    expect(host.read().input('writer', { inputEventId: input.eventId })).toMatchObject({ status: 'handled', rootId: expect.any(String) })
    expect(host.report().members[0]!.agent.final?.text).toBe('fixed answer')
  } finally {
    await host?.shutdown()
    await rm(directory, { recursive: true, force: true })
  }
})

it('observes Workflow roots while their execution generation is released and protocol settlement continues', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-consumer-workflow-'))
  let host: AtomicHost | undefined
  let retiredGenerationObserved = false
  const read = HostObservations.prototype.read
  const observer = vi.spyOn(HostObservations.prototype, 'read').mockImplementation(function (this: HostObservations, ...args) {
    if (args[0].agent.status === 'disposed') retiredGenerationObserved = true
    return read.apply(this, args)
  })
  try {
    const config = runnableWorkflowConfig(directory)
    const spec = resolveHostConfig(decodeHostConfig({ ...config,
      scheduling: { ...config.scheduling, maxBatchesPerRun: 1 } }, directory))
    await initializeHost(spec)
    host = await openHost(spec)
    await host.workflow('research').resume({ requestKey: 'audit-start' })
    for (let i = 0; i < 200 && !host.workflow('research').report().closed; i++) await host.run()
    expect(host.workflow('research').report()).toMatchObject({ closed: true })
    expect(retiredGenerationObserved).toBe(true)
    expect(host.report().members.every(member => member.agent.roots.some(root => root.source.kind === 'workflow'))).toBe(true)
    expect(host.read().status().report.counts.blockedMembers).toBe(0)
    expect(host.read().workflow('research')).toMatchObject({ closed: true, recoveryRequired: false })
  } finally {
    try { await host?.shutdown() } finally {
      observer.mockRestore()
      await rm(directory, { recursive: true, force: true })
    }
  }
}, 20000)

it('cancels a Parent after its Child execution retires while retaining Child protocol facts', async () => {
  let retired: ChildInstance['slot']
  const release = ChildInstance.prototype.releaseExecution
  const observer = vi.spyOn(ChildInstance.prototype, 'releaseExecution').mockImplementation(async function (this: ChildInstance) {
    await release.call(this)
    retired = this.slot
  })
  let f: Awaited<ReturnType<typeof waitingDelegations>> | undefined
  try {
    f = await waitingDelegations({ count: 1, batches: 1, childResponse: 'Verified evidence' })
    for (let i = 0; i < 150 && retired === undefined; i++) await f.host.run()
    expect(retired).toBeDefined()
    expect(retired!.agent.status).toBe('disposed')
    expect(projectAgentSession(retired!.session.snapshot()).roots[0]!.outcome).toBe('completed')
    const receipt = f.receipts[0]!
    expect(f.parents[0]!.inspect(receipt.delegationId).closed).toBe(false)
    await f.host.cancel('writer', f.parents[0]!.inspect(receipt.delegationId).parentRoot)
    for (let i = 0; i < 150 && !f.parents[0]!.inspect(receipt.delegationId).closed; i++) await f.host.run()
    expect(f.parents[0]!.inspect(receipt.delegationId)).toMatchObject({ closed: true, executionReleased: true })
    expect(f.childCalls()).toBe(1)
    expect(projectAgentSession(retired!.session.snapshot()).roots[0]!.outcome).toBe('completed')
  } finally {
    try { await f?.close() } finally { observer.mockRestore() }
  }
}, 20000)
