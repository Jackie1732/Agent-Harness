import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionRepository } from '../src/session/repository.js'
import { MemorySessionBackend } from '../src/session/memory-backend.js'
import * as connections from '../src/operator/connection.js'
import type { OperatorConnection } from '../src/operator/connection.js'
import { OperatorJournal } from '../src/operator/intents.js'
import { operatorCatalog, operatorFactEvent } from '../src/operator/intent-events.js'
import { buildOperatorProfile, resolveOperatorProfile } from '../src/operator/profile.js'
import { operatorOutcome } from '../src/operator/receipts.js'
import { openOperatorSession } from '../src/operator/session.js'
import type { OperatorIntent, OperatorResult } from '../src/operator/types.js'
import { ClientTransportError } from '../src/client/errors.js'
import type { ControlMethod, Result } from '../src/protocol/index.js'
import type { ApplicationResult } from '../src/control/types.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const instanceId = '15000000-0000-4000-8000-000000000001'

async function memoryJournal() {
  const repository = new SessionRepository({ backend: new MemorySessionBackend({ maxRecordBytes: 1048576 }), catalog: operatorCatalog, maxLineageDepth: 0 })
  cleanup.push(() => repository.dispose())
  const session = await repository.create()
  const profile = resolveOperatorProfile(buildOperatorProfile({ kind: 'local', hostConfig: 'host.json', shutdownMode: 'drain' }), 'operator.json')
  const journal = new OperatorJournal(session, profile, 'a'.repeat(64))
  await journal.initialize()
  const prepare = (acknowledgedIntent: string | null = null) => journal.prepare({ method: 'host.run', params: { expectedInstanceId: instanceId },
    scope: { connection: 'local', connectionLifetime: 'session', hostKey: 'research', instanceId, sessionId: null },
    parentIntent: null, callerNamespace: profile.callerNamespace, certificateFingerprint: null, configDigest: 'b'.repeat(64), acknowledgedIntent })
  return { repository, session, journal, profile, prepare, intent: await prepare() }
}

it('captures a queued outcome before its producer changes receipt fields', async () => {
  const { session, journal, intent } = await memoryJournal()
  const outcome = { ...operatorOutcome('unknown', null, 'OPERATOR_CONNECTION_FAILED', 'host.run'), summary: { namespace: 'local:original' } }
  const pending = journal.complete(intent.id, outcome)
  outcome.acceptance = 'not-accepted'; outcome.summary.namespace = 'local:changed'
  await pending
  expect(session.snapshot().history[0]!.events.at(-1)!.stored.payload)
    .toMatchObject({ outcome: { acceptance: 'unknown', summary: { namespace: 'local:original' } } })
  expect(journal.get(intent.id)!.outcome).toMatchObject({ acceptance: 'unknown', summary: { namespace: 'local:original' } })
})

it('keeps the committed projection and reopened receipt equal when a producer reuses its object', async () => {
  const { repository, session, journal, profile, intent } = await memoryJournal()
  const outcome = { ...operatorOutcome('unknown', null, 'OPERATOR_CONNECTION_FAILED', 'host.run'), summary: { namespace: 'local:original' } }
  await journal.complete(intent.id, outcome)
  outcome.acceptance = 'not-accepted'; outcome.summary.namespace = 'local:changed'
  const recorded = journal.get(intent.id)!.outcome!
  expect(Object.isFrozen(recorded)).toBe(true)
  expect(Object.isFrozen(recorded.summary)).toBe(true)
  expect(recorded).toMatchObject({ acceptance: 'unknown', summary: { namespace: 'local:original' } })
  await session.dispose()
  const reopened = new OperatorJournal(await repository.open(session.header.sessionId), profile, 'a'.repeat(64))
  expect(reopened.get(intent.id)!.outcome).toEqual(recorded)
})

it('rejects a second completion after the preceding outcome commit without replacing it', async () => {
  const { journal, session, intent } = await memoryJournal()
  const first = journal.complete(intent.id, operatorOutcome('unknown', null, 'OPERATOR_CONNECTION_FAILED', 'host.run'))
  const second = expect(journal.complete(intent.id, operatorOutcome('not-accepted', null, 'API_FORBIDDEN', 'host.run')))
    .rejects.toMatchObject({ code: 'OPERATOR_INTENT_INVALID' })
  await first; await second
  expect(session.snapshot().localPosition).toBe(3)
  expect(journal.get(intent.id)!.outcome!.acceptance).toBe('unknown')
})

it('requires the latest unknown Run confirmation for each new batch while preserving its history', async () => {
  const { journal, session, prepare, intent } = await memoryJournal()
  await journal.complete(intent.id, operatorOutcome('unknown', null, 'OPERATOR_CONNECTION_FAILED', 'host.run'))
  const original = journal.get(intent.id)!
  await expect(prepare()).rejects.toMatchObject({ code: 'OPERATOR_RUN_UNKNOWN_REQUIRED' })
  const first = await prepare(intent.id)
  expect(first).toMatchObject({ acknowledgedIntent: intent.id, acknowledgementReason: 'operator-requested-new-batch', outcome: null })
  await expect(prepare(intent.id)).rejects.toMatchObject({ code: 'OPERATOR_RUN_UNKNOWN_REQUIRED' })
  await journal.complete(first.id, operatorOutcome('accepted', null, null, 'host.run'))
  await expect(prepare()).rejects.toMatchObject({ code: 'OPERATOR_RUN_UNKNOWN_REQUIRED' })
  const next = await prepare(intent.id)
  await journal.complete(next.id, operatorOutcome('accepted', null, null, 'host.run'))
  expect(journal.get(intent.id)).toEqual(original)
  expect(session.snapshot().history[0]!.events.map(event => operatorFactEvent.decode(event.stored.payload))
    .filter(fact => fact.kind === 'outcome' && fact.intentId === intent.id)).toHaveLength(1)
})

it('refuses a waiting new batch before dispatch when the preceding Run receipt becomes unknown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'step15-operator-admission-')), profilePath = join(directory, 'operator.json')
  const profile = buildOperatorProfile({ kind: 'remote', origin: 'https://fixture.invalid', serverName: null,
    tlsFiles: { ca: 'ca.pem', cert: 'cert.pem', key: 'key.pem' }, targets: { agentKeys: [], workflowKeys: [] },
    limits: { maxRequestBytes: 1048576, maxResponseBytes: 1048576, maxJsonDepth: 32, maxJsonNodes: 10000,
      connectTimeoutMs: 1000, requestTimeoutMs: 1000, maxConnections: 2 } })
  await writeFile(profilePath, JSON.stringify(profile))
  const counts = { members: 0, pendingInputs: 0, pendingWaits: 0, pendingOutbox: 0, pendingMaintenance: 0,
    runnableInputs: 0, reviewRequiredInputs: 0, unsupportedInputs: 0, blockedMembers: 0, failedRoots: 0, exhaustedRoots: 0 }
  const status: Result<'host.status'> = { instanceId, cuts: [], hostStatus: 'ready', activity: 'idle', report: {
    status: 'ready', shutdownMode: null, hostKey: 'research', instanceId, configVersion: 3, configFingerprint: 'a'.repeat(64),
    configuredMembers: 0, remoteMembers: 0, unfinishedOperations: 0, shutdownOverdue: false, blockedRoutes: [], members: [], counts,
    truncated: false, cuts: [] } }
  const receipt: Result<'host.run'> = { instanceId, cuts: [], report: { batches: 0, businessRuns: 0, maintenanceRuns: 0,
    deliveryAttempts: 0, stoppedBy: 'quiescent', blockedRoutes: [], members: [], counts, truncated: false } }
  let dispatches = 0
  const connection: OperatorConnection = { certificateFingerprint: null, spec: null, callerNamespace: 'api:fixture',
    request: async <M extends ControlMethod>(method: M): Promise<ApplicationResult<M>> => {
      if (method === 'host.status') return status as ApplicationResult<M>
      if (method !== 'host.run') throw new Error('Unexpected method')
      if (++dispatches === 1) throw new ClientTransportError('unknown')
      return receipt as ApplicationResult<M>
    }, close: async () => undefined }
  vi.spyOn(connections, 'openOperatorConnection').mockResolvedValue(connection)
  const original = OperatorJournal.prototype.prepare
  let preparations = 0, bothEntered!: () => void, releaseSecond!: () => void
  const both = new Promise<void>(resolve => { bothEntered = resolve }), held = new Promise<void>(resolve => { releaseSecond = resolve })
  vi.spyOn(OperatorJournal.prototype, 'prepare').mockImplementation(async function (this: OperatorJournal, input) {
    const ordinal = ++preparations
    if (ordinal === 2) bothEntered()
    const intent: OperatorIntent = await original.call(this, input)
    if (ordinal === 1) await both
    if (ordinal === 2) await held
    return intent
  })
  const session = await openOperatorSession(profilePath, { lifetime: 'session', environment: {} })
  let second: Promise<OperatorResult> | undefined
  try {
    const first = session.execute('host.run', { expectedInstanceId: instanceId })
    second = session.execute('host.run', { expectedInstanceId: instanceId })
    expect(await first).toMatchObject({ acceptance: 'unknown' })
    expect(session.intents()[0]!.outcome!.acceptance).toBe('unknown')
    expect(dispatches).toBe(1)
    releaseSecond()
    expect(await second).toMatchObject({ acceptance: 'not-accepted', operationId: null, error: { code: 'OPERATOR_RUN_UNKNOWN_REQUIRED' } })
    expect(dispatches).toBe(1)
    expect(session.intents()).toHaveLength(1)
  } finally {
    bothEntered(); releaseSecond(); await Promise.allSettled(second === undefined ? [] : [second])
    vi.restoreAllMocks(); await session.close(); await rm(directory, { recursive: true, force: true })
  }
})
