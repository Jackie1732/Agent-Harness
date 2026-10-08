import { readFile, writeFile, rm } from 'node:fs/promises'
import { X509Certificate } from 'node:crypto'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as connections from '../src/operator/connection.js'
import { buildOperatorProfile, decodeOperatorProfile, resolveOperatorProfile } from '../src/operator/profile.js'
import type { OperatorProfile } from '../src/operator/profile.js'
import { openOperatorSession } from '../src/operator/session.js'
import { inspectOperatorJournal, openOperatorJournal, OperatorJournal } from '../src/operator/intents.js'
import { operatorOutcome } from '../src/operator/receipts.js'
import { acquireHostStorageLock } from '../src/host/storage-lock.js'
import { decodeHostConfig, resolveHostConfig } from '../src/host/config.js'
import { initializeHost } from '../src/host/initialization.js'
import { parseSessionId } from '../src/session/ids.js'
import type { OperatorScope } from '../src/operator/types.js'
import type { ControlMethod, Params, Result } from '../src/protocol/index.js'
import { FileSessionBackend } from '../src/session/file-backend.js'
import type { ApplicationResult } from '../src/control/types.js'
import { ClientTransportError } from '../src/client/errors.js'
import { openHarnessApiServer } from '../src/api/server.js'
import { decodeApiConfig, resolveApiConfig } from '../src/api/config.js'
import { hostConfig, twoMemberHostConfig } from './host/fixtures.js'
import { apiConfig, certificateDirectory, clientOptions } from './api/fixtures.js'
import { followOperatorEvents } from '../src/operator/observations.js'
import { localFixture } from './step15-operator-fixture.js'

it('reserves concurrent outcomes through optional checkpoint saturation and journal reopen', async () => {
  const f = await localFixture()
  const raw = decodeOperatorProfile({ ...f.raw, journal: { ...f.raw.journal, maxIntents: 2, maxEvents: 5, maxRecordBytes: 32768 } })
  const profile = resolveOperatorProfile(raw, f.profilePath)
  let owned = await openOperatorJournal(profile, 'a'.repeat(64))
  const scope: OperatorScope = { connection: 'local', connectionLifetime: 'session', hostKey: f.spec.hostKey,
    instanceId: '15000000-0000-4000-8000-000000000001', sessionId: f.spec.members[0]!.sessionId }
  const prepare = (key: string) => owned.journal.prepare({ method: 'input.submit', params: { agentKey: 'writer', submissionKey: key, text: key },
    scope, parentIntent: null, callerNamespace: profile.callerNamespace, certificateFingerprint: null,
    configDigest: 'b'.repeat(64), acknowledgedIntent: null })
  try {
    const [first, second] = await Promise.all([prepare('one'), prepare('two')])
    await expect(owned.journal.checkpoint(f.spec.members[0]!.sessionId, 1)).rejects.toMatchObject({ code: 'OPERATOR_JOURNAL_FULL' })
    await owned.dispose()
    owned = await openOperatorJournal(profile, 'a'.repeat(64))
    await expect(owned.journal.checkpoint(f.spec.members[0]!.sessionId, 1)).rejects.toMatchObject({ code: 'OPERATOR_JOURNAL_FULL' })
    await Promise.all([owned.journal.complete(first.id, operatorOutcome('unknown', null, 'OPERATOR_CONNECTION_FAILED', 'input.submit')),
      owned.journal.complete(second.id, operatorOutcome('not-accepted', null, 'API_FORBIDDEN', 'input.submit'))])
    expect(owned.journal.intents.map(intent => intent.outcome?.acceptance)).toEqual(['unknown', 'not-accepted'])
    await expect(prepare('three')).rejects.toMatchObject({ code: 'OPERATOR_JOURNAL_FULL' })
  } finally { await owned.dispose(); await rm(f.directory, { recursive: true, force: true }) }
})

it('rejects an oversized prepared event before dispatch and preserves the following reservation', async () => {
  const f = await localFixture()
  const profile = resolveOperatorProfile(decodeOperatorProfile({ ...f.raw, journal: { ...f.raw.journal, maxRecordBytes: 32768 } }), f.profilePath)
  const owned = await openOperatorJournal(profile, 'a'.repeat(64))
  const fields = { method: 'input.submit' as const, scope: { connection: 'local' as const, connectionLifetime: 'session' as const,
    hostKey: f.spec.hostKey, instanceId: '15000000-0000-4000-8000-000000000001', sessionId: f.spec.members[0]!.sessionId },
    parentIntent: null, callerNamespace: profile.callerNamespace, certificateFingerprint: null, configDigest: 'b'.repeat(64), acknowledgedIntent: null }
  try {
    await expect(owned.journal.prepare({ ...fields, params: { agentKey: 'writer', submissionKey: 'large', text: '中'.repeat(20000) } })).rejects.toBeDefined()
    expect(owned.journal.intents).toHaveLength(0)
    const next = await owned.journal.prepare({ ...fields, params: { agentKey: 'writer', submissionKey: 'small', text: 'Small' } })
    await owned.journal.complete(next.id, operatorOutcome('not-accepted', null, 'API_FORBIDDEN', 'input.submit'))
    expect(owned.journal.intents[0]?.outcome?.acceptance).toBe('not-accepted')
  } finally { await owned.dispose(); await rm(f.directory, { recursive: true, force: true }) }
})

it('releases the independent journal after connection cleanup fails', async () => {
  const f = await localFixture(), original = connections.openOperatorConnection
  vi.spyOn(connections, 'openOperatorConnection').mockImplementation(async (...args) => {
    const connection = await original(...args)
    let failed = false
    return { ...connection, close: async mode => {
      await connection.close(mode)
      if (!failed) { failed = true; throw new Error('Injected connection cleanup failure') }
    } }
  })
  const session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  try {
    await expect(session.close('drain')).rejects.toBeDefined()
    const probe = await acquireHostStorageLock(f.profile.journal.root, 'operator-review-probe')
    await probe.dispose()
  } finally {
    vi.restoreAllMocks(); await session.close('cancel').catch(() => undefined)
    await rm(f.directory, { recursive: true, force: true })
  }
})

it('preserves a typed Message rejection instead of recording outbox acceptance', async () => {
  const f = await localFixture()
  const session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  try {
    const result = await session.execute('message.send', { agentKey: 'writer', peerKey: 'missing-peer', type: 'test/note', payloadVersion: 1, payloadJson: '{}' })
    expect(result.result).toMatchObject({ status: 'not-accepted', outboxAcceptedEventId: null, messageId: null })
    expect(result).toMatchObject({ status: 'rejected', acceptance: 'not-accepted' })
    expect(session.intents()[0]?.outcome?.acceptance).toBe('not-accepted')
  } finally { await session.close('drain'); await rm(f.directory, { recursive: true, force: true }) }
})

it('keeps the accepted changed target visible and blocks a following run', async () => {
  const f = await localFixture(), original = connections.openOperatorConnection
  vi.spyOn(connections, 'openOperatorConnection').mockImplementation(async (...args) => {
    const connection = await original(...args)
    let reads = 0
    return { ...connection, request: async <M extends ControlMethod>(method: M, params: Params<M>, signal?: AbortSignal) => {
      const result = await connection.request(method, params, signal)
      if (method === 'agent.get' && reads++ === 0) return { ...result, sessionId: parseSessionId('15000000-0000-4000-8000-000000000099') } as ApplicationResult<M>
      return result
    } }
  })
  const session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  try {
    const result = await session.submit({ agentKey: 'writer', submissionKey: 'changed-target', text: 'Accepted on actual target' })
    expect(result).toMatchObject({ status: 'pending', acceptance: 'accepted', error: { code: 'OPERATOR_SCOPE_CHANGED' } })
    expect(result.scope.sessionId).toBe(f.spec.members[0]!.sessionId)
    expect(session.intents()[0]?.outcome).toMatchObject({ acceptance: 'unknown', errorCode: 'OPERATOR_SCOPE_CHANGED' })
    const run = await session.execute('host.run', { expectedInstanceId: result.scope.instanceId! })
    expect(run.acceptance).toBe('not-accepted')
    expect(session.intents()).toHaveLength(1)
  } finally {
    vi.restoreAllMocks(); await session.close('drain'); await rm(f.directory, { recursive: true, force: true })
  }
})

it('requires a previously verified caller before restoring an unknown remote input in the same instance', async () => {
  const f = await localFixture()
  const service = await openHarnessApiServer({ host: f.spec, api: resolveApiConfig(decodeApiConfig(await apiConfig()), f.spec, f.directory), credentials: {} })
  const options = await clientOptions(service.ready.listen.port)
  const raw: OperatorProfile = buildOperatorProfile({ kind: 'remote', origin: options.origin, serverName: 'localhost',
    tlsFiles: { ca: `${certificateDirectory}ca.pem`, cert: `${certificateDirectory}client.pem`, key: `${certificateDirectory}client-key.pem` },
    limits: options.limits, targets: { agentKeys: ['writer'], workflowKeys: [] } })
  await writeFile(f.profilePath, JSON.stringify(raw))
  const original = connections.openOperatorConnection
  let submissions = 0
  vi.spyOn(connections, 'openOperatorConnection').mockImplementation(async (...args) => {
    const connection = await original(...args)
    return { ...connection, request: async <M extends ControlMethod>(method: M, params: Params<M>, signal?: AbortSignal) => {
      if (method === 'input.submit' && submissions++ === 0) throw new ClientTransportError('unknown')
      return connection.request(method, params, signal)
    } }
  })
  const session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  try {
    const lost = await session.submit({ agentKey: 'writer', submissionKey: 'no-caller-witness', text: 'Original unknown input' })
    expect(lost.acceptance).toBe('unknown')
    const restored = await session.resume(lost.operationId!).catch(error => ({ error }))
    expect(restored.error).toMatchObject({ code: 'OPERATOR_CALLER_UNCONFIRMED' })
    expect(submissions).toBe(1)
  } finally {
    vi.restoreAllMocks(); await session.close(); await service.dispose()
    await rm(f.directory, { recursive: true, force: true })
  }
})

it('dispatches the parameters captured before preparation when the caller changes its object', async () => {
  const f = await localFixture(), original = OperatorJournal.prototype.prepare
  let release!: () => void, prepared!: () => void
  const released = new Promise<void>(resolve => { release = resolve })
  const reached = new Promise<void>(resolve => { prepared = resolve })
  vi.spyOn(OperatorJournal.prototype, 'prepare').mockImplementation(async function (this: OperatorJournal, input) {
    const intent = await original.call(this, input)
    prepared(); await released
    return intent
  })
  const session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  try {
    const params = { agentKey: 'writer', submissionKey: 'snapshot', text: 'Original text' }
    const pending = session.execute('input.submit', params)
    await reached
    params.text = 'Changed after durable preparation'
    release()
    expect(await pending).toMatchObject({ status: 'ok', acceptance: 'accepted' })
    expect(session.intents()[0]?.params.text).toBe('Original text')
    const facts = await inspectOperatorJournal(f.profile)
    expect(facts.find(fact => fact.kind === 'prepared')).toMatchObject({ intent: { params: { text: 'Original text' } } })
    const page = (await session.execute('session.events', { target: { kind: 'member', agentKey: 'writer' }, maxEvents: 64 })).result as Result<'session.events'>
    expect(page.events.find(event => event.type === 'agent/input-accepted')?.payload).toMatchObject({ input: { text: 'Original text' } })
  } finally {
    release(); vi.restoreAllMocks(); await session.close('drain')
    await rm(f.directory, { recursive: true, force: true })
  }
})

it('captures direct journal preparation before its caller changes nested parameters', async () => {
  const f = await localFixture(), owned = await openOperatorJournal(f.profile, 'a'.repeat(64))
  const params = { agentKey: 'writer', submissionKey: 'journal-snapshot', text: 'Original durable text' }
  try {
    const pending = owned.journal.prepare({ method: 'input.submit', params,
      scope: { connection: 'local', connectionLifetime: 'session', hostKey: f.spec.hostKey,
        instanceId: '15000000-0000-4000-8000-000000000001', sessionId: f.spec.members[0]!.sessionId },
      parentIntent: null, callerNamespace: f.profile.callerNamespace, certificateFingerprint: null,
      configDigest: 'b'.repeat(64), acknowledgedIntent: null })
    params.text = 'Changed immediately after call'
    const intent = await pending
    expect(intent.params.text).toBe('Original durable text')
    expect(Object.isFrozen(intent.params)).toBe(true)
    await owned.journal.complete(intent.id, operatorOutcome('not-accepted', null, 'API_FORBIDDEN', 'input.submit'))
    expect((await inspectOperatorJournal(f.profile)).find(fact => fact.kind === 'prepared'))
      .toMatchObject({ intent: { params: { text: 'Original durable text' } } })
  } finally { await owned.dispose(); await rm(f.directory, { recursive: true, force: true }) }
})

it.each(['input.submit', 'message.send'] as const)('rejects new %s before preparation without its observation grant', async method => {
  const f = await localFixture(), config = await apiConfig()
  const restricted = { ...config, principals: config.principals.map(principal => ({ ...principal,
    methods: ['host.status', 'agent.get', method] })) }
  const service = await openHarnessApiServer({ host: f.spec,
    api: resolveApiConfig(decodeApiConfig(restricted), f.spec, f.directory), credentials: {} })
  const options = await clientOptions(service.ready.listen.port)
  const raw = buildOperatorProfile({ kind: 'remote', origin: options.origin, serverName: 'localhost',
    tlsFiles: { ca: `${certificateDirectory}ca.pem`, cert: `${certificateDirectory}client.pem`, key: `${certificateDirectory}client-key.pem` },
    limits: options.limits, targets: { agentKeys: ['writer'], workflowKeys: [] } })
  await writeFile(f.profilePath, JSON.stringify(raw))
  const original = connections.openOperatorConnection
  let dispatched = 0
  vi.spyOn(connections, 'openOperatorConnection').mockImplementation(async (...args) => {
    const connection = await original(...args)
    return { ...connection, request: async <M extends ControlMethod>(candidate: M, params: Params<M>, signal?: AbortSignal) => {
      if (candidate === method) dispatched++
      return connection.request(candidate, params, signal)
    } }
  })
  const session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  const backend = new FileSessionBackend(f.spec.storage)
  try {
    const result = method === 'input.submit'
      ? await session.submit({ agentKey: 'writer', submissionKey: 'write-only', text: 'Must remain unsubmitted' })
      : await session.execute('message.send', { agentKey: 'writer', peerKey: 'missing-peer', type: 'test/note', payloadVersion: 1, payloadJson: '{}' })
    expect(result).toMatchObject({ acceptance: 'not-accepted', operationId: null, error: { code: 'API_FORBIDDEN' } })
    expect(dispatched).toBe(0)
    expect(session.intents()).toHaveLength(0)
    const stored = await backend.readPrefix(parseSessionId(f.spec.members[0]!.sessionId))
    expect(stored.events.filter(event => event.type === 'agent/input-accepted')).toHaveLength(0)
  } finally {
    vi.restoreAllMocks(); await backend.dispose(); await session.close(); await service.dispose()
    await rm(f.directory, { recursive: true, force: true })
  }
})

it('preserves the actual Root wait observation scope and cuts in the operator envelope', async () => {
  const f = await localFixture(), session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  try {
    expect(await session.submit({ agentKey: 'writer', submissionKey: 'wait-envelope', text: 'Execute before waiting', drive: true }))
      .toMatchObject({ acceptance: 'accepted', status: 'ok' })
    const input = (await session.execute('input.get', { agentKey: 'writer', submissionKey: 'wait-envelope' })).result as Result<'input.get'>
    const result = await session.execute('root.wait', { agentKey: 'writer', rootId: input.rootId!, timeoutMs: 500 })
    const waited = result.result as Result<'root.wait'>
    expect(waited.status).toBe('condition-met')
    expect(result.scope).toMatchObject({ instanceId: waited.observation.instanceId, sessionId: waited.observation.sessionId })
    expect(result.cuts).toEqual(waited.observation.cuts)
  } finally { await session.close('drain'); await rm(f.directory, { recursive: true, force: true }) }
})

it('keeps a drained event page in the final follow summary when its checkpoint cannot be appended', async () => {
  const f = await localFixture()
  await writeFile(f.profilePath, JSON.stringify({ ...f.raw, journal: { ...f.raw.journal, maxIntents: 1, maxEvents: 3 } }))
  const session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  let displayed = 0
  try {
    expect(await session.submit({ agentKey: 'writer', submissionKey: 'fills-journal', text: 'Retain a readable Host event' }))
      .toMatchObject({ acceptance: 'accepted' })
    const summary = await followOperatorEvents(session, { target: { kind: 'member', agentKey: 'writer' }, maxEvents: 64 }, result => {
      expect(result.status).toBe('ok'); displayed++
    }).catch(error => ({ error }))
    expect(displayed).toBe(1)
    expect(summary).toMatchObject({ type: 'follow-summary', pages: 1, lastSessionId: f.spec.members[0]!.sessionId })
    expect(session.eventCheckpoint(f.spec.members[0]!.sessionId)).toBeUndefined()
  } finally { await session.close('drain'); await rm(f.directory, { recursive: true, force: true }) }
})

it('keeps a rotated certificate journal readable while denying its original mutation authority', async () => {
  const f = await localFixture(), config = await apiConfig()
  const certA = await readFile(`${certificateDirectory}client.pem`), certB = await readFile(`${certificateDirectory}client-b.pem`)
  const fingerprints = [certA, certB].map(cert => new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase())
  const service = await openHarnessApiServer({ host: f.spec, credentials: {}, api: resolveApiConfig(decodeApiConfig({ ...config,
    principals: config.principals.map(principal => ({ ...principal, certificateFingerprints: fingerprints })) }), f.spec, f.directory) })
  const certPath = join(f.directory, 'client.pem'), keyPath = join(f.directory, 'client-key.pem')
  await writeFile(certPath, certA); await writeFile(keyPath, await readFile(`${certificateDirectory}client-key.pem`))
  const options = await clientOptions(service.ready.listen.port)
  const raw = buildOperatorProfile({ kind: 'remote', origin: options.origin, serverName: 'localhost',
    tlsFiles: { ca: `${certificateDirectory}ca.pem`, cert: certPath, key: keyPath }, limits: options.limits,
    targets: { agentKeys: ['writer'], workflowKeys: [] } })
  await writeFile(f.profilePath, JSON.stringify(raw))
  let session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  try {
    const original = await session.submit({ agentKey: 'writer', submissionKey: 'certificate-original', text: 'Original certificate input' })
    expect(original.acceptance).toBe('accepted')
    await session.close()
    await writeFile(certPath, certA.toString().replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'))
    session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
    expect(await session.submit({ agentKey: 'writer', submissionKey: 'same-der', text: 'Same DER with changed PEM formatting' }))
      .toMatchObject({ acceptance: 'accepted' })
    await session.close()
    await writeFile(certPath, certB); await writeFile(keyPath, await readFile(`${certificateDirectory}client-b-key.pem`))
    session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
    expect(session.intents()).toHaveLength(2)
    expect(await session.execute('host.status', {})).toMatchObject({ status: 'ok', acceptance: 'not-applicable' })
    expect(await session.submit({ agentKey: 'writer', submissionKey: 'rotated', text: 'Must remain unsubmitted' }))
      .toMatchObject({ acceptance: 'not-accepted', operationId: null })
    await expect(session.resume(original.operationId!)).rejects.toMatchObject({ code: 'OPERATOR_BINDING_CHANGED' })
    expect(session.intents()).toHaveLength(2)
  } finally { await session.close(); await service.dispose(); await rm(f.directory, { recursive: true, force: true }) }
})

it.each(['same', 'changed'] as const)('checks the %s remote caller namespace across API instance restart before keyed input restore', async caller => {
  const f = await localFixture(), config = await apiConfig()
  let service = await openHarnessApiServer({ host: f.spec, api: resolveApiConfig(decodeApiConfig(config), f.spec, f.directory), credentials: {} })
  const port = service.ready.listen.port, options = await clientOptions(port)
  const raw = buildOperatorProfile({ kind: 'remote', origin: options.origin, serverName: 'localhost',
    tlsFiles: { ca: `${certificateDirectory}ca.pem`, cert: `${certificateDirectory}client.pem`, key: `${certificateDirectory}client-key.pem` },
    limits: options.limits, targets: { agentKeys: ['writer'], workflowKeys: [] } })
  await writeFile(f.profilePath, JSON.stringify(raw))
  let session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  try {
    const accepted = await session.submit({ agentKey: 'writer', submissionKey: 'restart-key', text: 'Original exact input' })
    expect(accepted.acceptance).toBe('accepted')
    const prior = session.intents()[0]!
    expect(prior.outcome?.summary.namespace).toBe('api:researcher')
    await session.close(); await service.dispose()
    const restarted = { ...config, listenPort: port, principals: config.principals.map(principal => ({ ...principal,
      principalKey: caller === 'same' ? principal.principalKey : 'changed-principal' })) }
    service = await openHarnessApiServer({ host: f.spec, api: resolveApiConfig(decodeApiConfig(restarted), f.spec, f.directory), credentials: {} })
    session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
    const restored = await session.resume(accepted.operationId!).catch(error => ({ error }))
    if (caller === 'same') {
      expect(restored).toMatchObject({ status: 'ok', acceptance: 'accepted', result: { reused: true, inputEventId: prior.outcome?.summary.inputEventId } })
      expect(session.intents()).toHaveLength(2)
      expect(session.intents()[1]?.parentIntent).toBe(prior.id)
    } else {
      expect(restored.error).toMatchObject({ code: 'OPERATOR_CALLER_UNCONFIRMED' })
      expect(session.intents()).toHaveLength(1)
    }
    expect(session.intents()[0]).toEqual(prior)
  } finally { await session.close(); await service.dispose(); await rm(f.directory, { recursive: true, force: true }) }
})

it.each(['rejected', 'unknown'] as const)('preserves the fixed composite structure when input is %s before drive', async state => {
  const f = await localFixture(), original = connections.openOperatorConnection
  if (state === 'unknown') vi.spyOn(connections, 'openOperatorConnection').mockImplementation(async (...args) => {
    const connection = await original(...args)
    return { ...connection, request: async <M extends ControlMethod>(method: M, params: Params<M>, signal?: AbortSignal) => {
      const result = await connection.request(method, params, signal)
      if (method === 'input.submit') throw new ClientTransportError('unknown')
      return result
    } }
  })
  const session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  try {
    const result = await session.submit({ agentKey: 'writer', submissionKey: `phase-${state}`,
      text: state === 'rejected' ? 'a'.repeat(4097) : 'Actually accepted before losing its receipt', drive: true })
    expect(result.acceptance).toBe(state === 'rejected' ? 'not-accepted' : 'unknown')
    expect(result.result).toMatchObject({ input: { intentId: result.operationId, acceptance: result.acceptance, result: null }, run: null })
    expect(session.intents()).toHaveLength(1)
    expect(session.intents()[0]?.method).toBe('input.submit')
  } finally { vi.restoreAllMocks(); await session.close('drain'); await rm(f.directory, { recursive: true, force: true }) }
})

it('settles SIGINT while waiting for task stdin without requiring EOF or creating an intent', async () => {
  const f = await localFixture(), moduleUrl = new URL('../src/operator/cli.ts', import.meta.url).href
  const code = `import { Readable, Writable } from 'node:stream';
    import { runOperatorCli } from ${JSON.stringify(moduleUrl)};
    let reported = false, output = '';
    const stdin = new Readable({ read() { if (!reported) { reported = true; process.send('reading'); } } });
    const stdout = new Writable({ write(bytes, _encoding, done) { output += bytes.toString(); done(); } });
    const stderr = new Writable({ write(_bytes, _encoding, done) { done(); } });
    process.on('message', value => { if (value === 'interrupt') process.emit('SIGINT'); });
    const result = await runOperatorCli(['task', 'submit', '--agent', 'writer', '--text-stdin', '--key', 'interrupted-stdin', '--profile', process.env.REVIEW_PROFILE, '--json'], { stdin, stdout, stderr }, {});
    process.send({ code: result, output }); process.disconnect();`
  const child = spawn(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '--eval', code], {
    cwd: new URL('../', import.meta.url), env: { ...process.env, REVIEW_PROFILE: f.profilePath }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let stderr = ''
  child.stderr!.on('data', bytes => { stderr += bytes.toString() })
  const queued: unknown[] = [], readers: ((message: unknown) => void)[] = []
  child.on('message', message => { const reader = readers.shift(); if (reader === undefined) queued.push(message); else reader(message) })
  const next = () => queued.length ? Promise.resolve(queued.shift()) : new Promise<unknown>(resolve => readers.push(resolve))
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  try {
    expect(await next()).toBe('reading')
    child.send('interrupt')
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = await Promise.race([next(), new Promise(resolve => { timer = setTimeout(() => resolve('did-not-settle-without-eof'), 2000) })])
    clearTimeout(timer)
    expect(result, stderr).toMatchObject({ code: 130 })
    expect(JSON.parse((result as { output: string }).output)).toMatchObject({ operationId: null, acceptance: 'not-accepted' })
    await exited
    const backend = new FileSessionBackend(f.spec.storage)
    try {
      expect((await backend.readPrefix(parseSessionId(f.spec.members[0]!.sessionId))).events.filter(event => event.type === 'agent/input-accepted'))
        .toHaveLength(0)
    } finally { await backend.dispose() }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await exited; await rm(f.directory, { recursive: true, force: true })
  }
}, 10000)

it('keeps submit-only intent when its caller changes drive while preparation is pending', async () => {
  const f = await localFixture(), original = OperatorJournal.prototype.prepare
  let release!: () => void, prepared!: () => void
  const released = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { prepared = resolve })
  vi.spyOn(OperatorJournal.prototype, 'prepare').mockImplementation(async function (this: OperatorJournal, input) {
    const intent = await original.call(this, input)
    if (input.method === 'input.submit') { prepared(); await released }
    return intent
  })
  const session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  try {
    const input = { agentKey: 'writer', submissionKey: 'submit-only', text: 'Capture this action', drive: false }
    const pending = session.submit(input)
    await reached; input.drive = true; release()
    expect(await pending).toMatchObject({ acceptance: 'accepted', result: { reused: false } })
    expect(session.intents().map(intent => intent.method)).toEqual(['input.submit'])
    expect(await session.execute('input.get', { agentKey: 'writer', submissionKey: input.submissionKey }))
      .toMatchObject({ result: { status: 'queued', rootId: null } })
  } finally { release(); vi.restoreAllMocks(); await session.close('drain'); await rm(f.directory, { recursive: true, force: true }) }
})

it('keeps a published Message visible and stops further modifications when its receipt target differs from preparation', async () => {
  const f = await localFixture(twoMemberHostConfig), original = connections.openOperatorConnection
  vi.spyOn(connections, 'openOperatorConnection').mockImplementation(async (...args) => {
    const connection = await original(...args)
    let first = true
    return { ...connection, request: async <M extends ControlMethod>(method: M, params: Params<M>, signal?: AbortSignal) => {
      const actual = await connection.request(method, params, signal)
      if (method === 'agent.get' && first) {
        first = false
        return { ...actual, sessionId: parseSessionId('15000000-0000-4000-8000-000000000099') } as ApplicationResult<M>
      }
      return actual
    } }
  })
  const session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  try {
    const result = await session.execute('message.send', { agentKey: 'writer', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1,
      payloadJson: JSON.stringify({ text: 'Actually published Message' }) })
    expect(result).toMatchObject({ acceptance: 'accepted', status: 'pending', scope: { sessionId: f.spec.members[0]!.sessionId },
      error: { code: 'OPERATOR_SCOPE_CHANGED' }, result: { status: 'outbox-accepted', messageId: expect.any(String) } })
    expect(session.intents()[0]?.outcome).toMatchObject({ acceptance: 'unknown', errorCode: 'OPERATOR_SCOPE_CHANGED' })
    expect(await session.execute('host.run', { expectedInstanceId: result.scope.instanceId! })).toMatchObject({ acceptance: 'not-accepted' })
    expect(session.intents()).toHaveLength(1)
  } finally { vi.restoreAllMocks(); await session.close('drain'); await rm(f.directory, { recursive: true, force: true }) }
})

it('rejects keyed input restore when a real API replacement changes the target after its initial identity read', async () => {
  const f = await localFixture(), config = await apiConfig()
  let service = await openHarnessApiServer({ host: f.spec, api: resolveApiConfig(decodeApiConfig(config), f.spec, f.directory), credentials: {} })
  const port = service.ready.listen.port, options = await clientOptions(port)
  const raw = buildOperatorProfile({ kind: 'remote', origin: options.origin, serverName: 'localhost',
    tlsFiles: { ca: `${certificateDirectory}ca.pem`, cert: `${certificateDirectory}client.pem`, key: `${certificateDirectory}client-key.pem` },
    limits: options.limits, targets: { agentKeys: ['writer'], workflowKeys: [] } })
  await writeFile(f.profilePath, JSON.stringify(raw))
  let session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  const replacement = hostConfig(join(f.directory, 'replacement-store'))
  const members = replacement.members as readonly { readonly [key: string]: unknown }[]
  const replacementSpec = resolveHostConfig(decodeHostConfig({ ...replacement, members: [{ ...members[0],
    sessionId: '15000000-0000-4000-8000-000000000098' }] }, f.directory))
  const backend = new FileSessionBackend(replacementSpec.storage)
  try {
    const original = await session.submit({ agentKey: 'writer', submissionKey: 'replacement-resume', text: 'Belongs only to the original Session' })
    expect(original.acceptance).toBe('accepted')
    await session.close(); await initializeHost(replacementSpec)
    const openConnection = connections.openOperatorConnection
    let swapped = false
    vi.spyOn(connections, 'openOperatorConnection').mockImplementation(async (...args) => {
      const connection = await openConnection(...args)
      return { ...connection, request: async <M extends ControlMethod>(method: M, params: Params<M>, signal?: AbortSignal) => {
        const actual = await connection.request(method, params, signal)
        if (method === 'agent.get' && !swapped) {
          swapped = true
          await service.dispose()
          service = await openHarnessApiServer({ host: replacementSpec, credentials: {},
            api: resolveApiConfig(decodeApiConfig({ ...config, listenPort: port }), replacementSpec, f.directory) })
        }
        return actual
      } }
    })
    session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
    const restored = await session.resume(original.operationId!).catch(error => ({ error }))
    expect(swapped).toBe(true)
    expect(restored.error).toMatchObject({ code: 'OPERATOR_BINDING_CHANGED' })
    expect(session.intents()).toHaveLength(1)
    expect((await backend.readPrefix(parseSessionId(replacementSpec.members[0]!.sessionId))).events
      .filter(event => event.type === 'agent/input-accepted')).toHaveLength(0)
  } finally {
    vi.restoreAllMocks(); await backend.dispose(); await session.close(); await service.dispose()
    await rm(f.directory, { recursive: true, force: true })
  }
})
