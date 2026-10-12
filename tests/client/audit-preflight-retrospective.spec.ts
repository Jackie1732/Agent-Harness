import { createServer } from 'node:https'
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { createHarnessClient } from '../../src/client/client.js'
import type { ClientLimits } from '../../src/client/config.js'
import { CONTROL_PROTOCOL, CONTROL_VERSION, ProtocolError, decodeParams } from '../../src/protocol/index.js'
import { browserFailure } from '../../src/ui/http.js'
import { certificateDirectory, clientOptions } from '../api/fixtures.js'
import { results } from '../protocol/result-fixture.js'

it.each([
  { budget: 'bytes', limits: { maxRequestBytes: 256 }, text: 'x'.repeat(100) },
  { budget: 'depth', limits: { maxJsonDepth: 1 }, text: 'task' },
  { budget: 'nodes', limits: { maxJsonNodes: 4 }, text: 'task' },
] satisfies readonly { readonly budget: string; readonly limits: Partial<ClientLimits>; readonly text: string }[])(
  'rejects the complete request envelope at its $budget budget before HTTP admission', async ({ budget, limits, text }) => {
    const [ca, cert, key] = await Promise.all(['ca.pem', 'server.pem', 'server-key.pem'].map(name => readFile(`${certificateDirectory}${name}`)))
    let calls = 0
    const server = createServer({ ca: ca!, cert: cert!, key: key!, requestCert: true, rejectUnauthorized: true }, (request, response) => {
      calls++
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.once('end', () => {
        const input = JSON.parse(Buffer.concat(chunks).toString()) as { requestId: string }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId: input.requestId,
          kind: 'result', result: results['host.status'] }))
      })
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Expected a listening TCP server')
    const options = await clientOptions(address.port)
    const client = createHarnessClient({ ...options, limits: { ...options.limits, ...limits } })
    try {
      const params = { agentKey: 'writer', submissionKey: 'fixed-request', text }
      expect(decodeParams('input.submit', params, { maxBytes: limits.maxRequestBytes ?? options.limits.maxRequestBytes,
        maxDepth: limits.maxJsonDepth ?? options.limits.maxJsonDepth, maxNodes: limits.maxJsonNodes ?? options.limits.maxJsonNodes })).toEqual(params)
      let failure: unknown
      try { await client.request('input.submit', params) }
      catch (error) { failure = error }
      expect(failure).toBeInstanceOf(ProtocolError)
      expect(failure).toMatchObject({ code: 'API_LIMIT_EXCEEDED' })
      expect(browserFailure(failure, 'input.submit')).toMatchObject({ status: 413,
        error: { code: 'UI_LIMIT_EXCEEDED', acceptance: 'not-accepted' } })
      expect(calls).toBe(0)
      if (budget === 'bytes') {
        expect(await client.request('host.status', {})).toEqual(results['host.status'])
        expect(calls).toBe(1)
      }
    } finally {
      await client.close()
      await new Promise<void>((resolve, reject) => {
        server.close(error => error === undefined ? resolve() : reject(error))
        server.closeAllConnections()
      })
    }
  },
)
