import { createServer } from 'node:https'
import { readFile } from 'node:fs/promises'
import type { Server } from 'node:https'
import { afterEach, expect, it } from 'vitest'
import { createHarnessClient } from '../../src/client/client.js'
import { CONTROL_PROTOCOL, CONTROL_VERSION } from '../../src/protocol/index.js'
import { parseSessionId, sessionLogPosition } from '../../src/session/ids.js'
import { certificateDirectory, clientOptions } from '../api/fixtures.js'

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
