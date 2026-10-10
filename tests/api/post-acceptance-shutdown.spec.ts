import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as hostRuntime from '../../src/host/runtime.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import type { ResolvedHostSpec } from '../../src/host/config.js'
import { initializeHost } from '../../src/host/initialization.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { AgentJournal } from '../../src/agent/journal.js'
import { parseSessionId } from '../../src/session/ids.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import { decodeApiConfig, resolveApiConfig } from '../../src/api/config.js'
import { openHarnessApiServer } from '../../src/api/server.js'
import { createHarnessClient } from '../../src/client/client.js'
import { hostConfig } from '../host/fixtures.js'
import { runnableWorkflowConfig } from '../workflow/host-fixture.js'
import { apiConfig, clientOptions } from './fixtures.js'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(settle => { resolve = settle })
  return { promise, resolve }
}

async function pendingRoot(spec: ResolvedHostSpec) {
  const host = await hostRuntime.openHost(spec, { bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
    script: async function* () {
      yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'cancel-question' }
      yield { kind: 'block-start', index: 0, block: 'tool-call', name: 'agent_ask_user', callId: 'cancel-question' }
      yield { kind: 'arguments-delta', index: 0, text: '{"question":"Confirm?","timeoutMs":60000}' }
      yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
    } }) } })
  try {
    await host.submitTask('writer', 'A pending confirmation'); await host.run()
    return host.read().agent('writer').report.roots[0]!.id
  } finally { await host.shutdown({ mode: 'drain' }) }
}

for (const method of ['root.cancel', 'workflow.pause'] as const) it(`retains ${method} acceptance when shutdown prevents its post-operation read`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'api-accepted-shutdown-'))
  const raw = method === 'root.cancel' ? hostConfig(join(directory, 'store')) : runnableWorkflowConfig(join(directory, 'store'))
  if (method === 'root.cancel') {
    const member = (raw.members as Array<Record<string, unknown>>)[0]!
    member.spec = { ...(member.spec as object), nativeActions: ['agent_ask_user'] }
    const model = member.model as Record<string, unknown>
    model.runnerLimits = { ...(model.runnerLimits as object), maxToolCalls: 1 }
  }
  const spec = resolveHostConfig(decodeHostConfig(raw, directory)); await initializeHost(spec)
  const rootId = method === 'root.cancel' ? await pendingRoot(spec) : undefined
  const entered = gate(), release = gate(), closing = gate()
  const originalWriter = FileSessionBackend.prototype.openWriter, originalHost = hostRuntime.openHost
  const eventType = method === 'root.cancel' ? 'agent/control-requested' : 'workflow/control-requested'
  vi.spyOn(FileSessionBackend.prototype, 'openWriter').mockImplementation(async function (this: FileSessionBackend, id, validateCommitted) {
    const writer = await originalWriter.call(this, id, validateCommitted)
    return { ...writer, append: async (position, event) => {
      if (event.type === eventType) { entered.resolve(); await release.promise }
      return writer.append(position, event)
    } }
  })
  vi.spyOn(hostRuntime, 'openHost').mockImplementation(async (...args) => {
    const host = await originalHost(...args), originalShutdown = host.shutdown.bind(host)
    vi.spyOn(host, 'shutdown').mockImplementation(options => {
      const task = originalShutdown(options)
      if (host.shutdownState.status === 'stopping') closing.resolve()
      return task
    })
    return host
  })
  const rawApi = await apiConfig()
  const config = method === 'root.cancel' ? rawApi : { ...rawApi,
    principals: [{ ...rawApi.principals[0]!, agentKeys: ['writer', 'reviewer'], workflowKeys: ['research'] }] }
  const service = await openHarnessApiServer({ host: spec, api: resolveApiConfig(decodeApiConfig(config), spec, directory), credentials: {} })
  const client = createHarnessClient(await clientOptions(service.ready.listen.port)), manager = createHarnessClient(await clientOptions(service.ready.listen.port))
  const pending: Promise<unknown>[] = []
  try {
    await manager.request('host.status', {})
    const operation = method === 'root.cancel'
      ? client.request(method, { agentKey: 'writer', rootId: rootId!, reason: 'explicit-stop' })
      : client.request(method, { workflowKey: 'research', requestKey: 'explicit-pause', reason: 'operator-paused' })
    const settled = operation.then(result => ({ result }), error => ({ error }))
    pending.push(settled)
    await Promise.race([entered.promise, operation.then(() => { throw new Error('Domain append was not held') })])
    const shutdown = manager.request('host.shutdown', { expectedInstanceId: service.ready.instanceId, mode: 'drain' })
    pending.push(shutdown)
    await closing.promise; expect(service.status).toBe('closing')
    release.resolve()
    await Promise.allSettled([operation, shutdown]); await service.closed
    vi.restoreAllMocks()
    const reopened = await originalHost(spec)
    try {
      if (method === 'root.cancel') expect(reopened.read().root('writer', rootId!).stopControl).not.toBeNull()
      else expect((await reopened.read().events({ kind: 'workflow', workflowKey: 'research' }, { maxEvents: 100 })).events)
        .toContainEqual(expect.objectContaining({ type: 'workflow/control-requested', payload: expect.objectContaining({ requestKey: 'api:researcher:explicit-pause' }) }))
    } finally { await reopened.shutdown({ mode: 'drain' }) }
    expect(await settled).toMatchObject({ error: { code: 'API_INACTIVE', acceptance: 'unknown', domainCode: 'HOST_INACTIVE' } })
  } finally {
    release.resolve(); await Promise.allSettled(pending)
    await Promise.all([client.dispose(), manager.dispose()]); await service.dispose()
    vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true })
  }
}, 30000)

it('keeps cancellation acceptance unknown when a concurrent input faults its remaining journal work', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'api-cancel-input-fault-'))
  const raw = hostConfig(join(directory, 'store'))
  const member = (raw.members as Array<Record<string, unknown>>)[0]!
  member.spec = { ...(member.spec as object), nativeActions: ['agent_ask_user'] }
  const model = member.model as Record<string, unknown>
  model.runnerLimits = { ...(model.runnerLimits as object), maxToolCalls: 1 }
  const spec = resolveHostConfig(decodeHostConfig(raw, directory)); await initializeHost(spec)
  const rootId = await pendingRoot(spec), entered = gate(), release = gate()
  const originalWriter = FileSessionBackend.prototype.openWriter, originalAppend = AgentJournal.prototype.append
  let faultInput = false
  vi.spyOn(FileSessionBackend.prototype, 'openWriter').mockImplementation(async function (this: FileSessionBackend, id, validateCommitted) {
    const writer = await originalWriter.call(this, id, validateCommitted)
    return { ...writer, append: async (position, event) => {
      const result = await writer.append(position, event)
      if (faultInput && event.type === 'agent/input-accepted') throw new Error('Input acknowledgement lost')
      return result
    } }
  })
  vi.spyOn(AgentJournal.prototype, 'append').mockImplementation(async function (this: AgentJournal, definition, decide) {
    const event = await originalAppend.call(this, definition, decide)
    if (definition.type === 'agent/wait-settled') { entered.resolve(); await release.promise }
    return event
  })
  const service = await openHarnessApiServer({ host: spec,
    api: resolveApiConfig(decodeApiConfig(await apiConfig()), spec, directory), credentials: {} })
  const client = createHarnessClient(await clientOptions(service.ready.listen.port)), inputClient = createHarnessClient(await clientOptions(service.ready.listen.port))
  let pending: Promise<unknown> | undefined
  try {
    const operation = client.request('root.cancel', { agentKey: 'writer', rootId, reason: 'explicit-stop' })
    const settled = operation.then(result => ({ result }), error => ({ error }))
    pending = settled
    await Promise.race([entered.promise, operation.then(() => { throw new Error('Cancellation settlement was not held') })])
    const root = await inputClient.request('root.get', { agentKey: 'writer', rootId })
    expect(root.stopControl).not.toBeNull(); expect(root.outcome).toBeNull()
    faultInput = true
    await expect(inputClient.request('input.submit', { agentKey: 'writer', submissionKey: 'concurrent-input', text: 'Concurrent input' }))
      .rejects.toMatchObject({ code: 'API_RECOVERY_REQUIRED', acceptance: 'unknown', domainCode: 'AGENT_COMMIT_UNKNOWN' })
    release.resolve()
    const result = await settled
    await service.shutdown({ mode: 'drain' })
    vi.restoreAllMocks()
    const reopened = new FileSessionBackend({ root: spec.storage.root, maxRecordBytes: spec.storage.maxRecordBytes })
    try {
      const committed = await reopened.readPrefix(parseSessionId(spec.members[0]!.sessionId))
      expect(committed.events).toContainEqual(expect.objectContaining({ eventId: root.stopControl,
        type: 'agent/control-requested', payload: expect.objectContaining({ root: rootId, reason: 'explicit-stop' }) }))
      expect(committed.events).toContainEqual(expect.objectContaining({ type: 'agent/input-accepted', payloadVersion: 2,
        payload: expect.objectContaining({ input: expect.objectContaining({ kind: 'task', text: 'Concurrent input' }),
          submission: { namespace: 'api:researcher', key: 'concurrent-input' } }) }))
    } finally { await reopened.dispose() }
    expect(result).toMatchObject({ error: { code: 'API_INACTIVE', acceptance: 'unknown', domainCode: 'AGENT_INACTIVE' } })
  } finally {
    release.resolve(); await pending
    await Promise.all([client.dispose(), inputClient.dispose()]); await service.dispose()
    vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true })
  }
}, 30000)
