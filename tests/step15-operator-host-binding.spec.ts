import { writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as connections from '../src/operator/connection.js'
import { buildOperatorProfile } from '../src/operator/profile.js'
import { openOperatorSession } from '../src/operator/session.js'
import { decodeHostConfig, resolveHostConfig } from '../src/host/config.js'
import { initializeHost } from '../src/host/initialization.js'
import { decodeApiConfig, resolveApiConfig } from '../src/api/config.js'
import { openHarnessApiServer } from '../src/api/server.js'
import type { ControlMethod, Params, Result } from '../src/protocol/index.js'
import type { JsonObject } from '../src/foundation/json.js'
import type { OperatorSession } from '../src/operator/types.js'
import { hostConfig, twoMemberHostConfig } from './host/fixtures.js'
import { apiConfig, certificateDirectory, clientOptions } from './api/fixtures.js'
import { localFixture } from './step15-operator-fixture.js'

async function remoteFixture(configFactory = hostConfig) {
  const f = await localFixture(configFactory), config = await apiConfig()
  const replacement = configFactory(join(f.directory, 'replacement-store'))
  const replacementSpec = resolveHostConfig(decodeHostConfig({ ...replacement, hostKey: 'replacement-host',
    routes: (replacement.routes as readonly JsonObject[]).map(route => ({ ...route, ownerHost: 'replacement-host' })) }, f.directory))
  await initializeHost(replacementSpec)
  let service = await openHarnessApiServer({ host: f.spec, credentials: {},
    api: resolveApiConfig(decodeApiConfig(config), f.spec, f.directory) })
  try {
    const port = service.ready.listen.port, options = await clientOptions(port)
    const raw = buildOperatorProfile({ kind: 'remote', origin: options.origin, serverName: 'localhost',
      tlsFiles: { ca: `${certificateDirectory}ca.pem`, cert: `${certificateDirectory}client.pem`, key: `${certificateDirectory}client-key.pem` },
      limits: options.limits, targets: { agentKeys: ['writer'], workflowKeys: [] } })
    await writeFile(f.profilePath, JSON.stringify(raw))
    return { ...f, replacementSpec, service: () => service,
      async restart(replace: boolean) {
        await service.dispose()
        const spec = replace ? replacementSpec : f.spec
        service = await openHarnessApiServer({ host: spec, credentials: {},
          api: resolveApiConfig(decodeApiConfig({ ...config, listenPort: port }), spec, f.directory) })
      },
      async dispose() { await service.dispose(); await rm(f.directory, { recursive: true, force: true }) } }
  } catch (error) { await service.dispose(); await rm(f.directory, { recursive: true, force: true }); throw error }
}

it('rejects a new mutation before preparation when the attached origin now serves another Host', async () => {
  const f = await remoteFixture()
  let session: OperatorSession | undefined
  try {
    session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
    const first = await session.submit({ agentKey: 'writer', submissionKey: 'original-host', text: 'Original Host input' })
    expect(first.acceptance).toBe('accepted')
    const original = session.intents()[0]!
    await f.restart(true)
    const replacement = await session.submit({ agentKey: 'writer', submissionKey: 'replacement-host', text: 'Must remain unsubmitted' })
    expect(replacement).toMatchObject({ status: 'rejected', acceptance: 'not-accepted', operationId: null,
      error: { code: 'OPERATOR_BINDING_CHANGED' } })
    expect(session.intents()).toEqual([original])
    expect(await session.execute('host.status', {})).toMatchObject({ status: 'ok', result: { report: {
      hostKey: f.replacementSpec.hostKey, counts: { pendingInputs: 0 } } } })
    expect(await session.execute('input.get', { agentKey: 'writer', submissionKey: 'replacement-host' }))
      .toMatchObject({ acceptance: 'not-applicable', error: { code: 'API_TARGET_NOT_FOUND' } })
    expect(f.service().status).toBe('ready')
  } finally { try { await session?.close() } finally { await f.dispose() } }
})

it('accepts a new keyed input and reuses the original input after the same Host restarts', async () => {
  const f = await remoteFixture()
  let session: OperatorSession | undefined
  try {
    session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
    const first = await session.submit({ agentKey: 'writer', submissionKey: 'same-host-first', text: 'Original exact input' })
    expect(first.acceptance).toBe('accepted')
    const oldInstance = first.scope.instanceId
    await f.restart(false)
    const second = await session.submit({ agentKey: 'writer', submissionKey: 'same-host-second', text: 'New input after same Host restart' })
    expect(second).toMatchObject({ status: 'ok', acceptance: 'accepted', result: { reused: false, sessionId: f.spec.members[0]!.sessionId } })
    expect(second.scope.instanceId).not.toBe(oldInstance)
    expect(await session.resume(first.operationId!)).toMatchObject({ status: 'ok', acceptance: 'accepted',
      result: { reused: true, inputEventId: (first.result as Result<'input.submit'>).inputEventId } })
    expect(session.intents().map(intent => intent.method)).toEqual(['input.submit', 'input.submit', 'input.submit'])
    const status = (await session.execute('host.status', {})).result as Result<'host.status'>
    expect(status.report.counts.pendingInputs).toBe(2)
    expect(status.report.members[0]?.agent.counts).toMatchObject({ inputs: 2, roots: 0, modelUsage: 0 })
  } finally { try { await session?.close() } finally { await f.dispose() } }
})

it('preserves actual input acceptance but marks the prepared target unknown when a replacement Host reuses its Session UUID', async () => {
  const f = await remoteFixture(), original = connections.openOperatorConnection
  let replaced = false
  vi.spyOn(connections, 'openOperatorConnection').mockImplementation(async (...args) => {
    const connection = await original(...args)
    return { ...connection, request: async <M extends ControlMethod>(method: M, params: Params<M>, signal?: AbortSignal) => {
      const result = await connection.request(method, params, signal)
      if (method === 'agent.get' && !replaced) { replaced = true; await f.restart(true) }
      return result
    } }
  })
  let session: OperatorSession | undefined
  try {
    expect(f.replacementSpec.members[0]!.sessionId).toBe(f.spec.members[0]!.sessionId)
    session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
    const receipt = await session.submit({ agentKey: 'writer', submissionKey: 'reused-session-uuid', text: 'Actual replacement Host acceptance', drive: true })
    expect(replaced).toBe(true)
    expect(receipt).toMatchObject({ status: 'pending', acceptance: 'accepted', error: { code: 'OPERATOR_SCOPE_CHANGED' },
      result: { input: { acceptance: 'accepted', result: { sessionId: f.replacementSpec.members[0]!.sessionId, reused: false } }, run: null } })
    expect(session.intents()).toHaveLength(1)
    expect(session.intents()[0]).toMatchObject({ scope: { hostKey: f.spec.hostKey },
      outcome: { acceptance: 'unknown', errorCode: 'OPERATOR_SCOPE_CHANGED' } })
    expect(await session.execute('input.get', { agentKey: 'writer', submissionKey: 'reused-session-uuid' }))
      .toMatchObject({ status: 'ok', result: { status: 'queued', rootId: null } })
    expect(await session.submit({ agentKey: 'writer', submissionKey: 'after-host-change', text: 'Must remain unsubmitted' }))
      .toMatchObject({ acceptance: 'not-accepted', operationId: null })
    expect(session.intents()).toHaveLength(1)
    const status = (await session.execute('host.status', {})).result as Result<'host.status'>
    expect(status.report.hostKey).toBe(f.replacementSpec.hostKey)
    expect(status.report.members[0]?.agent.counts).toMatchObject({ inputs: 1, roots: 0, modelUsage: 0 })
    expect(f.service().status).toBe('ready')
  } finally { vi.restoreAllMocks(); try { await session?.close() } finally { await f.dispose() } }
})

it.each([true, false])('preserves Message acceptance but leaves its prepared scope unknown when the API restarts during preparation (replace Host: %s)', async replace => {
  const f = await remoteFixture(twoMemberHostConfig), original = connections.openOperatorConnection
  let restarted = false, session: OperatorSession | undefined
  vi.spyOn(connections, 'openOperatorConnection').mockImplementation(async (...args) => {
    const connection = await original(...args)
    return { ...connection, request: async <M extends ControlMethod>(method: M, params: Params<M>, signal?: AbortSignal) => {
      const result = await connection.request(method, params, signal)
      if (method === 'agent.get' && !restarted) { restarted = true; await f.restart(replace) }
      return result
    } }
  })
  try {
    expect(f.replacementSpec.members[0]!.sessionId).toBe(f.spec.members[0]!.sessionId)
    session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
    const params = { agentKey: 'writer', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1, payloadJson: '{"text":"Actual API Message acceptance"}' }
    const result = await session.execute('message.send', params)
    expect(restarted).toBe(true)
    expect(result).toMatchObject({ status: 'pending', acceptance: 'accepted', error: { code: 'OPERATOR_SCOPE_CHANGED' },
      result: { status: 'outbox-accepted', sessionId: f.spec.members[0]!.sessionId } })
    const prepared = session.intents()[0]!, receipt = result.result as Result<'message.send'>
    expect(receipt.instanceId).not.toBe(prepared.scope.instanceId)
    expect(prepared).toMatchObject({ method: 'message.send', params, scope: { hostKey: f.spec.hostKey },
      outcome: { acceptance: 'unknown', errorCode: 'OPERATOR_SCOPE_CHANGED', summary: { instanceId: receipt.instanceId } } })
    expect(await session.execute('message.get', { agentKey: 'writer', direction: 'outbox', messageId: receipt.messageId! }))
      .toMatchObject({ status: 'ok', result: { fact: { status: 'pending' } } })
    expect(await session.execute('message.send', params)).toMatchObject({ acceptance: 'not-accepted', operationId: null })
    expect(session.intents()).toHaveLength(1)
    const status = (await session.execute('host.status', {})).result as Result<'host.status'>
    expect(status.report.hostKey).toBe(replace ? f.replacementSpec.hostKey : f.spec.hostKey)
    expect(status.report.counts.pendingOutbox).toBe(1)
    expect(f.service().status).toBe('ready')
  } finally { vi.restoreAllMocks(); try { await session?.close() } finally { await f.dispose() } }
})

it('accepts a new Message with the refreshed instance after the same Host API restarts', async () => {
  const f = await remoteFixture(twoMemberHostConfig)
  let session: OperatorSession | undefined
  try {
    session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
    const params = { agentKey: 'writer', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1, payloadJson: '{"text":"Explicit Message before restart"}' }
    const first = await session.execute('message.send', params)
    expect(first).toMatchObject({ status: 'ok', acceptance: 'accepted', result: { status: 'outbox-accepted' } })
    await f.restart(false)
    const second = await session.execute('message.send', { ...params, payloadJson: '{"text":"New explicit Message after restart"}' })
    expect(second).toMatchObject({ status: 'ok', acceptance: 'accepted', result: { status: 'outbox-accepted' } })
    expect(second.scope.instanceId).not.toBe(first.scope.instanceId)
    expect(session.intents()).toHaveLength(2)
    expect(session.intents()[1]).toMatchObject({ scope: { instanceId: second.scope.instanceId }, outcome: { acceptance: 'accepted' } })
    expect((await session.execute('host.status', {})).result).toMatchObject({ report: { hostKey: f.spec.hostKey, counts: { pendingOutbox: 2 } } })
    expect(f.service().status).toBe('ready')
  } finally { try { await session?.close() } finally { await f.dispose() } }
})
