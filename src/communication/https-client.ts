import { Agent, request } from 'node:https'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonObject } from '../foundation/json.js'
import { resolveDirectoryReceiver } from './directory.js'
import { decodeMessageEnvelope } from './envelope.js'
import { CommunicationError } from './errors.js'
import type { MessageTransport } from './transport.js'
import type { MessageDeliveryOutcome, MessageEnvelope } from './types.js'
import { deliveryPath, outcome, readBounded, readJson, validateLimits } from './https-protocol.js'
import type { HttpsMessageClientOptions } from './https-protocol.js'

function authenticationFailure(error: unknown): boolean {
  const code = error !== null && typeof error === 'object' && 'code' in error ? String(error.code) : ''
  return ['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_NOT_YET_VALID',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(code) || code.startsWith('ERR_TLS_CERT_') || code.startsWith('ERR_SSL_')
}

/** Create one fixed-origin mutual-TLS client that verifies the active local sender attempt. */
export function createHttpsMessageClientTransport(options: HttpsMessageClientOptions): MessageTransport {
  const limits = validateLimits(options.limits)
  const origin = new URL(options.origin)
  if (origin.protocol !== 'https:' || origin.username !== '' || origin.password !== '' || origin.pathname !== '/' || origin.search !== '' || origin.hash !== '') {
    throw new CommunicationError('MESSAGE_CONFIG_INVALID', 'HTTPS route origin is invalid')
  }
  const agent = new Agent({ ...options.tls, keepAlive: true, maxSockets: limits.maxConnections, servername: options.serverName,
    rejectUnauthorized: true, timeout: limits.idleTimeoutMs })
  let active = true
  const tasks = new Set<Promise<MessageDeliveryOutcome>>()
  let disposeTask: Promise<void> | undefined
  const closing = new AbortController()
  return Object.freeze({
    deliver(envelope: MessageEnvelope, delivery: { readonly signal: AbortSignal }): Promise<MessageDeliveryOutcome> {
      if (!active || delivery.signal.aborted) return Promise.resolve(Object.freeze({ kind: 'retry', code: 'attempt-interrupted' }))
      if (tasks.size >= limits.maxInFlightRequests) return Promise.resolve(Object.freeze({ kind: 'retry', code: 'transport-outcome-unknown' }))
      const source = resolveDirectoryReceiver(options.directory, envelope.sender)
      if (source.status.kind !== 'online' || source.receiver === undefined || !source.receiver.verifyDeliveryAttempt(envelope)) {
        throw new CommunicationError('MESSAGE_TRANSPORT_SOURCE_INVALID', 'HTTPS sender attempt is not active')
      }
      const task = send(envelope, { signal: AbortSignal.any([delivery.signal, closing.signal]) })
      tasks.add(task)
      void task.then(() => tasks.delete(task), () => tasks.delete(task))
      return task
    },
    dispose() {
      if (disposeTask === undefined) {
        active = false
        disposeTask = Promise.resolve().then(async () => { await Promise.allSettled([...tasks]); agent.destroy() })
        closing.abort()
      }
      return disposeTask
    },
  })
  async function send(envelope: MessageEnvelope, delivery: { readonly signal: AbortSignal }): Promise<MessageDeliveryOutcome> {
      const body = Buffer.from(canonicalJsonBytes({ protocolVersion: 1, envelope: decodeMessageEnvelope(envelope) }))
      if (body.byteLength > limits.maxBodyBytes) throw new CommunicationError('MESSAGE_ENVELOPE_INVALID', 'HTTPS body exceeds configured limit')
      try {
        return await new Promise<MessageDeliveryOutcome>((resolve, reject) => {
          const controller = new AbortController()
          const abort = (): void => controller.abort()
          delivery.signal.addEventListener('abort', abort, { once: true })
          if (delivery.signal.aborted) controller.abort()
          const timer = setTimeout(() => controller.abort(), limits.requestTimeoutMs)
          const target = new URL(deliveryPath, origin)
          const outgoing = request(target, { method: 'POST', agent, signal: controller.signal, servername: options.serverName,
            maxHeaderSize: limits.maxHeaderBytes, headers: { 'content-type': 'application/json', 'content-length': body.byteLength,
              'x-atomic-host-key': options.hostKey } }, async response => {
            try {
              const responseBody = await readBounded(response, limits.maxResponseBytes, limits.bodyTimeoutMs)
              if (response.statusCode === 401 || response.statusCode === 403 || response.statusCode === 409) {
                reject(new CommunicationError('MESSAGE_TRANSPORT_SOURCE_INVALID', 'remote Host rejected transport identity'))
              } else if (response.statusCode !== 200 || response.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
                resolve(Object.freeze({ kind: 'retry', code: 'transport-outcome-unknown' }))
              } else {
                try {
                  const value = readJson(responseBody, limits.maxResponseBytes) as JsonObject
                  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.protocolVersion !== 1 || Object.keys(value).length !== 2) throw new Error('protocol')
                  resolve(outcome(value.outcome))
                }
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
  }
}
