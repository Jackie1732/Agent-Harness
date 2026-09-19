import { createServer } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TLSSocket } from 'node:tls'
import type { JsonValue, JsonObject } from '../foundation/json.js'
import { resolveDirectoryReceiver } from './directory.js'
import { decodeMessageEnvelope } from './envelope.js'
import { CommunicationError } from './errors.js'
import type { MessageEnvelope } from './types.js'
import { deliveryPath, readBounded, readJson, sendJson, sendError, validateLimits } from './https-protocol.js'
import type { HttpsMessageLimits, HttpsMessageServer, HttpsMessageServerOptions } from './https-protocol.js'

function peerIdentity(requestMessage: IncomingMessage): { readonly fingerprint256: string; readonly authorized: boolean } {
  const socket = requestMessage.socket as TLSSocket
  return { fingerprint256: (socket.getPeerCertificate().fingerprint256 ?? '').replaceAll(':', '').toLowerCase(), authorized: socket.authorized }
}

async function receive(
  options: HttpsMessageServerOptions,
  limits: HttpsMessageLimits,
  incoming: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const respond = (status: number, value: JsonValue) => sendJson(response, status, value, limits.maxResponseBytes)
  const reject = (status: number, code: string) => sendError(response, status, code, limits.maxResponseBytes)
  if (incoming.method !== 'POST' || incoming.url !== deliveryPath) { reject(404, 'invalid-request'); return }
  if (incoming.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') { reject(415, 'invalid-request'); return }
  if (incoming.headers['content-encoding'] !== undefined) { reject(400, 'invalid-request'); return }
  if (incoming.headers['content-length'] !== undefined && Number(incoming.headers['content-length']) > limits.maxBodyBytes) {
    response.setHeader('connection', 'close'); reject(413, 'body-too-large'); return
  }
  const peer = peerIdentity(incoming)
  const hostKey = incoming.headers['x-atomic-host-key']
  const authorization = typeof hostKey === 'string'
    ? options.peers.find(item => item.hostKey === hostKey && item.fingerprint256 === peer.fingerprint256)
    : undefined
  if (!peer.authorized || authorization === undefined) { reject(403, 'forbidden-sender'); return }
  let envelope: MessageEnvelope
  try {
    const request = readJson(await readBounded(incoming, limits.maxBodyBytes, limits.bodyTimeoutMs), limits.maxBodyBytes) as JsonObject
    if (request === null || typeof request !== 'object' || Array.isArray(request) || request.protocolVersion !== 1 || Object.keys(request).length !== 2) throw new Error('protocol')
    envelope = decodeMessageEnvelope(request.envelope!)
  }
  catch { reject(400, 'invalid-request'); return }
  if (!authorization.senders.has(envelope.sender)) { reject(403, 'forbidden-sender'); return }
  const target = resolveDirectoryReceiver(options.directory, envelope.recipient)
  if (target.status.kind === 'unknown') { reject(409, 'recipient-host-mismatch'); return }
  if (target.status.kind === 'known-offline') { respond(200, { kind: 'retry', code: 'recipient-offline' }); return }
  if (target.status.kind === 'ended') { respond(200, { kind: 'rejected', code: 'recipient-ended' }); return }
  if (target.receiver === undefined) { respond(503, { kind: 'retry', code: 'recipient-offline' }); return }
  const controller = new AbortController()
  incoming.once('aborted', () => controller.abort())
  try {
    const outcome = await target.receiver.acceptDelivery(envelope, envelope.sender, controller.signal)
    if (outcome.kind === 'accepted') options.onAccepted?.()
    respond(200, outcome)
  } catch (cause) {
    if (cause instanceof CommunicationError && cause.code === 'MESSAGE_INBOX_COMMIT_UNKNOWN') {
      respond(200, { kind: 'retry', code: 'receiver-outcome-unknown' })
    } else respond(503, { kind: 'retry', code: 'receiver-outcome-unknown' })
  }
}

/** Bind a fixed-path mutual-TLS receiver without exposing Directory receiver handles. */
export async function createHttpsMessageServer(options: HttpsMessageServerOptions): Promise<HttpsMessageServer> {
  options = { ...options, peers: options.peers.map(peer => ({ ...peer,
    fingerprint256: peer.fingerprint256.replaceAll(':', '').toLowerCase(), senders: new Set(peer.senders) })) }
  const limits = validateLimits(options.limits)
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) throw new CommunicationError('MESSAGE_CONFIG_INVALID', 'HTTPS port is invalid')
  const peers = new Set<string>()
  for (const peer of options.peers) {
    const key = `${peer.hostKey}\u0000${peer.fingerprint256}`
    if (peers.has(key)) throw new CommunicationError('MESSAGE_CONFIG_INVALID', 'duplicate HTTPS peer identity')
    peers.add(key)
  }
  let inFlight = 0
  let active = true
  const tasks = new Set<Promise<void>>()
  const server = createServer({ ...options.tls, requestCert: true, rejectUnauthorized: true,
    maxHeaderSize: limits.maxHeaderBytes, handshakeTimeout: limits.handshakeTimeoutMs }, (incoming, response) => {
    if (!active || inFlight >= limits.maxInFlightRequests) { sendJson(response, 503, { kind: 'retry', code: 'recipient-backpressure' }, limits.maxResponseBytes); return }
    inFlight += 1
    const task = receive(options, limits, incoming, response).finally(() => { inFlight -= 1; tasks.delete(task) })
    tasks.add(task)
    void task.catch(() => { if (!response.headersSent) sendJson(response, 503, { kind: 'retry', code: 'receiver-outcome-unknown' }, limits.maxResponseBytes); else response.destroy() })
  })
  server.maxConnections = limits.maxConnections
  server.headersTimeout = limits.headersTimeoutMs
  server.requestTimeout = limits.requestTimeoutMs
  server.keepAliveTimeout = limits.idleTimeoutMs
  await new Promise<void>((resolve, reject) => {
    const failed = (error: Error): void => { server.off('listening', listening); reject(error) }
    const listening = (): void => { server.off('error', failed); resolve() }
    server.once('error', failed); server.once('listening', listening); server.listen(options.port, options.host)
  })
  const address = server.address() as AddressInfo
  let disposeTask: Promise<void> | undefined
  return Object.freeze({
    origin: `https://${options.host.includes(':') ? `[${options.host}]` : options.host}:${address.port}`,
    stopAdmission() { active = false },
    dispose() {
      disposeTask ??= (async () => {
        active = false
        await new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
        await Promise.allSettled([...tasks])
      })()
      return disposeTask
    },
  })
}
