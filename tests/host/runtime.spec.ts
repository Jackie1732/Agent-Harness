import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FileSessionBackend,
  SessionRepository,
  acquireHostStorageLock,
  adoptEmptyHostMember,
  decodeHostConfig,
  hostRuntimeEventCatalog,
  initializeHost,
  openHost,
  parseSessionId,
  resolveHostConfig,
} from '../../src/index.js'
import type { AtomicHost } from '../../src/index.js'
import { hostConfig, hostSessionId, twoMemberHostConfig } from './fixtures.js'

const hosts: AtomicHost[] = []
afterEach(async () => {
  const results = await Promise.allSettled(hosts.splice(0).map(host => host.shutdown()))
  const failed = results.find(result => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
})

describe('Atomic Host runtime', () => {
  it('initializes a saved slot, runs one task, and reopens without rewriting setup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-host-runtime-'))
    const spec = resolveHostConfig(decodeHostConfig(hostConfig(root), root))
    const initialized = await initializeHost(spec)
    expect(initialized).toMatchObject([{ agentKey: 'writer', mode: 'initialized' }])

    const host = await openHost(spec)
    hosts.push(host)
    const accepted = await host.submitTask('writer', 'test task')
    expect(accepted.eventId).toContain(':')
    const run = await host.run()
    expect(run).toMatchObject({ businessRuns: 1, stoppedBy: 'quiescent' })
    expect(run.members[0]?.agent.final).toMatchObject({ text: 'fixed answer' })
    await host.shutdown()
    hosts.splice(hosts.indexOf(host), 1)

    expect(await readFile(join(root, '.atomic-harness.lock'), 'utf8').catch(() => null)).toBeNull()
    const reopened = await openHost(spec)
    hosts.push(reopened)
    expect(reopened.report().members[0]?.agent.counts.roots).toBe(1)
  })

  it('requires explicit resume for a matching interrupted initialization prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-host-resume-'))
    const spec = resolveHostConfig(decodeHostConfig(hostConfig(root), root))
    await initializeHost(spec)
    await expect(initializeHost(spec)).resolves.toMatchObject([{ mode: 'existing' }])
  })

  it('routes peer work through durable Outbox and Inbox facts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-host-peers-'))
    const spec = resolveHostConfig(decodeHostConfig(twoMemberHostConfig(root), root))
    await initializeHost(spec)
    const host = await openHost(spec)
    hosts.push(host)
    await host.sendMessage('writer', { kind: 'send', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1,
      payloadJson: '{"text":"review this"}' })
    const report = await host.run()
    expect(report.deliveryAttempts).toBe(1)
    const writer = report.members.find(member => member.agentKey === 'writer')!
    const reviewer = report.members.find(member => member.agentKey === 'reviewer')!
    expect(writer.agent.counts.pendingOutbox).toBe(0)
    expect(reviewer.agent.counts.roots).toBe(1)
    expect(reviewer.agent.final?.text).toBe('reviewer answer')
  })

  it('keeps Header-only creation ambiguous until the exact Header is explicitly adopted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-host-empty-'))
    const spec = resolveHostConfig(decodeHostConfig(hostConfig(root), root))
    const lock = await acquireHostStorageLock(root, 'test-host')
    const repository = new SessionRepository({ backend: new FileSessionBackend({ root: lock.root,
      maxRecordBytes: spec.storage.maxRecordBytes }), catalog: hostRuntimeEventCatalog, maxLineageDepth: spec.storage.maxLineageDepth })
    const session = await repository.create({ sessionId: parseSessionId(hostSessionId) })
    const header = session.header
    await repository.dispose(); await lock.dispose()
    await expect(initializeHost(spec)).rejects.toMatchObject({ code: 'HOST_BOOTSTRAP_AMBIGUOUS' })
    await expect(adoptEmptyHostMember(spec, 'writer', { predecessorStopped: true, expectedHeader: header }))
      .resolves.toMatchObject({ mode: 'initialized' })
  })
})
