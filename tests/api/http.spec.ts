import { request } from 'node:https'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { initializeHost } from '../../src/host/initialization.js'
import { openHarnessApiServer } from '../../src/api/server.js'
import { decodeApiConfig, resolveApiConfig } from '../../src/api/config.js'
import { CONTROL_PATH, CONTROL_PROTOCOL, CONTROL_VERSION } from '../../src/protocol/index.js'
import { hostConfig } from '../host/fixtures.js'
import { apiConfig, clientOptions } from './fixtures.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })
async function setup(maxBytes = 65536, readTimeout = 1000) {
  const directory = await mkdtemp(join(tmpdir(), 'control-http-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const host = resolveHostConfig(decodeHostConfig(hostConfig(join(directory, 'store')), directory)); await initializeHost(host)
  const config = await apiConfig()
  const api = resolveApiConfig(decodeApiConfig({ ...config, limits: { ...config.limits, maxRequestBytes: maxBytes,
    requestReadTimeoutMs: readTimeout, headersTimeoutMs: 3000 } }), host, directory)
  const service = await openHarnessApiServer({ host, api, credentials: {} }); cleanup.push(() => service.dispose())
  const options = await clientOptions(service.ready.listen.port)
  return { service, options }
}
async function post(options: Awaited<ReturnType<typeof clientOptions>>, body: Buffer | undefined, headers: Record<string, string> = {}, method = 'POST') {
  return await new Promise<{ status: number; data: { kind: string; requestId: string | null; error: { code: string; acceptance: string } } }>((resolve, reject) => {
    const outgoing = request(new URL(CONTROL_PATH, options.origin), { method, ...options.tls, servername: options.serverName,
      headers: { 'content-type': 'application/json', ...headers } }, response => {
      const chunks: Buffer[] = []; response.on('data', chunk => chunks.push(chunk)); response.once('error', reject)
      response.once('end', () => {
        outgoing.destroy()
        try { resolve({ status: response.statusCode!, data: JSON.parse(Buffer.concat(chunks).toString()) }) } catch (error) { reject(error) }
      })
    })
    outgoing.once('error', reject)
    if (body === undefined) { outgoing.flushHeaders(); outgoing.write(' ') }
    else outgoing.end(body)
  })
}
it('rejects actual oversized and malformed UTF-8 bodies before accepting a domain method', async () => {
  const { options } = await setup(64)
  const over = await post(options, Buffer.alloc(65, 'x'))
  expect(over).toMatchObject({ status: 413, data: { requestId: null, error: { code: 'API_LIMIT_EXCEEDED', acceptance: 'not-accepted' } } })
  const utf8 = await post(options, Buffer.from([0xff]))
  expect(utf8).toMatchObject({ status: 400, data: { error: { code: 'API_PROTOCOL_INVALID' } } })
})
it('expires an incomplete body and closes its network resources without invoking Host', async () => {
  const { options, service } = await setup(65536, 50)
  expect(await post(options, undefined, { 'content-length': '100' })).toMatchObject({ status: 413, data: { error: { code: 'API_LIMIT_EXCEEDED' } } })
  await service.dispose(); expect(service.status).toBe('closed')
})
it('enforces method/path/media grammar and nested JSON limits over a real TLS socket', async () => {
  const { options } = await setup()
  expect(await post(options, Buffer.from('{}'), {}, 'PUT')).toMatchObject({ status: 400, data: { error: { code: 'API_PROTOCOL_INVALID' } } })
  const body = Buffer.from(JSON.stringify({ protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId: 'version', method: 'host.status', params: {} }))
  expect(await post(options, body, { 'content-type': 'text/plain' })).toMatchObject({ status: 400, data: { error: { code: 'API_PROTOCOL_INVALID' } } })
  const deep = JSON.stringify({ protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId: 'depth', method: 'input.submit', params: { agentKey: 'writer', submissionKey: 'x', text: 'x', extra: JSON.parse('['.repeat(80) + '0' + ']'.repeat(80)) } })
  expect(await post(options, Buffer.from(deep))).toMatchObject({ status: 413, data: { error: { code: 'API_LIMIT_EXCEEDED' } } })
})
