import { IncomingMessage, ServerResponse } from 'node:http'
import { connect as connectTcp, Socket } from 'node:net'
import { connect as connectTls } from 'node:tls'
import type { TLSSocket } from 'node:tls'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { initializeHost } from '../../src/host/initialization.js'
import { decodeApiConfig, resolveApiConfig } from '../../src/api/config.js'
import type { ApiLimits } from '../../src/api/config.js'
import { openHarnessApiServer } from '../../src/api/server.js'
import { writeResponse } from '../../src/api/http-io.js'
import { createHarnessClient } from '../../src/client/client.js'
import { hostConfig } from '../host/fixtures.js'
import { apiConfig, clientOptions } from './fixtures.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function fixture(limits: Partial<ApiLimits>) {
  const directory = await mkdtemp(join(tmpdir(), 'api-io-budgets-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const host = resolveHostConfig(decodeHostConfig(hostConfig(join(directory, 'store')), directory))
  await initializeHost(host)
  const config = await apiConfig()
  const service = await openHarnessApiServer({ host, api: resolveApiConfig(decodeApiConfig({ ...config,
    limits: { ...config.limits, ...limits } }), host, directory), credentials: {} })
  cleanup.push(() => service.dispose())
  const options = await clientOptions(service.ready.listen.port)
  const client = createHarnessClient(options)
  cleanup.push(() => client.dispose())
  return { service, options, client }
}

function closed(socket: Socket): Promise<string> {
  cleanup.push(async () => { socket.destroy() })
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Socket release deadline exceeded')) }, 5000)
    socket.on('data', chunk => chunks.push(chunk))
    // Native TLS and connection-limit rejection can reset the peer before an HTTP response exists.
    socket.on('error', () => undefined)
    socket.once('close', () => { clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')) })
  })
}

async function tlsSocket(options: Awaited<ReturnType<typeof clientOptions>>): Promise<{ socket: TLSSocket; released: Promise<string> }> {
  const socket = connectTls({ host: '127.0.0.1', port: Number(new URL(options.origin).port),
    ...options.tls, servername: options.serverName })
  const released = closed(socket)
  await new Promise<void>((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject) })
  return { socket, released }
}

it('rejects excessive header bytes on a real TLS connection and releases the accepted socket', async () => {
  const { service, options, client } = await fixture({ maxHeaderBytes: 512 })
  const { socket, released } = await tlsSocket(options)
  socket.write(`POST /ah-control/v1/rpc HTTP/1.1\r\nHost: localhost\r\nX-Probe: ${'x'.repeat(1024)}\r\n\r\n`)
  expect(await released).toMatch(/^HTTP\/1\.1 431 /)
  expect((await client.request('host.status', {})).report.hostKey).toBe(service.ready.hostKey)
  await client.dispose(); await service.dispose()
  expect(service.status).toBe('closed')
})

it('expires incomplete request headers using the native header budget without entering body handling', async () => {
  const { service, options, client } = await fixture({ headersTimeoutMs: 100, requestReadTimeoutMs: 100 })
  const { socket, released } = await tlsSocket(options)
  socket.write('POST /ah-control/v1/rpc HTTP/1.1\r\nHost: localhost\r\nX-Probe: ')
  expect(await released).toMatch(/^HTTP\/1\.1 408 /)
  expect((await client.request('host.status', {})).report.hostKey).toBe(service.ready.hostKey)
  await client.dispose(); await service.dispose()
  expect(service.status).toBe('closed')
})

it('expires an incomplete TLS handshake and leaves the listener available for an authenticated request', async () => {
  const { service, client } = await fixture({ tlsHandshakeTimeoutMs: 100 })
  const socket = connectTcp(service.ready.listen.port, '127.0.0.1'), released = closed(socket)
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  socket.write(Buffer.from([0x16, 0x03, 0x03, 0x00, 0x80]))
  expect(await released).toBe('')
  expect((await client.request('host.status', {})).report.hostKey).toBe(service.ready.hostKey)
  await client.dispose(); await service.dispose()
  expect(service.status).toBe('closed')
})

it('rejects a second connection at the native connection budget and reuses the released slot', async () => {
  const { service, options, client } = await fixture({ maxConnections: 1 })
  const first = await tlsSocket(options)
  const overflow = connectTls({ host: '127.0.0.1', port: service.ready.listen.port,
    ...options.tls, servername: options.serverName })
  let established = false
  overflow.once('secureConnect', () => { established = true })
  expect(await closed(overflow)).toBe('')
  expect(established).toBe(false)
  first.socket.write('GET /ah-control/v1/rpc HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
  expect(await first.released).toMatch(/^HTTP\/1\.1 400 /)
  expect((await client.request('host.status', {})).report.hostKey).toBe(service.ready.hostKey)
  await client.dispose(); await service.dispose()
  expect(service.status).toBe('closed')
})

it('bounds a small response write when its real ServerResponse socket cannot complete a write', async () => {
  let writes = 0
  const socket = new Socket({ readable: true, writable: true })
  // Hold the actual socket write callback; a small response cannot finish until that callback runs.
  socket._write = (_chunk, _encoding, _callback) => { writes++ }
  socket._writev = (_chunks, _callback) => { writes++ }
  const response = new ServerResponse(new IncomingMessage(socket))
  response.assignSocket(socket)
  await expect(writeResponse(response, 200, Buffer.from('{"ok":true}'), 25)).rejects.toThrow('Control response write expired')
  expect(writes).toBe(1)
  expect(response.destroyed).toBe(true)
  expect(socket.destroyed).toBe(true)
  expect(response.listenerCount('finish')).toBe(0)
  expect(response.listenerCount('error')).toBe(0)
})
