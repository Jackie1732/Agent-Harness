import { readFile } from 'node:fs/promises'
import { createServer } from 'node:https'
import type { Server } from 'node:https'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { createSecureContext } from 'node:tls'
import type { TLSSocket } from 'node:tls'
import { EffectOwner } from '../effect/owner.js'
import { openHost } from '../host/runtime.js'
import type { AtomicHost, HostShutdownMode } from '../host/runtime.js'
import type { ResolvedHostSpec } from '../host/config.js'
import { CONTROL_PATH, CONTROL_PROTOCOL, CONTROL_VERSION, API_HTTP_STATUS, METHOD_CATEGORIES, ProtocolError, decodeControlRequest, decodeControlResponse } from '../protocol/index.js'
import type { AnyControlRequest, RootObservation, Result } from '../protocol/index.js'
import type { ApiLimits, ResolvedApiConfig } from './config.js'
import { authorizeRequest } from './authorization.js'
import { ApiAdmission } from './admission.js'
import { apiFailure, ApiRejection, readMethod } from './errors.js'
import { readRequest, writeResponse } from './http-io.js'
import { dispatchControl } from './dispatch.js'

/** Startup evidence includes only actual listening coordinates and non-sensitive budgets. */
export interface ApiReady {
  readonly kind: 'api-ready'; readonly protocol: typeof CONTROL_PROTOCOL; readonly version: typeof CONTROL_VERSION
  readonly hostKey: string; readonly instanceId: string; readonly listen: { readonly host: string; readonly port: number }
  readonly drive: 'explicit-run'; readonly limits: ApiLimits
}
export type ApiServiceStatus = 'starting' | 'ready' | 'closing' | 'closed' | 'failed'
export interface HarnessApiServer {
  readonly ready: ApiReady
  readonly status: ApiServiceStatus
  /** Successful resolution confirms Host and network release; rejection preserves the shared cleanup failure. */
  readonly closed: Promise<void>
  /**
   * Join service shutdown. Cancel can upgrade drain until Host storage release begins; later calls retain the fixed mode.
   * @param options Requested Host shutdown mode.
   * @returns The shared cleanup promise; successful resolution confirms Host and HTTPS resource release, and rejection preserves the original failure.
   */
  shutdown(options: { readonly mode: HostShutdownMode }): Promise<void>
  /**
   * Join service shutdown with cancel as the requested mode.
   * @returns The shared cleanup promise with the same release and failure guarantees as shutdown().
   */
  dispose(): Promise<void>
}
export interface OpenHarnessApiServerOptions {
  readonly host: ResolvedHostSpec
  readonly api: ResolvedApiConfig
  readonly credentials: Readonly<Record<string, string>>
}

/**
 * Own one pre-initialized Host and HTTPS listener with separate Host and network release phases.
 * @param options Resolved Host and API configuration plus explicit model credentials.
 * @returns The ready service with actual listening coordinates and shared lifecycle operations.
 */
export async function openHarnessApiServer(options: OpenHarnessApiServerOptions): Promise<HarnessApiServer> {
  const config = options.api, limits = config.limits
  const [ca, cert, key] = await Promise.all([config.tls.caFile, config.tls.serverCertFile, config.tls.serverKeyFile].map(path => readFile(path)))
  createSecureContext({ ca: ca!, cert: cert!, key: key! })
  const owner = new EffectOwner('control-api'), admission = new ApiAdmission(limits)
  const sockets = new Set<Duplex>(), networkTasks = new Set<Promise<void>>()
  let state: ApiServiceStatus = 'starting', frozen = false
  let host!: AtomicHost, server!: Server, phase: Promise<void> | undefined, disposal: Promise<void> | undefined
  let listenerClosed: Promise<void> | undefined
  let closedResolve!: () => void, closedReject!: (error: unknown) => void
  const closed = new Promise<void>((resolve, reject) => { closedResolve = resolve; closedReject = reject })
  void closed.catch(() => undefined)
  const stopListener = (): void => {
    if (listenerClosed !== undefined) return
    listenerClosed = new Promise<void>((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    void listenerClosed.catch(() => undefined)
  }
  const releaseNetwork = async (): Promise<void> => {
    frozen = true; stopListener()
    await Promise.allSettled([...networkTasks])
    for (const socket of sockets) socket.destroy()
    await listenerClosed
  }
  const close = (mode: HostShutdownMode): Promise<void> => {
    if (phase === undefined) {
      state = 'closing'
      phase = host.shutdown({ mode })
      const freeze = (): void => { frozen = true; stopListener() }
      void phase.then(freeze, freeze)
      disposal = Promise.resolve().then(async () => {
        let failed = false, failure: unknown
        try { await phase } catch (error) { failed = true; failure = error }
        try { await owner.dispose() } catch (error) { if (!failed) { failed = true; failure = error } }
        state = failed ? 'failed' : 'closed'
        if (failed) throw failure
      })
      void disposal.catch(() => undefined)
      void disposal.then(closedResolve, closedReject)
    } else void host.shutdown({ mode }).catch(() => undefined)
    return phase
  }
  const perform = async (incoming: IncomingMessage, response: ServerResponse): Promise<void> => {
    const disconnected = new AbortController()
    const disconnect = (): void => { if (!response.writableFinished) disconnected.abort() }
    response.once('close', disconnect)
    let decoded: AnyControlRequest | undefined, invoked = false
    const progress = { domainReturned: false }
    try {
      if (frozen) { response.destroy(); return }
      const tls = incoming.socket as TLSSocket
      const fingerprint = tls.getPeerCertificate().fingerprint256?.replaceAll(':', '').toLowerCase()
      const principal = tls.authorized ? config.principals.find(principal => principal.certificateFingerprints.includes(fingerprint ?? '')) : undefined
      if (principal === undefined) throw new ApiRejection('API_UNAUTHORIZED')
      if (incoming.method !== 'POST' || incoming.url !== CONTROL_PATH
        || incoming.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new ApiRejection('API_PROTOCOL_INVALID')
      const jsonLimits = { maxBytes: limits.maxRequestBytes, maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes }
      decoded = decodeControlRequest(await readRequest(incoming, limits), jsonLimits)
      if (frozen) { response.destroy(); return }
      await authorizeRequest(principal, decoded, host, options.host)
      if (frozen) { response.destroy(); return }
      if (state !== 'ready' && decoded.method !== 'host.shutdown') throw new ApiRejection('API_INACTIVE', readMethod(decoded.method) ? 'not-applicable' : 'not-accepted')
      if (METHOD_CATEGORIES[decoded.method] === 'business' && host.activity !== 'idle') throw new ApiRejection('API_BUSY')
      const captured = decoded
      let result = await admission.run(captured.method, async () => {
        invoked = true
        return await dispatchControl(host, options.host, principal, captured, limits, disconnected.signal, close, progress)
      })
      const envelope = () => ({ protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId: captured.requestId, kind: 'result' as const, result })
      let body = Buffer.from(JSON.stringify(envelope()))
      if (body.byteLength > limits.maxResponseBytes && (captured.method === 'root.get' || captured.method === 'root.wait')) {
        const root = (captured.method === 'root.get' ? result : (result as Result<'root.wait'>).observation) as RootObservation
        if (root.final?.text !== null && root.final !== null) {
          const omitted = { ...root, final: { ...root.final, text: null, textOmitted: true } }
          result = captured.method === 'root.get' ? omitted : { ...(result as Result<'root.wait'>), observation: omitted }
          body = Buffer.from(JSON.stringify(envelope()))
        }
      }
      if (body.byteLength > limits.maxResponseBytes) throw new ApiRejection('API_LIMIT_EXCEEDED', readMethod(captured.method) ? 'not-applicable' : 'unknown')
      try { decodeControlResponse(captured.method, envelope(), captured.requestId, 200,
        { maxBytes: limits.maxResponseBytes, maxDepth: limits.maxJsonDepth, maxNodes: limits.maxJsonNodes }) }
      catch (error) {
        throw new ApiRejection(error instanceof ProtocolError && error.code === 'API_LIMIT_EXCEEDED' ? 'API_LIMIT_EXCEEDED' : 'API_INTERNAL_ERROR',
          readMethod(captured.method) ? 'not-applicable' : 'unknown')
      }
      await writeResponse(response, 200, body, limits.responseWriteTimeoutMs)
    } catch (error) {
      const failure = apiFailure(error, decoded?.method, invoked, progress.domainReturned)
      if (!incoming.complete) response.setHeader('connection', 'close')
      const envelope = { protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId: decoded?.requestId ?? null, kind: 'error', error: failure }
      let body = Buffer.from(JSON.stringify(envelope))
      if (body.byteLength > limits.maxResponseBytes) body = Buffer.from(JSON.stringify({ ...envelope, error: { ...failure, domainCode: null } }))
      if (!response.destroyed && !response.headersSent) await writeResponse(response, API_HTTP_STATUS[failure.code], body, limits.responseWriteTimeoutMs)
    } finally { response.off('close', disconnect) }
  }
  try {
    await owner.run('host-and-listener', async context => {
      host = await context.apply('host', () => openHost(options.host, { credentials: options.credentials,
        bindings: { protectedRoots: config.protectedRoots } }), owned => owned.shutdown({ mode: 'cancel' }))
      server = createServer({ ca: ca!, cert: cert!, key: key!, requestCert: true, rejectUnauthorized: true,
        handshakeTimeout: limits.tlsHandshakeTimeoutMs, maxHeaderSize: limits.maxHeaderBytes,
        connectionsCheckingInterval: Math.min(limits.headersTimeoutMs, limits.requestReadTimeoutMs) }, (incoming, response) => {
        const task = Promise.resolve().then(() => perform(incoming, response))
        networkTasks.add(task)
        void task.then(() => networkTasks.delete(task), () => { networkTasks.delete(task); response.destroy() })
      })
      // Body reading belongs to readRequest; Node still owns finite request-header timeouts.
      server.requestTimeout = 0
      server.headersTimeout = limits.headersTimeoutMs
      server.keepAliveTimeout = limits.keepAliveTimeoutMs
      server.maxConnections = limits.maxConnections
      server.on('connection', socket => { if (frozen) socket.destroy(); else { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) } })
      await context.apply('listener', () => new Promise<Server>((resolve, reject) => {
        const error = (error: Error): void => { server.off('listening', listening); for (const socket of sockets) socket.destroy(); reject(error) }
        const listening = (): void => { server.off('error', error); resolve(server) }
        server.once('error', error); server.once('listening', listening); server.listen(config.listenPort, config.listenHost)
      }), releaseNetwork)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Control listener address unavailable')
    state = 'ready'
    const ready: ApiReady = Object.freeze({ kind: 'api-ready', protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION,
      hostKey: options.host.hostKey, instanceId: host.instanceId, listen: Object.freeze({ host: address.address, port: address.port }), drive: 'explicit-run', limits })
    return Object.freeze({ ready, closed, get status() { return state }, shutdown(input: { readonly mode: HostShutdownMode }) { close(input.mode); return disposal! },
      dispose() { close('cancel'); return disposal! } })
  } catch (error) {
    state = 'failed'
    await owner.dispose()
    throw error
  }
}
