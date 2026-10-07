import { createServer } from 'node:https'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Server } from 'node:https'
import { afterEach, expect, it, vi } from 'vitest'
import { createHarnessClient } from '../../src/client/client.js'
import { CONTROL_PROTOCOL, CONTROL_VERSION } from '../../src/protocol/index.js'
import type { InputReceipt, SessionEventPage } from '../../src/protocol/index.js'
import { formatSessionEventId, parseSessionId, sessionLogPosition, sessionSequence } from '../../src/session/ids.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { initializeHost } from '../../src/host/initialization.js'
import { decodeApiConfig, resolveApiConfig } from '../../src/api/config.js'
import { openHarnessApiServer } from '../../src/api/server.js'
import { twoMemberHostConfig } from '../host/fixtures.js'
import { apiConfig, certificateDirectory, clientOptions } from '../api/fixtures.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function fake(handler: Parameters<typeof createServer>[1]) {
  const [ca, cert, key] = await Promise.all(['ca.pem', 'server.pem', 'server-key.pem'].map(name => readFile(`${certificateDirectory}${name}`)))
  const server: Server = createServer({ ca: ca!, cert: cert!, key: key!, requestCert: true, rejectUnauthorized: true }, handler)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.close(error => error === undefined ? resolve() : reject(error)); server.closeAllConnections() }))
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('server address')
  const client = createHarnessClient(await clientOptions(address.port)); cleanup.push(() => client.dispose())
  return client
}
it('rejects inconsistent HTTP receipts as unknown without retrying a possible mutation', async () => {
  let calls = 0
  const client = await fake((request, response) => {
    calls++
    const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk)); request.once('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { requestId: string }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId: body.requestId, kind: 'error',
        error: { code: 'API_FORBIDDEN', message: 'rejected', acceptance: 'not-accepted', domainCode: null } }))
    })
  })
  await expect(client.request('input.submit', { agentKey: 'writer', submissionKey: 'x', text: 'x' })).rejects.toMatchObject({ name: 'ClientTransportError', acceptance: 'unknown' })
  expect(calls).toBe(1)
})
it('aborts only the local request after the complete body has reached the server', async () => {
  let received!: () => void
  const accepted = new Promise<void>(resolve => { received = resolve })
  const client = await fake((request, _response) => { request.resume(); request.once('end', received) })
  const abort = new AbortController()
  const request = client.request('input.submit', { agentKey: 'writer', submissionKey: 'x', text: 'x' }, { signal: abort.signal })
  const checked = expect(request).rejects.toMatchObject({ name: 'ClientAbortError', acceptance: 'unknown' })
  await accepted; abort.abort(); await checked
  expect(client.close()).toBe(client.dispose())
  await client.close()
  await expect(client.request('input.submit', { agentKey: 'writer', submissionKey: 'later', text: 'later' })).rejects.toMatchObject({ name: 'ClientAbortError', acceptance: 'not-accepted' })
})
it('rejects origin downgrade and invalid deployment limits before networking', async () => {
  const options = await clientOptions(1)
  expect(() => createHarnessClient({ ...options, origin: 'http://localhost' })).toThrow()
  expect(() => createHarnessClient({ ...options, origin: 'https://user:password@localhost' })).toThrow()
  expect(() => createHarnessClient({ ...options, origin: 'https://localhost/redirect' })).toThrow()
  expect(() => createHarnessClient({ ...options, limits: { ...options.limits, requestTimeoutMs: 2147483648 } })).toThrow()
  const client = createHarnessClient(options); await client.close()
})
it('normalizes synchronous TLS request failures without retaining timers or close work', async () => {
  const options = await clientOptions(1)
  const client = createHarnessClient({ ...options, tls: { ...options.tls, key: 'invalid PEM' },
    limits: { ...options.limits, connectTimeoutMs: 40, requestTimeoutMs: 80 } })
  vi.useFakeTimers()
  try {
    await expect(client.request('input.submit', { agentKey: 'writer', submissionKey: 'bad-key', text: 'task' }))
      .rejects.toMatchObject({ name: 'ClientTransportError', acceptance: 'not-accepted' })
    await expect(client.request('host.status', {}))
      .rejects.toMatchObject({ name: 'ClientTransportError', acceptance: 'not-applicable' })
    expect(vi.getTimerCount()).toBe(0)
    expect(client.close()).toBe(client.dispose())
    await client.close()
    await vi.advanceTimersByTimeAsync(81)
    expect(vi.getTimerCount()).toBe(0)
  } finally { await client.dispose(); vi.useRealTimers() }
})
it('rejects a structurally valid response that changes the requested fixed event cut', async () => {
  const sessionId = parseSessionId('70000000-0000-4000-8000-000000000101')
  const client = await fake((request, response) => {
    const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk)); request.once('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { requestId: string }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId: body.requestId, kind: 'result',
        result: { sessionId, through: 1, parent: null, events: [], nextCursor: null, hasMore: false } }))
    })
  })
  await expect(client.request('session.events', { target: { kind: 'member', agentKey: 'writer' }, maxEvents: 1,
    cursor: { sessionId, through: sessionLogPosition(0), nextSequence: 1 } })).rejects.toMatchObject({ name: 'ClientTransportError', acceptance: 'not-applicable' })
})

const eventSession = parseSessionId('70000000-0000-4000-8000-000000000102')
const eventRecords = [1, 2].map(sequence => ({ envelopeVersion: 1, sessionId: eventSession,
  eventId: formatSessionEventId(eventSession, sessionSequence(sequence)), sequence, recordedAt: '2026-10-07T00:00:00.000Z',
  type: 'future/event', payloadVersion: 1, ignorable: true, payload: { text: 'retained' } }))

it.each([false, true])('rejects oversized pages without retrying when caller changes its query: %s', async changeQuery => {
  let calls = 0, receivedMaxEvents = 0
  const client = await fake((request, response) => {
    calls++
    const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk)); request.once('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { requestId: string; params: { maxEvents: number } }
      receivedMaxEvents = body.params.maxEvents
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId: body.requestId, kind: 'result',
        result: { sessionId: eventSession, through: 2, parent: null, events: eventRecords, nextCursor: null, hasMore: false } }))
    })
  })
  const query = { target: { kind: 'member' as const, agentKey: 'writer' }, maxEvents: 1 }
  const pending = client.request('session.events', query)
  if (changeQuery) query.maxEvents = 2
  await expect(pending).rejects.toMatchObject({ name: 'ClientTransportError', acceptance: 'not-applicable' })
  expect(receivedMaxEvents).toBe(1)
  expect(calls).toBe(1)
})

it('iterates legal pages within the requested event count to their fixed cut', async () => {
  let calls = 0
  const client = await fake((request, response) => {
    calls++
    const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk)); request.once('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { requestId: string; params: { cursor?: { nextSequence: number } } }
      const sequence = body.params.cursor?.nextSequence ?? 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId: body.requestId, kind: 'result',
        result: { sessionId: eventSession, through: 2, parent: null, events: [eventRecords[sequence - 1]], hasMore: sequence === 1,
          nextCursor: sequence === 1 ? { sessionId: eventSession, through: 2, nextSequence: 2 } : null } }))
    })
  })
  const pages = []
  for await (const page of client.events({ target: { kind: 'member', agentKey: 'writer' }, maxEvents: 1 })) pages.push(page)
  expect(pages.map(page => page.events.map(event => event.sequence))).toEqual([[1], [2]])
  expect(pages.map(page => page.through)).toEqual([2, 2])
  expect(calls).toBe(2)
})

it('retains an advanced iterator target and page budget when the caller reuses its query template', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'atomic-client-iterator-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const host = resolveHostConfig(decodeHostConfig(twoMemberHostConfig(join(directory, 'store')), directory))
  await initializeHost(host)
  const raw = await apiConfig()
  const api = resolveApiConfig(decodeApiConfig({ ...raw, principals: [{ ...raw.principals[0]!, agentKeys: ['writer', 'reviewer'] }] }), host, directory)
  const service = await openHarnessApiServer({ host, api, credentials: {} })
  cleanup.push(() => service.dispose())
  const client = createHarnessClient(await clientOptions(service.ready.listen.port))
  cleanup.push(() => client.dispose())
  const query = { target: { kind: 'member' as const, agentKey: 'writer' }, maxEvents: 1 }
  const pages: SessionEventPage[] = []
  let appended: InputReceipt | undefined
  for await (const page of client.events(query)) {
    pages.push(page)
    if (pages.length === 1) {
      expect(page.hasMore).toBe(true)
      query.target.agentKey = 'reviewer'
      query.maxEvents = 2
      appended = await client.request('input.submit', { agentKey: 'writer', submissionKey: 'after-cut', text: 'After the captured cut' })
    }
  }
  const first = pages[0]!, events = pages.flatMap(page => page.events)
  expect(pages.every(page => page.sessionId === first.sessionId && page.through === first.through && page.events.length === 1)).toBe(true)
  expect(events).toHaveLength(first.through)
  expect(events.at(-1)?.sequence).toBe(first.through)
  expect(pages.at(-1)?.nextCursor).toBeNull()
  expect(events.map(event => event.eventId)).not.toContain(appended!.inputEventId)
  const later = await client.request('session.events', { target: { kind: 'member', agentKey: 'writer' }, after: first.through, maxEvents: 10 })
  expect(later.events.map(event => event.eventId)).toContain(appended!.inputEventId)
})
