import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { decodeHostConfig, initializeHost, openHost, resolveHostConfig, ScriptedModelProvider } from '../../src/index.js'
import type { ModelProvider, ModelFrame } from '../../src/index.js'
import { twoMemberHostConfig } from './fixtures.js'
import { hostExitCode } from '../../src/host/cli-interactive.js'
import { createHostModelProvider } from '../../src/host/model-factory.js'

it('releases earlier slots when a later Provider fails to construct and permits a clean reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-rollback-'))
  const spec = resolveHostConfig(decodeHostConfig(twoMemberHostConfig(root), root))
  await initializeHost(spec)
  let released = 0
  await expect(openHost(spec, { bindings: { createModelProvider(member): ModelProvider {
    if (member.agentKey === 'reviewer') throw new Error('construction failure')
    const provider = new ScriptedModelProvider({ ...member.model, script: async function* (): AsyncGenerator<ModelFrame> {} })
    return { descriptor: provider.descriptor, prepare: request => provider.prepare(request), dispose: async () => { released++; await provider.dispose() } }
  } } })).rejects.toThrow()
  expect(released).toBe(1)
  expect(await readFile(join(root, '.atomic-harness.lock'), 'utf8').catch(() => null)).toBeNull()
  const reopened = await openHost(spec)
  await reopened.shutdown()
})

it('keeps known-offline mail pending and uses fresh resources on reattachment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-offline-'))
  const spec = resolveHostConfig(decodeHostConfig(twoMemberHostConfig(root), root))
  await initializeHost(spec)
  let failAttachment = false
  const host = await openHost(spec, { bindings: { createModelProvider: member => {
    if (member.agentKey === 'reviewer' && failAttachment) throw new Error('temporary binding failure')
    return createHostModelProvider(member.model, {})
  } } })
  try {
    await host.setMailboxOnline('reviewer', false)
    await host.sendMessage('writer', { kind: 'send', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1, payloadJson: '{"text":"queued"}' })
    expect(await host.run()).toMatchObject({ deliveryAttempts: 0, counts: { pendingOutbox: 1 } })
    failAttachment = true
    await expect(host.setMailboxOnline('reviewer', true)).rejects.toThrow()
    expect(host.report().counts.blockedMembers).toBe(1)
    failAttachment = false
    await host.setMailboxOnline('reviewer', true)
    expect(host.report().counts.blockedMembers).toBe(0)
    expect(await host.run()).toMatchObject({ deliveryAttempts: 1, businessRuns: 0 })
    host.resume('reviewer')
    expect((await host.run()).members[1]!.agent.final?.text).toBe('reviewer answer')
  } finally { await host.shutdown() }
})

it('routing pause leaves persisted emission untouched while independent business continues', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-route-pause-'))
  const spec = resolveHostConfig(decodeHostConfig(twoMemberHostConfig(root), root))
  await initializeHost(spec)
  const host = await openHost(spec)
  try {
    await host.sendMessage('writer', { kind: 'send', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1, payloadJson: '{"text":"pending"}' })
    host.pauseRouting('writer')
    await host.submitTask('reviewer', 'independent work')
    expect(await host.run()).toMatchObject({ deliveryAttempts: 0, businessRuns: 1 })
    host.resumeRouting('writer')
    expect((await host.run()).deliveryAttempts).toBe(1)
  } finally { await host.shutdown() }
})

it('reports disabled members and preserves their pending work until explicit fresh attachment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'host-disabled-'))
  const config = twoMemberHostConfig(root)
  const spec = resolveHostConfig(decodeHostConfig(config, root))
  await initializeHost(spec)
  const initial = await openHost(spec)
  await initial.submitTask('reviewer', 'deferred task')
  await initial.shutdown()
  const disabled = resolveHostConfig(decodeHostConfig({ ...config,
    members: (config.members as readonly Record<string, unknown>[]).map(member => ({ ...member, enabled: member.agentKey !== 'reviewer' })) }, root))
  const host = await openHost(disabled)
  try {
    const report = await host.run()
    expect(report).toMatchObject({ counts: { members: 2, pendingInputs: 1, runnableInputs: 0 } })
    expect(hostExitCode(report)).toBe(10)
    expect(report.members[1]).toMatchObject({ mailbox: 'known-offline', paused: true })
    await host.setMailboxOnline('reviewer', true)
    host.resume('reviewer')
    expect((await host.run()).members[1]!.agent.final?.text).toBe('reviewer answer')
  } finally { await host.shutdown() }
})
