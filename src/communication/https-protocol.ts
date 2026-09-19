import type { RequestOptions, ServerOptions } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonValue } from '../foundation/json.js'
import { parseBoundedJson } from '../schema/bounded-json.js'
import { formatSessionAddress, parseSessionAddress, parseSessionEventId } from '../session/ids.js'
import type { SessionAddress, SessionEventId } from '../session/ids.js'
import type { SessionDirectory } from './directory.js'
import { CommunicationError } from './errors.js'
import { parseMessageId } from './ids.js'
import type { MessageDeliveryOutcome, MessageDeliveryReceipt, MessageRejectionCode, MessageRetryCode } from './types.js'

export const deliveryPath = '/ah-message/v1/deliver'

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
  /** Bounded synchronous scheduling hint after acceptance; must not execute Agent work or throw. */
  readonly onAccepted?: () => void
}

export interface HttpsMessageServer {
  readonly origin: string
  stopAdmission(): void
  dispose(): Promise<void>
}

export interface HttpsMessageClientOptions {
  readonly directory: SessionDirectory
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

export function validateLimits(limits: HttpsMessageLimits): HttpsMessageLimits {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new CommunicationError('MESSAGE_CONFIG_INVALID', 'HTTPS limit is invalid', { details: { key, value } })
    if (key.endsWith('Ms') && value > 2_147_483_647) throw new CommunicationError('MESSAGE_CONFIG_INVALID', 'HTTPS timeout exceeds Node timer range', { details: { key } })
  }
  return Object.freeze({ ...limits })
}

export async function readBounded(stream: IncomingMessage, maximum: number, timeoutMs: number): Promise<Buffer> {
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

export function readJson(bytes: Buffer, maximum: number): JsonValue {
  return parseBoundedJson(new TextDecoder('utf-8', { fatal: true }).decode(bytes), { maxBytes: maximum, maxDepth: 32, maxNodes: 10000 })
}

export function sendJson(response: ServerResponse, status: number, value: JsonValue, maximum: number): void {
  sendProtocol(response, status, { outcome: value }, maximum)
}

export function sendError(response: ServerResponse, status: number, code: string, maximum: number): void {
  sendProtocol(response, status, { error: { code } }, maximum)
}

function sendProtocol(response: ServerResponse, status: number, payload: Record<string, JsonValue>, maximum: number): void {
  const body = Buffer.from(canonicalJsonBytes({ protocolVersion: 1, ...payload }))
  if (body.byteLength > maximum) { response.writeHead(503); response.end(); return }
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': body.byteLength })
  response.end(body)
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

export function outcome(value: unknown): MessageDeliveryOutcome {
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
