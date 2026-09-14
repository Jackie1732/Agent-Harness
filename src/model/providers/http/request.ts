import { request as requestHttp, Agent as HttpAgent } from 'node:http'
import { request as requestHttps, Agent as HttpsAgent } from 'node:https'
import type { ClientRequest, IncomingMessage } from 'node:http'
import type { ModelFrame, PreparedSubmission } from '../../contract.js'
import { ModelError } from '../../errors.js'
import { encodeModelWireBody } from '../../submission.js'
import { readServerSentEvents } from './sse.js'
import type { SseRecord } from './sse.js'

export type ModelStreamDecoder = (records: AsyncIterable<SseRecord>, submission: PreparedSubmission, requestId?: string) => AsyncIterable<ModelFrame>

/** Provider-owned socket pool. Each invocation retains a distinct request owner. */
export class ModelHttpClient {
  readonly #http = new HttpAgent({ keepAlive: true })
  readonly #https = new HttpsAgent({ keepAlive: true })

  create(submission: PreparedSubmission, authentication: Readonly<Record<string, string>>, decode: ModelStreamDecoder): ModelHttpRequest {
    const url = new URL(submission.binding.endpoint)
    return new ModelHttpRequest(submission, authentication, decode, url.protocol === 'https:' ? this.#https : this.#http)
  }

  close(): void { this.#http.destroy(); this.#https.destroy() }
}

/** Owns request/response handles and their close notifications; no retries or redirects. */
export class ModelHttpRequest {
  readonly #submission: PreparedSubmission
  readonly #authentication: Readonly<Record<string, string>>
  readonly #decode: ModelStreamDecoder
  readonly #agent: HttpAgent | HttpsAgent
  #request: ClientRequest | undefined
  #response: IncomingMessage | undefined
  #requestClosed: Promise<void> | undefined
  #responseClosed: Promise<void> | undefined
  #signal: AbortSignal | undefined
  #cancel: (() => void) | undefined

  constructor(submission: PreparedSubmission, authentication: Readonly<Record<string, string>>, decode: ModelStreamDecoder, agent: HttpAgent | HttpsAgent) {
    this.#submission = submission
    this.#authentication = authentication
    this.#decode = decode
    this.#agent = agent
  }

  async open(signal: AbortSignal): Promise<AsyncIterable<ModelFrame>> {
    if (this.#request !== undefined) throw new ModelError('MODEL_STATE_INVALID', 'HTTP model request cannot be issued twice')
    if (signal.aborted) throw new ModelError('MODEL_CALL_CANCELLED', 'model request was cancelled before HTTP emission')
    const body = encodeModelWireBody(this.#submission)
    const url = new URL(this.#submission.binding.endpoint)
    const headers: Record<string, string> = {
      accept: 'text/event-stream', 'content-type': 'application/json',
      'content-length': String(body.byteLength), ...this.#authentication,
    }
    for (const [name, value] of Object.entries(this.#submission.binding.semanticHeaders)) {
      if (typeof value !== 'string') throw new ModelError('MODEL_REQUEST_INVALID', 'semantic HTTP header must be text')
      headers[name] = value
    }
    const send = url.protocol === 'https:' ? requestHttps : requestHttp
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = send(url, { method: 'POST', headers, agent: this.#agent })
      this.#request = request
      this.#requestClosed = new Promise(done => { request.once('close', done) })
      request.once('error', () => reject(new ModelError('MODEL_HTTP_FAILED', 'model HTTP connection failed')))
      request.once('response', value => {
        this.#response = value
        this.#responseClosed = new Promise(done => { value.once('close', done) })
        // An error after receipt is also observed by the iterator. Always install a handler.
        value.on('error', () => undefined)
        resolve(value)
      })
      this.#signal = signal
      this.#cancel = () => { this.#response?.destroy(); request.destroy(); reject(new ModelError('MODEL_CALL_CANCELLED', 'model HTTP request cancelled')) }
      signal.addEventListener('abort', this.#cancel, { once: true })
      // The request can be cancelled reentrantly by an injected HTTP implementation.
      if (signal.aborted) { this.#cancel(); reject(new ModelError('MODEL_CALL_CANCELLED', 'model HTTP request cancelled')) }
      else request.end(body)
    })
    const status = response.statusCode ?? 0
    if (status < 200 || status >= 300) {
      response.destroy()
      throw new ModelError('MODEL_HTTP_FAILED', 'model HTTP service rejected the request', { httpStatus: status >= 100 && status <= 599 ? status : 500 })
    }
    const contentType = response.headers['content-type']?.split(';')[0]?.trim().toLowerCase()
    if (contentType !== 'text/event-stream' || response.headers['content-encoding'] !== undefined && response.headers['content-encoding'] !== 'identity') {
      response.destroy()
      throw new ModelError('MODEL_PROTOCOL_INVALID', 'model response is not an uncompressed SSE stream')
    }
    const rawId = response.headers['request-id'] ?? response.headers['x-request-id']
    const requestId = typeof rawId === 'string' && Buffer.byteLength(rawId) <= 256 ? rawId : undefined
    return this.#decode(readServerSentEvents(response, this.#submission.binding.streamLimits), this.#submission, requestId)
  }

  async close(): Promise<void> {
    this.#response?.destroy()
    this.#request?.destroy()
    if (this.#signal !== undefined && this.#cancel !== undefined) this.#signal.removeEventListener('abort', this.#cancel)
    await Promise.all([this.#requestClosed, this.#responseClosed])
  }
}
