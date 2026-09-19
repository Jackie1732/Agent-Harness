import assert from 'node:assert/strict'
import { X509Certificate } from 'node:crypto'
import { fork } from 'node:child_process'
import { readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  decodeHostConfig, FileSessionBackend, hostRuntimeEventCatalog, initializeHost, parseSessionId,
  projectCommunicationFacts, resolveHostConfig, SessionRepository,
} from '../dist/index.js'

const here = fileURLToPath(new URL('.', import.meta.url))
const certRoot = join(here, 'host', 'certs')
const childPath = join(here, 'fixtures', 'host-process-child.mjs')
const writerId = '70000000-0000-4000-8000-000000000201'
const reviewerId = '70000000-0000-4000-8000-000000000202'
const channelId = '71000000-0000-4000-8000-000000000201'

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
  return port
}

function localMember(agentKey, sessionId, peerKey, peerId, providerId) {
  return {
    kind: 'local', agentKey, sessionId, mode: 'create', enabled: true,
    profile: {
      profileKey: `${agentKey}-generation`, purpose: 'generation', previousEventId: null,
      sections: [{ name: 'rules', slot: 'rules', ordinal: 0, text: 'Answer the task.', originLabel: 'built-smoke' }],
      toolNames: [], rendererVersion: 'context-neutral/v2', historyScope: 'local-only',
      tokenAccounting: { mode: 'estimate-accepted', algorithm: 'neutral-json-utf8-estimate/v1', bytesPerEstimatedToken: 4, fixedOverheadEstimate: 8 },
      budget: { contextWindowTokens: 8192, outputReserveTokens: 256, safetyMarginTokens: 32,
        maxRequestBytes: 262144, maxAssemblyBytes: 524288, maxSourceEvents: 1000, maxSourceBytes: 1048576,
        maxUnits: 1000, maxProvenanceEntries: 2000, maxMemoryCandidates: 0, maxMemoryEstimatedTokens: 0,
        maxJsonDepth: 32, maxJsonNodes: 10000, minSavingsBytes: 0 },
    },
    spec: {
      protocolVersion: 1, label: agentKey, responsibility: 'Process one remote message.', nonGoals: [],
      target: { model: 'fixed-model', maxOutputTokens: 256 }, toolNames: [], nativeActions: ['agent_send_message'],
      peers: [{ key: peerKey, memberKey: peerKey, channelKey: 'shared' }],
      messages: [{ type: 'test/note', payloadVersion: 1, requiresReply: false }],
      context: { history: { mode: 'none', maxRoots: 0 }, memory: { required: [], query: { requiredTags: [], queryTags: [], topK: 0 } }, compactions: [] },
      budget: { models: 8, steps: 8, tools: 0, messages: 1, waits: 2, outputTokens: 2048 },
      rootDurationMs: 60000, maxDirectSendCommandsPerSession: 2,
      limits: { maxTurnsPerRun: 4, maxManagementPerRun: 16, maxDispatchRunsPerRun: 1, maxJournalConflicts: 4,
        maxReassemblies: 2, maxPendingInputs: 16, maxPendingWaits: 4, maxLanes: 8, maxInputBytes: 4096,
        maxActionsPerStep: 4, maxActionBytes: 4096, maxResultBytes: 16384, maxReportEntries: 100, maxWaitMs: 60000 },
      errorFeedback: 'new-step', usagePolicy: 'observe-only', businessRefusalHandled: false,
    },
    model: { kind: 'scripted-fixed', providerId, text: `${agentKey} answer`, maxConcurrentExchanges: 1,
      streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 },
      runnerLimits: { maxInputBytes: 1048576, maxNormalizedResultBytes: 65536, maxOutputBlocks: 32, maxToolCalls: 0, maxJournalConflicts: 4 } },
    tools: { kind: 'none' },
  }
}

function config({ hostKey, root, port, local, remote, remoteHost, remotePort, clientCert, clientKey, peerFingerprint }) {
  return {
    schemaVersion: 1, hostKey,
    storage: { root, maxRecordBytes: 1024 * 1024, maxLineageDepth: 4 },
    members: [local, { kind: 'remote', agentKey: remote.agentKey, sessionId: remote.sessionId, ownerHost: remoteHost }],
    messages: [{ type: 'test/note', payloadVersion: 1, schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }],
    channels: [{ channelKey: 'shared', channelId }],
    routes: [{ memberKey: local.agentKey, ownerHost: hostKey, origin: null, serverName: null },
      { memberKey: remote.agentKey, ownerHost: remoteHost, origin: `https://127.0.0.1:${remotePort}`, serverName: 'localhost' }],
    https: { kind: 'mutual-tls', listen: { host: '127.0.0.1', port }, caFile: join(certRoot, 'ca.pem'),
      serverCertFile: join(certRoot, 'server.pem'), serverKeyFile: join(certRoot, 'server-key.pem'),
      clientCertFile: join(certRoot, clientCert), clientKeyFile: join(certRoot, clientKey),
      peers: [{ hostKey: remoteHost, fingerprint256: peerFingerprint, sessionIds: [remote.sessionId] }],
      limits: { maxHeaderBytes: 8192, maxBodyBytes: 65536, maxResponseBytes: 8192, maxConnections: 8,
        maxInFlightRequests: 8, handshakeTimeoutMs: 5000, headersTimeoutMs: 5000, bodyTimeoutMs: 5000,
        requestTimeoutMs: 5000, idleTimeoutMs: 1000 } },
    communication: { maxMessageBytes: 4096, maxPendingOutbox: 16, maxPendingInbox: 16,
      maxDeliveryAttempts: 3, maxAttemptsPerRun: 3, maxSendJournalConflicts: 4 },
    scheduling: { scanIntervalMs: 10, maxSlotsPerScan: 1, maxBatchesPerRun: 8,
      maxNoProgressBatches: 2, retryIntervalMs: 100, maxReportEntries: 100 },
    cli: { maxLineBytes: 65536, maxQueuedCommands: 8, maxPendingControls: 8,
      maxOutputBytes: 1048576, outputDrainTimeoutMs: 1000 },
  }
}

function waitMessage(child, requestId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => done(new Error(`child timeout: ${requestId}`)), 15_000)
    const onMessage = message => {
      if (requestId === 'ready' ? message.kind === 'ready' : message.requestId === requestId) {
        if (message.kind === 'failure') done(new Error(message.code)); else done(undefined, message.value)
      }
    }
    const onExit = code => done(new Error(`child exited before ${requestId}: ${code}`))
    function done(error, value) {
      clearTimeout(timer); child.off('message', onMessage); child.off('exit', onExit)
      if (error === undefined) resolve(value); else reject(error)
    }
    child.on('message', onMessage); child.on('exit', onExit)
  })
}

const base = await mkdtemp(join(tmpdir(), 'atomic-host-process-'))
const [portA, portB] = await Promise.all([freePort(), freePort()])
const [clientA, clientB] = await Promise.all([readFile(join(certRoot, 'client.pem')), readFile(join(certRoot, 'client-b.pem'))])
const localA = localMember('writer', writerId, 'reviewer', reviewerId, 'writer-provider')
const localB = localMember('reviewer', reviewerId, 'writer', writerId, 'reviewer-provider')
const rawA = config({ hostKey: 'host-a', root: join(base, 'a'), port: portA, local: localA,
  remote: { agentKey: 'reviewer', sessionId: reviewerId }, remoteHost: 'host-b', remotePort: portB,
  clientCert: 'client.pem', clientKey: 'client-key.pem', peerFingerprint: new X509Certificate(clientB).fingerprint256 })
const rawB = config({ hostKey: 'host-b', root: join(base, 'b'), port: portB, local: localB,
  remote: { agentKey: 'writer', sessionId: writerId }, remoteHost: 'host-a', remotePort: portA,
  clientCert: 'client-b.pem', clientKey: 'client-b-key.pem', peerFingerprint: new X509Certificate(clientA).fingerprint256 })
const specA = resolveHostConfig(decodeHostConfig(rawA, base))
const specB = resolveHostConfig(decodeHostConfig(rawB, base))
await initializeHost(specA); await initializeHost(specB)
const pathA = join(base, 'a.json'); const pathB = join(base, 'b.json')
await writeFile(pathA, JSON.stringify(rawA)); await writeFile(pathB, JSON.stringify(rawB))
const childB = fork(childPath, [pathB], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
const childA = fork(childPath, [pathA], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
try {
  await Promise.all([waitMessage(childA, 'ready'), waitMessage(childB, 'ready')])
  const sent = waitMessage(childA, 'send')
  childA.send({ kind: 'send', requestId: 'send', agentKey: 'writer', command: {
    kind: 'send', peerKey: 'reviewer', type: 'test/note', payloadVersion: 1, payloadJson: '{"text":"cross-process"}',
  } })
  assert.equal((await sent).deliveryAttempts, 1)
  const received = waitMessage(childB, 'run'); childB.send({ kind: 'run', requestId: 'run' })
  assert.equal((await received).members[0].agent.final.text, 'reviewer answer')
  const stopA = waitMessage(childA, 'stop-a'); childA.send({ kind: 'shutdown', requestId: 'stop-a' })
  const stopB = waitMessage(childB, 'stop-b'); childB.send({ kind: 'shutdown', requestId: 'stop-b' })
  await Promise.all([stopA, stopB])
  const backend = new FileSessionBackend({ root: rawB.storage.root, maxRecordBytes: rawB.storage.maxRecordBytes })
  const repository = new SessionRepository({ backend, catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
  const session = await repository.open(parseSessionId(reviewerId))
  assert.equal(projectCommunicationFacts(session.snapshot()).inbox.length, 1)
  await repository.dispose()
} finally {
  for (const child of [childA, childB]) if (child.connected) child.kill()
}
