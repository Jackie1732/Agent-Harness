import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createHarnessClient } from '../dist/client/index.js'

// TLS files belong to this local script; business parameters never contain server paths.
const [origin, serverName, caPath, certPath, keyPath, agentKey = 'writer'] = process.argv.slice(2)
if ([origin, serverName, caPath, certPath, keyPath].some(value => value === undefined)) throw new Error('Provide origin, certificate DNS name and CA/client cert/key files')
const [ca, cert, key] = await Promise.all([caPath, certPath, keyPath].map(path => readFile(path)))
const client = createHarnessClient({ origin, serverName, tls: { ca, cert, key }, limits: { maxRequestBytes: 1048576,
  maxResponseBytes: 2097152, maxJsonDepth: 64, maxJsonNodes: 100000, connectTimeoutMs: 5000, requestTimeoutMs: 60000, maxConnections: 4 } })
try {
  const agent = await client.request('agent.get', { agentKey })
  const submissionKey = randomUUID()
  const receipt = await client.request('input.submit', { agentKey, submissionKey, text: 'Summarize the research question and identify needed evidence.' })
  const run = await client.request('host.run', { expectedInstanceId: agent.instanceId })
  const input = await client.request('input.get', { agentKey, inputEventId: receipt.inputEventId })
  const root = input.rootId === null ? null : await client.request('root.get', { agentKey, rootId: input.rootId })
  process.stdout.write(`${JSON.stringify({ submissionKey, receipt, stoppedBy: run.report.stoppedBy, root })}\n`)
} finally { await client.dispose() }
