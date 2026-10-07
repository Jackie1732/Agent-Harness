import { readFile } from 'node:fs/promises'
import { X509Certificate } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { CONTROL_METHODS } from '../../src/protocol/index.js'
import type { ApiConfig, ApiLimits } from '../../src/api/config.js'
import type { HarnessClientOptions } from '../../src/client/config.js'

export const certificateDirectory = fileURLToPath(new URL('../host/certs/', import.meta.url))
export const apiLimits: ApiLimits = Object.freeze({ maxRequestBytes: 1048576, maxResponseBytes: 2097152, maxJsonDepth: 64, maxJsonNodes: 100000,
  maxHeaderBytes: 8192, maxPageEvents: 100, maxConnections: 16, maxPendingInputs: 4, maxPendingControls: 4, maxObservers: 4, maxPendingShutdowns: 4,
  requestReadTimeoutMs: 3000, responseWriteTimeoutMs: 3000, tlsHandshakeTimeoutMs: 3000, headersTimeoutMs: 3000, keepAliveTimeoutMs: 1000,
  maxWaitMs: 3000, observerScanIntervalMs: 5 })
export async function apiConfig(): Promise<ApiConfig> {
  const certificate = await readFile(`${certificateDirectory}client.pem`)
  return { schemaVersion: 1, listenHost: '127.0.0.1', listenPort: 0,
    tls: { caFile: `${certificateDirectory}ca.pem`, serverCertFile: `${certificateDirectory}server.pem`, serverKeyFile: `${certificateDirectory}server-key.pem` },
    principals: [{ principalKey: 'researcher', certificateFingerprints: [new X509Certificate(certificate).fingerprint256.replaceAll(':', '').toLowerCase()],
      methods: [...CONTROL_METHODS], agentKeys: ['writer'], workflowKeys: [] }], limits: apiLimits }
}
export async function clientOptions(port: number, identity = 'client'): Promise<HarnessClientOptions> {
  const [ca, cert, key] = await Promise.all(['ca.pem', `${identity}.pem`, `${identity}-key.pem`].map(name => readFile(`${certificateDirectory}${name}`)))
  return { origin: `https://127.0.0.1:${port}`, serverName: 'localhost', tls: { ca: ca!, cert: cert!, key: key! },
    limits: { maxRequestBytes: apiLimits.maxRequestBytes, maxResponseBytes: apiLimits.maxResponseBytes, maxJsonDepth: 64, maxJsonNodes: 100000,
      connectTimeoutMs: 3000, requestTimeoutMs: 5000, maxConnections: 4 } }
}
