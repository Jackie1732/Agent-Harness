import { X509Certificate } from 'node:crypto'
import { readFile, mkdtemp } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeHostConfig, formatSessionAddress, initializeHost, openHost, parseSessionId, resolveHostConfig } from '../../src/index.js'
import type { AtomicHost, JsonObject } from '../../src/index.js'
import { hostSessionId, twoMemberHostConfig } from './fixtures.js'

const certRoot = fileURLToPath(new URL('./certs/', import.meta.url))
const reviewerSessionId = '70000000-0000-4000-8000-000000000102'
const hosts: AtomicHost[] = []
afterEach(async () => {
  const results = await Promise.allSettled(hosts.splice(0).reverse().map(host => host.shutdown()))
  const failed = results.find(result => result.status === 'rejected')
  if (failed?.status === 'rejected') throw failed.reason
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
  return port
}

describe('remote Atomic Hosts', () => {
  it('routes over mutual TLS and blocks an authenticated route after peer authorization changes', async () => {
    const [portA, portB] = await Promise.all([freePort(), freePort()])
    const [clientA, clientB] = await Promise.all([readFile(`${certRoot}client.pem`), readFile(`${certRoot}client-b.pem`)])
    const rootA = await mkdtemp(join(tmpdir(), 'atomic-host-a-'))
    const rootB = await mkdtemp(join(tmpdir(), 'atomic-host-b-'))
    const baseA = twoMemberHostConfig(rootA)
    const baseB = twoMemberHostConfig(rootB)
    const membersA = baseA.members as readonly JsonObject[]
    const membersB = baseB.members as readonly JsonObject[]
    const tls = (port: number, clientCert: string, clientKey: string, peerHost: string, fingerprint256: string, sender: string): JsonObject => ({
      kind: 'mutual-tls', listen: { host: '127.0.0.1', port }, caFile: `${certRoot}ca.pem`,
      serverCertFile: `${certRoot}server.pem`, serverKeyFile: `${certRoot}server-key.pem`,
      clientCertFile: `${certRoot}${clientCert}`, clientKeyFile: `${certRoot}${clientKey}`,
      peers: [{ hostKey: peerHost, fingerprint256, sessionIds: [sender] }],
      limits: { maxHeaderBytes: 8192, maxBodyBytes: 65536, maxResponseBytes: 8192, maxConnections: 8,
        maxInFlightRequests: 8, handshakeTimeoutMs: 5000, headersTimeoutMs: 5000, bodyTimeoutMs: 5000,
        requestTimeoutMs: 5000, idleTimeoutMs: 1000 },
    })
    const configA: JsonObject = { ...baseA, hostKey: 'host-a',
      members: [membersA[0]!, { kind: 'remote', agentKey: 'reviewer', sessionId: reviewerSessionId, ownerHost: 'host-b' }],
      routes: [{ memberKey: 'writer', ownerHost: 'host-a', origin: null, serverName: null },
        { memberKey: 'reviewer', ownerHost: 'host-b', origin: `https://127.0.0.1:${portB}`, serverName: 'localhost' }],
      https: tls(portA, 'client.pem', 'client-key.pem', 'host-b', new X509Certificate(clientB).fingerprint256, reviewerSessionId) }
    const configB: JsonObject = { ...baseB, hostKey: 'host-b',
      members: [{ kind: 'remote', agentKey: 'writer', sessionId: hostSessionId, ownerHost: 'host-a' }, membersB[1]!],
      routes: [{ memberKey: 'writer', ownerHost: 'host-a', origin: `https://127.0.0.1:${portA}`, serverName: 'localhost' },
        { memberKey: 'reviewer', ownerHost: 'host-b', origin: null, serverName: null }],
      https: tls(portB, 'client-b.pem', 'client-b-key.pem', 'host-a', new X509Certificate(clientA).fingerprint256, hostSessionId) }
    const specA = resolveHostConfig(decodeHostConfig(configA, rootA))
    const specB = resolveHostConfig(decodeHostConfig(configB, rootB))
    await initializeHost(specA); await initializeHost(specB)
    const hostB = await openHost(specB); hosts.push(hostB)
    const hostA = await openHost(specA); hosts.push(hostA)

    await hostA.sendMessage('writer', { kind: 'send', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1,
      payloadJson: '{"text":"remote review"}' })
    const sent = await hostA.run()
    expect(sent.deliveryAttempts).toBe(1)
    const received = await hostB.run()
    expect(received.members[0]?.agent.counts.roots).toBe(1)
    expect(received.members[0]?.agent.final?.text).toBe('reviewer answer')

    await hostB.shutdown()
    const blockedConfigB: JsonObject = { ...configB,
      https: tls(portB, 'client-b.pem', 'client-b-key.pem', 'different-host',
        new X509Certificate(clientA).fingerprint256, hostSessionId) }
    const blockedHostB = await openHost(resolveHostConfig(decodeHostConfig(blockedConfigB, rootB)))
    hosts.push(blockedHostB)
    await hostA.sendMessage('writer', { kind: 'send', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1,
      payloadJson: '{"text":"must block"}' })
    const blocked = await hostA.run()
    expect(blocked).toMatchObject({ deliveryAttempts: 1,
      blockedRoutes: [formatSessionAddress(parseSessionId(reviewerSessionId))] })
    expect((await hostA.run()).deliveryAttempts).toBe(0)
    expect((await blockedHostB.run()).members[0]?.agent.counts.roots).toBe(1)
  })
})
