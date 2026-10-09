import { readFile, writeFile, rm } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import { expect, it, vi } from 'vitest'
import * as connections from '../src/operator/connection.js'
import { openOperatorSession } from '../src/operator/session.js'
import { buildOperatorProfile, readOperatorProfile } from '../src/operator/profile.js'
import { inspectOperatorJournal } from '../src/operator/intents.js'
import { displayValue } from '../src/tui/text.js'
import { runOperatorCli } from '../src/operator/cli.js'
import { operatorJson } from '../src/operator/cli-output.js'
import { followOperatorEvents } from '../src/operator/observations.js'
import { openHarnessApiServer } from '../src/api/server.js'
import { decodeApiConfig, resolveApiConfig } from '../src/api/config.js'
import type { ControlMethod, Params, SessionEventPage } from '../src/protocol/index.js'
import { apiConfig, certificateDirectory, clientOptions } from './api/fixtures.js'
import { localFixture } from './step15-operator-fixture.js'

async function fixture(kind: 'local' | 'remote', text = '中'.repeat(60) + '\u009b'.repeat(40)) {
  const f = await localFixture()
  const initial = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  let through = 0
  try {
    through = ((await initial.execute('session.events', { target: { kind: 'member', agentKey: 'writer' }, maxEvents: 64 })).result as SessionEventPage).through
    for (let index = 0; index < 8; index++) {
      expect(await initial.submit({ agentKey: 'writer', submissionKey: `event-page-${index}`, text })).toMatchObject({ acceptance: 'accepted' })
    }
  } finally { await initial.close() }
  let service: Awaited<ReturnType<typeof openHarnessApiServer>> | undefined
  try {
    let raw = f.raw
    if (kind === 'remote') {
      service = await openHarnessApiServer({ host: f.spec, credentials: {}, api: resolveApiConfig(decodeApiConfig(await apiConfig()), f.spec, f.directory) })
      const options = await clientOptions(service.ready.listen.port)
      raw = buildOperatorProfile({ kind: 'remote', origin: options.origin, serverName: 'localhost',
        tlsFiles: { ca: `${certificateDirectory}ca.pem`, cert: `${certificateDirectory}client.pem`, key: `${certificateDirectory}client-key.pem` },
        limits: options.limits, targets: { agentKeys: ['writer'], workflowKeys: [] } })
      raw = { ...raw, journal: { ...raw.journal, root: './remote-journal' } }
    }
    await writeFile(f.profilePath, JSON.stringify({ ...raw, observation: { ...raw.observation, maxPageBytes: 4096, maxPageEvents: 4 },
      output: { ...raw.output, maxBytes: 2048 } }))
    return { ...f, through, query: { target: { kind: 'member' as const, agentKey: 'writer' }, after: through, maxEvents: 64 },
      async dispose() { await service?.dispose(); await rm(f.directory, { recursive: true, force: true }) } }
  } catch (error) { await service?.dispose(); await rm(f.directory, { recursive: true, force: true }); throw error }
}

it.each(['local', 'remote'] as const)('repaginates the %s fixed cut to fit the complete encoded operator page', async kind => {
  const f = await fixture(kind), original = connections.openOperatorConnection
  const queries: Params<'session.events'>[] = [], cuts: SessionEventPage[] = []
  vi.spyOn(connections, 'openOperatorConnection').mockImplementation(async (...args) => {
    const connection = await original(...args)
    return { ...connection, request: async <M extends ControlMethod>(method: M, params: Params<M>, signal?: AbortSignal) => {
      const actual = await connection.request(method, params, signal)
      if (method === 'session.events') {
        queries.push(params as Params<'session.events'>); cuts.push(actual as SessionEventPage)
        if (queries.length === 1) await connection.request('input.submit', { agentKey: 'writer', submissionKey: 'newer-cut', text: 'Added after the first page cut' })
      }
      return actual
    } }
  })
  const session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  const priorIntents = session.intents()
  try {
    const result = await session.execute('session.events', f.query), page = result.result as SessionEventPage
    expect(result).toMatchObject({ status: 'ok', acceptance: 'not-applicable' })
    expect(Buffer.byteLength(operatorJson(result)) + 1).toBeLessThanOrEqual(session.profile.output.maxBytes)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(session.profile.observation.maxPageBytes)
    expect(page.events.length).toBeGreaterThan(0)
    expect(page.events.length).toBeLessThan(cuts[0]!.events.length)
    expect(page.events[0]!.sequence).toBe(f.through + 1)
    expect(page.through).toBe(cuts[0]!.through)
    expect(page.hasMore).toBe(true)
    expect(page.events[0]?.payload).toMatchObject({ input: { text: '中'.repeat(60) + '\u009b'.repeat(40) } })
    expect(queries[0]!.maxEvents).toBe(4)
    for (const query of queries.slice(1)) expect(query).toMatchObject({ cursor: {
      sessionId: cuts[0]!.sessionId, through: cuts[0]!.through, nextSequence: f.through + 1,
    } })
    expect(session.intents()).toEqual(priorIntents)
    expect(session.eventCheckpoint(page.sessionId)).toBeUndefined()
    const next = await session.execute('session.events', { target: f.query.target, maxEvents: 4, cursor: page.nextCursor! })
    expect((next.result as SessionEventPage).events[0]!.sequence).toBe(page.events.at(-1)!.sequence + 1)
  } finally { vi.restoreAllMocks(); await session.close(); await f.dispose() }
})

it.each([['local', true], ['remote', true], ['local', false], ['remote', false]] as const)('writes every %s CLI event page within the configured output budget (JSON: %s)', async (kind, json) => {
  const f = await fixture(kind, json ? undefined : '学术观察'.repeat(25))
  try {
    let cursor: SessionEventPage['nextCursor'] | undefined, seen = 0
    do {
      const params = cursor === undefined ? f.query : { target: f.query.target, maxEvents: 4, cursor }
      let output = ''
      const io = { stdin: Readable.from([JSON.stringify(params)]), stdout: new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback() } }),
        stderr: new Writable({ write(_chunk, _encoding, callback) { callback() } }) }
      expect(await runOperatorCli(['events', '--params-stdin', '--profile', f.profilePath, ...(json ? ['--json'] : [])], io, {})).toBe(0)
      expect(Buffer.byteLength(output)).toBeLessThanOrEqual(2048)
      const result = JSON.parse(output) as { result: SessionEventPage; closing: { status: string } }
      expect(result.closing.status).toBe(kind === 'local' ? 'released' : 'not-owned')
      expect(result.result.events[0]!.sequence).toBe(f.through + seen + 1)
      seen += result.result.events.length; cursor = result.result.nextCursor
    } while (cursor !== null)
    expect(seen).toBe(8)
  } finally { await f.dispose() }
})

it.each(['local', 'remote'] as const)('applies the independent %s observation byte budget when output has more room', async kind => {
  const f = await fixture(kind)
  const raw = JSON.parse(await readFile(f.profilePath, 'utf8'))
  await writeFile(f.profilePath, JSON.stringify({ ...raw, observation: { ...raw.observation, maxPageBytes: 1024 }, output: { ...raw.output, maxBytes: 8192 } }))
  const session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  try {
    const result = await session.execute('session.events', f.query), page = result.result as SessionEventPage
    expect(result.status).toBe('ok')
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024)
    expect(page.events).toHaveLength(1)
    expect(page.events[0]!.sequence).toBe(f.through + 1)
    expect(page.hasMore).toBe(true)
  } finally { await session.close(); await f.dispose() }
})

it.each(['local', 'remote'] as const)('reports an indivisible %s event before consumption and checkpointing when its envelope cannot fit', async kind => {
  const f = await fixture(kind, '中'.repeat(400)), session = await openOperatorSession(f.profilePath, { lifetime: 'session', environment: {} })
  const priorIntents = session.intents()
  let consumed = 0
  try {
    const result = await session.execute('session.events', f.query)
    expect(result).toMatchObject({ status: 'failed', acceptance: 'not-applicable', result: null,
      error: { code: 'OPERATOR_EVENT_PAGE_LIMIT' } })
    expect(Buffer.byteLength(operatorJson(result)) + 1).toBeLessThanOrEqual(2048)
    expect(await followOperatorEvents(session, f.query, () => { consumed++ })).toMatchObject({ pages: 0, events: 0, stoppedBy: 'read-failure' })
    expect(consumed).toBe(0)
    expect(session.intents()).toEqual(priorIntents)
    expect(session.eventCheckpoint(f.spec.members[0]!.sessionId)).toBeUndefined()
    expect(await session.submit({ agentKey: 'writer', submissionKey: 'still-writable', text: 'An observation budget failure never stops mutations' }))
      .toMatchObject({ status: 'ok', acceptance: 'accepted' })
  } finally { await session.close(); await f.dispose() }
})

it.each([['local', true], ['remote', true], ['local', false], ['remote', false]] as const)('preserves the %s page and actual close failure within the final CLI output budget (JSON: %s)', async (kind, json) => {
  const f = await fixture(kind, '中'.repeat(60) + (json ? '\u009b'.repeat(400) : '学术观察'.repeat(10)))
  const raw = JSON.parse(await readFile(f.profilePath, 'utf8'))
  await writeFile(f.profilePath, JSON.stringify({ ...raw, observation: { ...raw.observation, maxPageBytes: 16384 }, output: { ...raw.output, maxBytes: 16384 } }))
  const probe = await openOperatorSession(f.profilePath, { lifetime: 'command', environment: {} })
  let maxBytes = 0
  try {
    const result = await probe.execute('session.events', f.query)
    expect(result.status).toBe('ok')
    maxBytes = Math.max(Buffer.byteLength(operatorJson(result)), Buffer.byteLength(displayValue(result, probe.profile.display.maxTextBytes))) + 1
  } finally { await probe.close() }
  await writeFile(f.profilePath, JSON.stringify({ ...raw, observation: { ...raw.observation, maxPageBytes: 16384 }, output: { ...raw.output, maxBytes } }))
  const original = connections.openOperatorConnection
  let closeFailures = 0
  vi.spyOn(connections, 'openOperatorConnection').mockImplementation(async (...args) => {
    const connection = await original(...args)
    return { ...connection, close: async mode => {
      await connection.close(mode); closeFailures++
      throw new Error('Actual connection release joined before reporting failure')
    } }
  })
  try {
    let output = ''
    const io = { stdin: Readable.from([JSON.stringify(f.query)]), stdout: new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback() } }),
      stderr: new Writable({ write(_chunk, _encoding, callback) { callback() } }) }
    expect(await runOperatorCli(['events', '--params-stdin', '--profile', f.profilePath, ...(json ? ['--json'] : [])], io, {})).toBe(1)
    expect(closeFailures).toBeGreaterThan(0)
    expect(output.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(maxBytes)
    const result = JSON.parse(output) as { result: SessionEventPage }
    expect(result).toMatchObject({ status: 'failed', acceptance: 'not-applicable',
      result: { through: f.through + 8, hasMore: true }, error: { code: 'OPERATOR_CLOSE_FAILED' },
      closing: { status: kind === 'local' ? 'failed' : 'not-owned', mode: kind === 'local' ? 'drain' : null } })
    expect(result.result.events.length).toBeGreaterThan(0)
    expect(result.result.events.map(event => event.sequence)).toEqual(Array.from({ length: result.result.events.length }, (_, index) => f.through + index + 1))
    const { profile } = await readOperatorProfile(f.profilePath)
    expect((await inspectOperatorJournal(profile)).some(fact => fact.kind === 'checkpoint')).toBe(false)
  } finally { vi.restoreAllMocks(); await f.dispose() }
})
