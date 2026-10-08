import { readFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import { expect, it } from 'vitest'
import { createHarnessClient } from '../../src/client/client.js'
import { openHarnessUiServer } from '../../src/ui/server.js'
import { decodeUiConfig, resolveUiConfig } from '../../src/ui/config.js'
import { CONTROL_PROTOCOL, CONTROL_VERSION, decodeControlRequest } from '../../src/protocol/index.js'
import { certificateDirectory } from '../api/fixtures.js'
import { password, uiConfig, uiFixture } from './fixtures.js'

it('keeps a lost remote mutation receipt unknown and queries the original durable input without retry', async () => {
  const fixture = await uiFixture(), relay = createHarnessClient(fixture.options)
  const [ca, cert, key] = await Promise.all(['ca.pem', 'server.pem', 'server-key.pem'].map(name => readFile(`${certificateDirectory}${name}`)))
  let submissions = 0
  const proxy = createServer({ ca, cert, key, requestCert: true, rejectUnauthorized: true }, (request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array))
      const call = decodeControlRequest(JSON.parse(Buffer.concat(chunks).toString()), { maxBytes: 1048576, maxDepth: 64, maxNodes: 100000 })
      const result = await relay.request(call.method, call.params)
      if (call.method === 'input.submit') { submissions++; response.destroy(); return }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId: call.requestId, kind: 'result', result }))
    })().catch(() => response.destroy())
  })
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const address = proxy.address(); if (address === null || typeof address === 'string') throw new Error('Proxy not listening')
  const ui = await openHarnessUiServer({ config: resolveUiConfig(decodeUiConfig(uiConfig(address.port)), fixture.directory), password })
  try {
    const login = await fetch(`${ui.ready.url}/api/login`, { method: 'POST', headers: { origin: ui.ready.url, 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!
    const call = async (method: string, params: unknown) => await (await fetch(`${ui.ready.url}/api/control`, { method: 'POST',
      headers: { origin: ui.ready.url, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ method, params }) })).json()
    const failure = await call('input.submit', { agentKey: 'writer', submissionKey: 'lost-ui-receipt', text: 'Persistent original' })
    expect(failure.error).toMatchObject({ code: 'CLIENT_TRANSPORT_ERROR', acceptance: 'unknown' })
    const observed = await call('input.get', { agentKey: 'writer', submissionKey: 'lost-ui-receipt' })
    expect(observed.result.submission.key).toBe('lost-ui-receipt'); expect(observed.result.status).toBe('queued')
    expect(submissions).toBe(1)
    expect((await relay.request('agent.get', { agentKey: 'writer' })).report.counts.inputs).toBe(1)
  } finally {
    await ui.dispose(); await new Promise<void>((resolve, reject) => proxy.close(error => error === undefined ? resolve() : reject(error)))
    await relay.close(); await fixture.dispose()
  }
}, 30000)
