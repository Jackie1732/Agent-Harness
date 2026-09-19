import { Agent, createServer, request } from 'node:https'
import type { RequestOptions, ServerOptions } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TLSSocket } from 'node:tls'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonValue } from '../foundation/json.js'
import { formatSessionAddress, parseSessionAddress, parseSessionEventId } from '../session/ids.js'
import type { SessionAddress, SessionEventId } from '../session/ids.js'
import type { SessionDirectory } from './directory.js'
import { resolveDirectoryReceiver } from './directory.js'
import { decodeMessageEnvelope } from './envelope.js'
import { CommunicationError } from './errors.js'
import { parseMessageId } from './ids.js'
import type { MessageTransport } from './transport.js'
import type { MessageDeliveryOutcome, MessageDeliveryReceipt, MessageEnvelope, MessageRejectionCode, MessageRetryCode } from './types.js'

const deliveryPath = '/atomic-harness/v1/messages/deliver'

export interface HttpsMessageLimits {
  readonly maxHeaderBytes: number
  readonly maxBodyBytes: number
  readonly maxResponseBytes: number
  readonly maxConnections: number
  readonly maxInFlightRequests: number
  readonly handshakeTimeoutMs: number
  readonly headersTimeoutMs: number
  readonly bodyTimeoutMs: number
  readonly requestTimeoutMs: number
  readonly idleTimeoutMs: number
}

export interface HttpsPeerAuthorization {
  readonly hostKey: string
  readonly fingerprint256: string
  readonly senders: ReadonlySet<SessionAddress>
}

export interface HttpsMessageServerOptions {
  readonly directory: SessionDirectory
  readonly host: string
  readonly port: number
  readonly tls: Pick<ServerOptions, 'ca' | 'cert' | 'key'>
  readonly peers: readonly HttpsPeerAuthorization[]
  readonly limits: HttpsMessageLimits
}

export interface HttpsMessageServer {
  readonly origin: string
  dispose(): Promise<void>
}

export interface HttpsMessageClientOptions {
  readonly origin: string
  readonly serverName: string
  readonly hostKey: string
  readonly tls: Pick<RequestOptions, 'ca' | 'cert' | 'key'>
  readonly limits: HttpsMessageLimits
}

const retryCodes: readonly MessageRetryCode[] = ['recipient-offline', 'recipient-ending', 'recipient-backpressure',
  'attempt-interrupted', 'receiver-outcome-unknown', 'transport-outcome-unknown']
const rejectionCodes: readonly MessageRejectionCode[] = ['recipient-unknown', 'recipient-ended', 'receive-forbidden',
  'message-unsupported', 'payload-invalid', 'message-id-conflict']

function validateLimits(limits: HttpsMessageLimits): HttpsMessageLimits {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new CommunicationError('MESSAGE_CONFIG_INVALID', 'HTTPS limit is invalid', { details: { key, value } })
  }
  return Object.freeze({ ...limits })
}

async function readBounded(stream: IncomingMessage, maximum: number, timeoutMs: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  const timeout = setTimeout(() => stream.destroy(new Error('body-timeout')), timeoutMs)
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      size += bytes.byteLength
      if (size > maximum) throw new CommunicationError('MESSAGE_ENVELOPE_INVALID', 'HTTPS body exceeds configured limit')
      chunks.push(bytes)
    }
    return Buffer.concat(chunks, size)
  } finally { clearTimeout(timeout) }
}

function json(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value as JsonValue
  if (Array.isArray(value)) return value.map(json)
  if (typeof value !== 'object') throw new CommunicationError('MESSAGE_ENVELOPE_INVALID', 'HTTPS JSON value is invalid')
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item)]))
}

function sendJson(response: ServerResponse, status: number, value: JsonValue): void {
  const body = Buffer.from(canonicalJsonBytes(value))
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': body.byteLength })
  response.end(body)
}

function peerIdentity(requestMessage: IncomingMessage): { readonly fingerprint256: string; readonly authorized: boolean } {
  const socket = requestMessage.socket as TLSSocket
  return { fingerprint256: socket.getPeerCertificate().fingerprint256 ?? '', authorized: socket.authorized }
}

async function receive(
  options: HttpsMessageServerOptions,
  limits: HttpsMessageLimits,
  incoming: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  if (incoming.method !== 'POST' || incoming.url !== deliveryPath) { sendJson(response, 404, { kind: 'protocol-error' }); return }
  if (incoming.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') { sendJson(response, 415, { kind: 'protocol-error' }); return }
  const peer = peerIdentity(incoming)
  const hostKey = incoming.headers['x-atomic-host-key']
  const authorization = typeof hostKey === 'string'
    ? options.peers.find(item => item.hostKey === hostKey && item.fingerprint256 === peer.fingerprint256)
    : undefined
  if (!peer.authorized || authorization === undefined) { sendJson(response, 403, { kind: 'authentication-failed' }); return }
  let envelope: MessageEnvelope
  try { envelope = decodeMessageEnvelope(json(JSON.parse((await readBounded(incoming, limits.maxBodyBytes, limits.bodyTimeoutMs)).toString('utf8')))) }
  catch { sendJson(response, 400, { kind: 'protocol-error' }); return }
  if (!authorization.senders.has(envelope.sender)) { sendJson(response, 403, { kind: 'authentication-failed' }); return }
  const target = resolveDirectoryReceiver(options.directory, envelope.recipient)
  if (target.status.kind === 'unknown') { sendJson(response, 200, { kind: 'rejected', code: 'recipient-unknown' }); return }
  if (target.status.kind === 'known-offline') { sendJson(response, 200, { kind: 'retry', code: 'recipient-offline' }); return }
  if (target.status.kind === 'ended') { sendJson(response, 200, { kind: 'rejected', code: 'recipient-ended' }); return }
  if (target.receiver === undefined) { sendJson(response, 503, { kind: 'protocol-error' }); return }
  const controller = new AbortController()
  incoming.once('aborted', () => controller.abort())
  try {
    const outcome = await target.receiver.acceptDelivery(envelope, envelope.sender, controller.signal)
    sendJson(response, 200, outcome)
  } catch (cause) {
    if (cause instanceof CommunicationError && cause.code === 'MESSAGE_INBOX_COMMIT_UNKNOWN') {
      sendJson(response, 200, { kind: 'retry', code: 'receiver-outcome-unknown' })
    } else sendJson(response, 503, { kind: 'protocol-error' })
  }
}

/** Bind a fixed-path mutual-TLS receiver without exposing Directory receiver handles. */
export async function createHttpsMessageServer(options: HttpsMessageServerOptions): Promise<HttpsMessageServer> {
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
    if (!active || inFlight >= limits.maxInFlightRequests) { sendJson(response, 503, { kind: 'backpressure' }); return }
    inFlight += 1
    const task = receive(options, limits, incoming, response).finally(() => { inFlight -= 1; tasks.delete(task) })
    tasks.add(task)
    void task.catch(() => { if (!response.headersSent) sendJson(response, 503, { kind: 'protocol-error' }); else response.destroy() })
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

function receipt(value: unknown): MessageDeliveryReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('receipt')
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== 3 || typeof input.messageId !== 'string' || typeof input.recipient !== 'string' || typeof input.inboxEventId !== 'string') throw new Error('receipt')
  const messageId = parseMessageId(input.messageId)
  const recipient = formatSessionAddress(parseSessionAddress(input.recipient))
  parseSessionEventId(input.inboxEventId)
  return Object.freeze({ messageId, recipient, inboxEventId: input.inboxEventId as SessionEventId })
}

function outcome(value: unknown): MessageDeliveryOutcome {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('outcome')
  const input = value as Record<string, unknown>
  if (input.kind === 'accepted' && Object.keys(input).length === 2) return Object.freeze({ kind: 'accepted', receipt: receipt(input.receipt) })
  if (input.kind === 'retry' && Object.keys(input).length === 2 && retryCodes.includes(input.code as MessageRetryCode)) {
    return Object.freeze({ kind: 'retry', code: input.code as MessageRetryCode })
  }
  if (input.kind === 'rejected' && Object.keys(input).length === 2 && rejectionCodes.includes(input.code as MessageRejectionCode)) {
    return Object.freeze({ kind: 'rejected', code: input.code as MessageRejectionCode })
  }
  throw new Error('outcome')
}

function authenticationFailure(error: unknown): boolean {
  const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  return ['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code) || code.startsWith('ERR_TLS_CERT_')
}

/** Create one fixed-origin mutual-TLS client transport. Source attempts are authenticated by a routed parent. */
export function createHttpsMessageClientTransport(options: HttpsMessageClientOptions): MessageTransport {
  const limits = validateLimits(options.limits)
  const origin = new URL(options.origin)
  if (origin.protocol !== 'https:' || origin.username !== '' || origin.password !== '' || origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') {
    throw new CommunicationError('MESSAGE_CONFIG_INVALID', 'HTTPS route origin is invalid')
  }
  const agent = new Agent({ ...options.tls, keepAlive: true, maxSockets: limits.maxConnections, servername: options.serverName,
    rejectUnauthorized: true, timeout: limits.idleTimeoutMs })
  let active = true
  return Object.freeze({
    async deliver(envelope: MessageEnvelope, delivery: { readonly signal: AbortSignal }): Promise<MessageDeliveryOutcome> {
      if (!active) return Object.freeze({ kind: 'retry', code: 'transport-outcome-unknown' })
      const body = Buffer.from(canonicalJsonBytes(decodeMessageEnvelope(envelope)))
      if (body.byteLength > limits.maxBodyBytes) throw new CommunicationError('MESSAGE_ENVELOPE_INVALID', 'HTTPS body exceeds configured limit')
      try {
        return await new Promise<MessageDeliveryOutcome>((resolve, reject) => {
          const controller = new AbortController()
          const abort = (): void => controller.abort()
          delivery.signal.addEventListener('abort', abort, { once: true })
          const timer = setTimeout(() => controller.abort(), limits.requestTimeoutMs)
          const target = new URL(deliveryPath, origin)
          const outgoing = request(target, { method: 'POST', agent, signal: controller.signal, servername: options.serverName,
            maxHeaderSize: limits.maxHeaderBytes, headers: { 'content-type': 'application/json', 'content-length': body.byteLength,
              'x-atomic-host-key': options.hostKey } }, async response => {
            try {
              const responseBody = await readBounded(response, limits.maxResponseBytes, limits.bodyTimeoutMs)
              if (response.statusCode === 401 || response.statusCode === 403) {
                reject(new CommunicationError('MESSAGE_TRANSPORT_SOURCE_INVALID', 'remote Host rejected transport identity'))
              } else if (response.statusCode !== 200 || response.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
                resolve(Object.freeze({ kind: 'retry', code: 'transport-outcome-unknown' }))
              } else {
                try { resolve(outcome(JSON.parse(responseBody.toString('utf8')))) }
                catch { resolve(Object.freeze({ kind: 'retry', code: 'transport-outcome-unknown' })) }
              }
            } catch { resolve(Object.freeze({ kind: 'retry', code: 'transport-outcome-unknown' })) }
          })
          const cleanup = (): void => { clearTimeout(timer); delivery.signal.removeEventListener('abort', abort) }
          outgoing.once('close', cleanup)
          outgoing.once('error', reject)
          outgoing.end(body)
        })
      } catch (cause) {
        if (delivery.signal.aborted) return Object.freeze({ kind: 'retry', code: 'attempt-interrupted' })
        if (cause instanceof CommunicationError || authenticationFailure(cause)) {
          throw cause instanceof CommunicationError ? cause : new CommunicationError('MESSAGE_TRANSPORT_SOURCE_INVALID', 'remote TLS authentication failed')
        }
        return Object.freeze({ kind: 'retry', code: 'transport-outcome-unknown' })
      }
    },
    async dispose() { active = false; agent.destroy() },
  })
}
