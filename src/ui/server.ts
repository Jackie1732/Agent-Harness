import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import { createSecureContext } from 'node:tls'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { EffectOwner } from '../effect/owner.js'
import { createHarnessClient } from '../client/client.js'
import type { HarnessClient } from '../client/client.js'
import { CONTROL_PROTOCOL, CONTROL_VERSION, decodeControlRequest } from '../protocol/index.js'
import type { ControlMethod } from '../protocol/index.js'
import { readRequest, writeResponse } from '../api/http-io.js'
import { authorizeOrigin, browserFailure, UiRejection, writeBrowserJson } from './http.js'
import { UiSession } from './session.js'
import type { ResolvedUiConfig } from './config.js'

const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'], '/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'],
  '/rpc.mjs': ['rpc.mjs', 'text/javascript; charset=utf-8'], '/view.mjs': ['view.mjs', 'text/javascript; charset=utf-8'],
  '/forms.mjs': ['forms.mjs', 'text/javascript; charset=utf-8'] } as const
export interface UiReady { readonly kind: 'ui-ready'; readonly url: string; readonly drive: 'explicit-run' }
export interface HarnessUiServer {
  readonly ready: UiReady
  readonly status: 'ready' | 'closing' | 'closed' | 'failed'
  readonly closed: Promise<void>
  /** Stop browser admission and join local requests; never shut down the remote Host. */
  dispose(): Promise<void>
}
/** Local browser listener configuration, explicit password and optional packaged asset directory. */
export interface OpenHarnessUiServerOptions { readonly config: ResolvedUiConfig; readonly password: string; readonly staticDirectory?: string }
/**
 * Own one loopback browser gateway and one remote mTLS client through Effect ownership.
 * @param options Validated static connection, operator password and packaged assets.
 * @returns The listener coordinates and shared local cleanup operation.
 */
export async function openHarnessUiServer(options: OpenHarnessUiServerOptions): Promise<HarnessUiServer> {
  const config = options.config, limits = config.limits, sessions = new UiSession(options.password, limits.sessionTimeoutMs)
  const assetDirectory = options.staticDirectory ?? fileURLToPath(new URL('../web/', import.meta.url))
  const staticFiles = new Map<string, { readonly body: Buffer; readonly type: string }>()
  for (const [route, [name, type]] of Object.entries(assets)) staticFiles.set(route, { body: await readFile(join(assetDirectory, name)), type })
  const [ca, cert, key] = await Promise.all([config.remote.caFile, config.remote.certFile, config.remote.keyFile].map(path => readFile(path)))
  createSecureContext({ ca: ca!, cert: cert!, key: key! })
  const owner = new EffectOwner('browser-gateway'), tasks = new Set<Promise<void>>(), sockets = new Set<Duplex>()
  let client!: HarnessClient, server!: Server, origin = '', state: HarnessUiServer['status'] = 'ready', disposal: Promise<void> | undefined
  let closedResolve!: () => void, closedReject!: (error: unknown) => void
  const closed = new Promise<void>((resolve, reject) => { closedResolve = resolve; closedReject = reject }); void closed.catch(() => undefined)
  const perform = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let method: ControlMethod | undefined, domainReturned = false
    const abort = new AbortController(), disconnected = (): void => { if (!response.writableFinished) abort.abort() }
    response.once('close', disconnected)
    response.setHeader('cache-control', 'no-store'); response.setHeader('x-content-type-options', 'nosniff')
    response.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    try {
      authorizeOrigin(request, origin)
      if (state !== 'ready') throw new UiRejection('UI_INACTIVE', 409)
      if (request.method === 'GET') {
        const asset = staticFiles.get(request.url ?? '')
        if (asset !== undefined) { await writeResponse(response, 200, asset.body, limits.responseWriteTimeoutMs, asset.type); return }
        if (request.url === '/api/session') {
          if (!sessions.accepts(request.headers.cookie)) throw new UiRejection('UI_UNAUTHORIZED', 401)
          await writeBrowserJson(response, config, 200, { authenticated: true, connection: { origin: config.remote.origin,
            memberKeys: config.memberKeys, workflowKeys: config.workflowKeys, drive: 'explicit-run' } }); return
        }
        throw new UiRejection('UI_PROTOCOL_INVALID', 404)
      }
      if (request.method !== 'POST' || !['/api/login', '/api/logout', '/api/control'].includes(request.url ?? '')
        || request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new UiRejection('UI_PROTOCOL_INVALID', 400)
      if (request.url !== '/api/login' && !sessions.accepts(request.headers.cookie)) throw new UiRejection('UI_UNAUTHORIZED', 401)
      const value = await readRequest(request, limits)
      if (state !== 'ready') throw new UiRejection('UI_INACTIVE', 409)
      if (request.url === '/api/login') {
        if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('password' in value) || typeof value.password !== 'string') throw new UiRejection('UI_PROTOCOL_INVALID', 400)
        const cookie = sessions.login(value.password)
        if (cookie === undefined) throw new UiRejection('UI_UNAUTHORIZED', 401)
        response.setHeader('set-cookie', cookie); await writeBrowserJson(response, config, 200, { authenticated: true }); return
      }
      if (!sessions.accepts(request.headers.cookie)) throw new UiRejection('UI_UNAUTHORIZED', 401)
      if (request.url === '/api/logout') {
        if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 0) throw new UiRejection('UI_PROTOCOL_INVALID', 400)
        response.setHeader('set-cookie', sessions.logout()); await writeBrowserJson(response, config, 200, { authenticated: false }); return
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 2 || !('method' in value) || !('params' in value)) throw new UiRejection('UI_PROTOCOL_INVALID', 400)
      const decoded = decodeControlRequest({ protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId: randomUUID(), ...value },
        { maxBytes: limits.maxRequestBytes, maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes })
      method = decoded.method
      const result = await client.request(decoded.method, decoded.params, { signal: abort.signal })
      domainReturned = true
      await writeBrowserJson(response, config, 200, { kind: 'result', result })
    } catch (error) {
      const failure = browserFailure(error, method, domainReturned)
      if (!request.complete) response.setHeader('connection', 'close')
      if (!response.destroyed && !response.headersSent) await writeBrowserJson(response, config, failure.status, { kind: 'error', error: failure.error })
    } finally { response.off('close', disconnected) }
  }
  try {
    await owner.run('client-and-listener', async context => {
      client = await context.apply('remote-client', () => createHarnessClient({ origin: config.remote.origin,
        ...(config.remote.serverName === null ? {} : { serverName: config.remote.serverName }), tls: { ca: ca!, cert: cert!, key: key! }, limits: config.remote.limits }), owned => owned.close())
      server = createServer({ maxHeaderSize: limits.maxHeaderBytes, connectionsCheckingInterval: Math.min(limits.headersTimeoutMs, limits.requestReadTimeoutMs) }, (request, response) => {
        let task: Promise<void>
        if (state !== 'ready' || tasks.size >= limits.maxPendingRequests) {
          response.setHeader('connection', 'close')
          const failure = browserFailure(new UiRejection(state === 'ready' ? 'UI_CAPACITY_EXCEEDED' : 'UI_INACTIVE', state === 'ready' ? 429 : 409))
          task = writeBrowserJson(response, config, failure.status, { kind: 'error', error: failure.error })
        } else task = Promise.resolve().then(() => perform(request, response))
        tasks.add(task)
        void task.then(() => tasks.delete(task), () => { tasks.delete(task); response.destroy() })
      })
      server.requestTimeout = 0; server.headersTimeout = limits.headersTimeoutMs; server.keepAliveTimeout = limits.keepAliveTimeoutMs; server.maxConnections = limits.maxConnections
      server.maxRequestsPerSocket = 1; server.on('dropRequest', (_request, socket) => socket.destroy())
      server.on('connection', socket => { if (state !== 'ready') socket.destroy(); else { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) } })
      await context.apply('loopback-listener', () => new Promise<Server>((resolve, reject) => {
        const failed = (error: Error): void => { server.off('listening', listening); reject(error) }
        const listening = (): void => { server.off('error', failed); resolve(server) }
        server.once('error', failed); server.once('listening', listening); server.listen(config.listenPort, '127.0.0.1')
      }), async () => {
        const stopped = new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
        for (const socket of sockets) socket.destroy()
        await Promise.allSettled([...tasks]); await stopped
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Browser listener address unavailable')
    origin = `http://127.0.0.1:${address.port}`
    return Object.freeze({ ready: Object.freeze({ kind: 'ui-ready', url: origin, drive: 'explicit-run' }), closed, get status() { return state },
      dispose() { if (disposal === undefined) { state = 'closing'; sessions.logout(); disposal = owner.dispose().then(() => { state = 'closed' }, error => { state = 'failed'; throw error }); void disposal.then(closedResolve, closedReject) } return disposal } })
  } catch (error) { await owner.dispose(); throw error }
}
