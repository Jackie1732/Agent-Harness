import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:https'
import type { Server } from 'node:https'
import type { Duplex } from 'node:stream'
import { readRequest, writeResponse } from '../api/http-io.js'
import { ApiRejection } from '../api/errors.js'
import { AutomationError, record, text } from './validation.js'
import type { AutomationConfig } from './config-types.js'

export interface AutomationWebhook {
  readonly listen: { readonly host: string; readonly port: number }
  dispose(): Promise<void>
}
/** Fixed Job routes own bearer authentication; body identity cannot choose an Agent or Host. */
export async function openAutomationWebhook(options: { readonly config: AutomationConfig; readonly cert: Buffer; readonly key: Buffer; readonly token: string;
  readonly accept: (jobKey: string, eventId: string, text: string) => Promise<unknown>; readonly status: () => unknown }): Promise<AutomationWebhook> {
  const config = options.config, limits = config.limits, token = Buffer.from(`Bearer ${options.token}`)
  const sockets = new Set<Duplex>(), requests = new Set<Promise<void>>()
  let accepting = true, disposal: Promise<void> | undefined
  const server: Server = createServer({ cert: options.cert, key: options.key, handshakeTimeout: limits.tlsHandshakeTimeoutMs,
    maxHeaderSize: limits.maxHeaderBytes, connectionsCheckingInterval: Math.min(limits.headersTimeoutMs, limits.requestReadTimeoutMs) }, (incoming, response) => {
    const operation = async (): Promise<void> => {
      try {
        const provided = Buffer.from(typeof incoming.headers.authorization === 'string' ? incoming.headers.authorization : '')
        if (provided.length !== token.length || !timingSafeEqual(provided, token)) throw new ApiRejection('API_UNAUTHORIZED')
        if (!accepting) throw new AutomationError('AUTOMATION_INACTIVE')
        if (requests.size > limits.maxPendingRequests) { response.destroy(); return }
        let result: unknown, status = 200
        if (incoming.method === 'GET' && incoming.url === '/automation/v1/status') result = options.status()
        else {
          const route = /^\/automation\/v1\/webhooks\/([a-z][a-z0-9_-]{0,31})$/.exec(incoming.url ?? '')
          if (incoming.method !== 'POST' || route === null || incoming.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
            || !config.jobs.some(job => job.jobKey === route[1] && job.trigger.kind === 'webhook')) throw new ApiRejection('API_PROTOCOL_INVALID')
          const payload = record(await readRequest(incoming, limits), ['eventId', 'text'])
          result = await options.accept(route[1]!, text(payload.eventId, 128), text(payload.text, limits.maxRequestBytes)); status = 202
        }
        const body = Buffer.from(JSON.stringify(result))
        if (body.byteLength > limits.maxResponseBytes) throw new AutomationError('AUTOMATION_LIMIT')
        await writeResponse(response, status, body, limits.responseWriteTimeoutMs)
      } catch (error) {
        const code = error instanceof AutomationError ? error.code : error instanceof ApiRejection ? error.code : 'AUTOMATION_INTERNAL_ERROR'
        const status = code === 'API_UNAUTHORIZED' ? 401 : code === 'AUTOMATION_CONFLICT' ? 409 : ['AUTOMATION_LIMIT', 'API_LIMIT_EXCEEDED'].includes(code) ? 429
          : code === 'AUTOMATION_INACTIVE' ? 503 : ['AUTOMATION_CONFIG_INVALID', 'API_PROTOCOL_INVALID'].includes(code) ? 400 : 500
        if (!incoming.complete) response.setHeader('connection', 'close')
        if (!response.destroyed && !response.headersSent) await writeResponse(response, status, Buffer.from(JSON.stringify({ code, message: 'Automation request rejected' })), limits.responseWriteTimeoutMs)
      }
    }
    const task = Promise.resolve().then(operation)
    requests.add(task); void task.then(() => requests.delete(task), () => { requests.delete(task); response.destroy() })
  })
  server.requestTimeout = 0; server.headersTimeout = limits.headersTimeoutMs; server.keepAliveTimeout = limits.keepAliveTimeoutMs; server.maxConnections = limits.maxConnections
  server.maxRequestsPerSocket = 1
  server.on('dropRequest', (_request, socket) => socket.destroy())
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  const dispose = (): Promise<void> => {
    disposal ??= (async () => {
      accepting = false
      const closed = new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
      void closed.catch(() => undefined)
      await Promise.allSettled([...requests]); for (const socket of sockets) socket.destroy(); await closed
    })()
    return disposal
  }
  try {
    await new Promise<void>((resolve, reject) => { const failed = (error: Error): void => { server.off('listening', ready); reject(error) }
      const ready = (): void => { server.off('error', failed); resolve() }; server.once('error', failed); server.once('listening', ready); server.listen(config.webhook.listenPort, config.webhook.listenHost) })
    const address = server.address() as { address: string; port: number }
    return { listen: { host: address.address, port: address.port }, dispose }
  } catch (error) { for (const socket of sockets) socket.destroy(); server.close(); throw error }
}
