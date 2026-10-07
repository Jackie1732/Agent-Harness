import { expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeHost } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { runnableWorkflowHost } from '../workflow/host-fixture.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import { nodeHostTimer } from '../../src/host/timer.js'
import { hostConfig } from './fixtures.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { formatSessionEventId, parseSessionId, sessionSequence } from '../../src/session/ids.js'
import { parseMessageId } from '../../src/communication/ids.js'

it('reports uncertified online absence after a real File append acknowledgement is lost and recovers the committed key on reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-lost-ack-'))
  const spec = resolveHostConfig(decodeHostConfig(hostConfig(directory), directory))
  await initializeHost(spec)
  const openWriter = FileSessionBackend.prototype.openWriter
  let lost = false
  const spy = vi.spyOn(FileSessionBackend.prototype, 'openWriter').mockImplementation(async function (this: FileSessionBackend, id) {
    const writer = await openWriter.call(this, id)
    return { ...writer, append: async (position, event) => {
      const committed = await writer.append(position, event)
      if (!lost && event.type === 'agent/input-accepted' && event.payloadVersion === 2) { lost = true; throw new Error('acknowledgement lost after commit') }
      return committed
    } }
  })
  try {
    const host = await openHost(spec)
    try {
      await expect(host.submitKeyedInput('writer', { kind: 'task', text: 'Durable task', originLabel: 'api:test' }, { namespace: 'api:test', key: 'durable' })).rejects.toMatchObject({ code: 'AGENT_COMMIT_UNKNOWN' })
      const read = host.read(), id = formatSessionEventId(parseSessionId(spec.members[0]!.sessionId), sessionSequence(999))
      expect(read.agent('writer')).toMatchObject({ faulted: true, recoveryRequired: true })
      const current = read.status().report
      expect(current.members[0]).toMatchObject({ faulted: true, readiness: { blockedBy: 'idle' } })
      expect(current.counts.blockedMembers).toBe(1)
      expect(() => read.input('writer', { namespace: 'api:test', key: 'durable' })).toThrowError(expect.objectContaining({ code: 'HOST_RECOVERY_REQUIRED' }))
      expect(() => read.input('writer', { inputEventId: id })).toThrowError(expect.objectContaining({ code: 'HOST_RECOVERY_REQUIRED' }))
      expect(() => read.root('writer', id)).toThrowError(expect.objectContaining({ code: 'HOST_RECOVERY_REQUIRED' }))
      expect(() => read.message('writer', parseMessageId('70000000-0000-4000-8000-000000000999'), 'outbox')).toThrowError(expect.objectContaining({ code: 'HOST_RECOVERY_REQUIRED' }))
    } finally { await host.shutdown({ mode: 'drain' }) }
    spy.mockRestore()
    const reopened = await openHost(spec)
    try {
      expect(reopened.read().input('writer', { namespace: 'api:test', key: 'durable' })).toMatchObject({ status: 'queued', recoveryRequired: false })
      expect(await reopened.submitKeyedInput('writer', { kind: 'task', text: 'Durable task', originLabel: 'api:test' }, { namespace: 'api:test', key: 'durable' })).toMatchObject({ reused: true })
    } finally { await reopened.shutdown() }
  } finally { spy.mockRestore(); await rm(directory, { recursive: true, force: true }) }
})

it('blocks finite Workflow observation after actual owner cleanup failure and retains health after disabling the member', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-recovery-'))
  try {
    const spec = runnableWorkflowHost(directory)
    await initializeHost(spec)
    const timer = { ...nodeHostTimer, wait: vi.fn(nodeHostTimer.wait) }
    const host = await openHost(spec, { timer, bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      onClose: () => { throw new Error('model release failed') },
      script: async function* () {
        yield { kind: 'message-start', responseId: 'cleanup-fault', reportedModel: member.spec.target.model }
        yield { kind: 'block-start', index: 0, block: 'text' }
        yield { kind: 'text-delta', index: 0, text: '{"text":"candidate"}' }
        yield { kind: 'block-end', index: 0 }
        yield { kind: 'complete', stopReason: 'stop' }
      } }) } })
    try {
      await host.workflow('research').resume({ requestKey: 'begin' })
      await expect(host.run()).rejects.toMatchObject({ code: 'EFFECT_DISPOSAL_FAILED' })
      expect(host.read().workflow('research')).toMatchObject({ recoveryRequired: true, closed: false })
      const member = host.read().agent('writer')
      expect(member).toMatchObject({ faulted: true, recoveryRequired: true })
      expect(host.read().root('writer', member.report.roots[0]!.id)).toMatchObject({ executionPending: true, final: null })
      timer.wait.mockClear()
      await expect(host.workflow('research').wait({ until: 'closed', timeoutMs: 1000 })).rejects.toMatchObject({ code: 'HOST_RECOVERY_REQUIRED' })
      expect(timer.wait).not.toHaveBeenCalled()
      await expect(host.setMailboxOnline('writer', false)).rejects.toMatchObject({ code: 'EFFECT_DISPOSAL_FAILED' })
      expect(host.read().agent('writer')).toMatchObject({ recoveryRequired: true, mailbox: 'known-offline' })
      expect(() => host.resume('writer')).not.toThrow()
      expect(host.report().counts.blockedMembers).toBe(1)
      expect(() => host.read().input('writer', { namespace: 'api:absent', key: 'unknown' })).toThrowError(expect.objectContaining({ code: 'HOST_RECOVERY_REQUIRED' }))
      expect(host.read().workflow('research').recoveryRequired).toBe(true)
    } finally { await host.shutdown({ mode: 'drain' }).catch(cause => { expect(cause).toMatchObject({ code: 'HOST_CLEANUP_FAILED' }) }) }
  } finally { await rm(directory, { recursive: true, force: true }) }
})
