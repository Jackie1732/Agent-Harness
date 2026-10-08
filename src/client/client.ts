import { randomUUID } from 'node:crypto'
import type { ClientRequest } from 'node:http'
import { Agent, request as httpsRequest } from 'node:https'
import type { TLSSocket } from 'node:tls'
import { parseBoundedJson, inspectBoundedJson } from '../schema/bounded-json.js'
import { CONTROL_PATH, CONTROL_PROTOCOL, CONTROL_VERSION, METHOD_CATEGORIES, decodeParams, decodeControlResponse } from '../protocol/index.js'
import type { ControlMethod, Params, Result, SessionEventPage } from '../protocol/index.js'
import { ApiError, ClientAbortError, ClientTransportError } from './errors.js'
import { resolveClientOptions } from './config.js'
import type { HarnessClientOptions } from './config.js'

export interface HarnessClient {
  /**
   * Perform one typed RPC attempt without automatic retry. Local abort does not cancel accepted server work.
   * @param method Declared control method.
   * @param params Method-specific request fields.
   * @param options Optional signal for this client's request and observation.
   * @returns The validated result; failures expose confirmed or unknown domain acceptance.
   */
  request<M extends ControlMethod>(method: M, params: Params<M>, options?: { readonly signal?: AbortSignal }): Promise<Result<M>>
  /**
   * Capture the target and page budget on first advance, then read one fixed Session prefix.
   * @param params Target, page budget and optional starting position or cursor.
   * @param options Optional signal for this client's page requests.
   * @returns Pages requested only as the iterator advances; reaching the captured cut ends iteration.
   */
  events(params: Params<'session.events'>, options?: { readonly signal?: AbortSignal }): AsyncIterable<SessionEventPage>
  /**
   * Stop new requests and abort this client's connections without shutting down the Host.
   * @returns The shared close promise after outstanding attempts have settled.
   */
  close(): Promise<void>
  /**
   * Join the same client-local close operation as close().
   * @returns The shared close promise after outstanding attempts have settled.
   */
  dispose(): Promise<void>
}
/**
 * Own bounded mTLS requests and a finite event-page iterator; creation sends no request.
 * @param options HTTPS origin, caller-supplied PEM material and explicit resource budgets.
 * @returns A client owning only its connections and request attempts.
 */
export function createHarnessClient(options: HarnessClientOptions): HarnessClient {
  const config = resolveClientOptions(options)
  const agent = new Agent({ ...config.tls, keepAlive: true, rejectUnauthorized: true, servername: config.servername,
    maxSockets: config.limits.maxConnections, maxTotalSockets: config.limits.maxConnections })
  const closing = new AbortController(), tasks = new Set<Promise<unknown>>()
  let active = true, disposal: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (disposal === undefined) {
      active = false
      disposal = Promise.resolve().then(async () => { await Promise.allSettled([...tasks]); agent.destroy() })
      closing.abort()
      agent.destroy()
    }
    return disposal
  }
  const execute = <M extends ControlMethod>(method: M, params: Params<M>, call: { readonly signal?: AbortSignal } = {}): Promise<Result<M>> => {
    const acceptance = (sent: boolean) => METHOD_CATEGORIES[method] === 'observation' ? 'not-applicable' as const : sent ? 'unknown' as const : 'not-accepted' as const
    if (!active || call.signal?.aborted) return Promise.reject(new ClientAbortError(acceptance(false)))
    const requestId = randomUUID()
    const limits = { maxBytes: config.limits.maxRequestBytes, maxDepth: config.limits.maxJsonDepth, maxNodes: config.limits.maxJsonNodes }
    const input = { protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId, method, params: decodeParams(method, params, limits) }
    inspectBoundedJson(input, limits)
    const body = Buffer.from(JSON.stringify(input))
    const signal = call.signal === undefined ? closing.signal : AbortSignal.any([closing.signal, call.signal])
    const task = new Promise<Result<M>>((resolve, reject) => {
      let sent = false, settled = false
      let outgoing: ClientRequest
      try { outgoing = httpsRequest(new URL(CONTROL_PATH, config.origin), { method: 'POST', agent, servername: config.servername,
        headers: { 'content-type': 'application/json', 'content-length': body.byteLength } }, response => {
        const chunks: Buffer[] = []; let bytes = 0
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.byteLength
          if (bytes > config.limits.maxResponseBytes) { finish(new ClientTransportError(acceptance(sent))); return }
          chunks.push(chunk)
        })
        response.once('error', () => finish(new ClientTransportError(acceptance(sent))))
        response.once('aborted', () => finish(new ClientTransportError(acceptance(sent))))
        response.once('end', () => {
          if (settled) return
          try {
            if (response.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new TypeError('content type')
            const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))
            const responseLimits = { ...limits, maxBytes: config.limits.maxResponseBytes }
            const decoded = decodeControlResponse(method, parseBoundedJson(text, responseLimits), requestId, response.statusCode ?? 0, responseLimits)
            if (decoded.kind === 'error') finish(new ApiError(decoded.error.code, decoded.error.message, decoded.error.acceptance, decoded.error.domainCode))
            else {
              if (method === 'session.events') {
                const query = input.params as Params<'session.events'>, page = decoded.result as Result<'session.events'>
                const firstSequence = query.cursor?.nextSequence ?? (query.after ?? 0) + 1
                if (query.cursor !== undefined && (page.sessionId !== query.cursor.sessionId || page.through !== query.cursor.through)
                  || page.through < firstSequence - 1 || page.events.length > query.maxEvents
                  || page.events.length > 0 && page.events[0]!.sequence !== firstSequence
                  || page.events.length === 0 && firstSequence <= page.through) throw new TypeError('Event page does not match requested prefix')
              }
              finish(undefined, decoded.result)
            }
          } catch (error) { finish(error instanceof ApiError ? error : new ClientTransportError(acceptance(sent))) }
        })
      }) } catch { reject(new ClientTransportError(acceptance(false))); return }
      const deadline = setTimeout(() => finish(new ClientTransportError(acceptance(sent))), config.limits.requestTimeoutMs)
      const connectDeadline = setTimeout(() => finish(new ClientTransportError(acceptance(sent))), config.limits.connectTimeoutMs)
      const abort = (): void => finish(new ClientAbortError(acceptance(sent)))
      function finish(error?: Error, value?: Result<M>): void {
        if (settled) return
        settled = true; clearTimeout(deadline); clearTimeout(connectDeadline); signal.removeEventListener('abort', abort)
        if (error !== undefined) { outgoing.destroy(); reject(error) }
        else resolve(value!)
      }
      outgoing.once('socket', socket => {
        const tls = socket as TLSSocket
        const connected = (): void => { clearTimeout(connectDeadline); sent = true }
        if (!tls.connecting && tls.authorized) connected()
        else tls.once('secureConnect', connected)
      })
      outgoing.once('error', () => finish(new ClientTransportError(acceptance(sent))))
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else outgoing.end(body)
    })
    tasks.add(task); void task.then(() => tasks.delete(task), () => tasks.delete(task))
    return task
  }
  return Object.freeze({ request: execute, close, dispose: close,
    async *events(params: Params<'session.events'>, call: { readonly signal?: AbortSignal } = {}) {
      let query: Params<'session.events'> = { ...params, target: { ...params.target } }
      while (true) {
        const page = await execute('session.events', query, call)
        yield page
        if (!page.hasMore || page.nextCursor === null) return
        query = { target: query.target, maxEvents: query.maxEvents, cursor: page.nextCursor }
      }
    } })
}
