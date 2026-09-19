import type { Clock } from '../foundation/clock.js'
import { systemClock } from '../foundation/clock.js'
import type { EffectLease } from '../effect/types.js'
import { createSessionDirectory } from '../communication/directory.js'
import type { SessionDirectory, SessionDirectoryDeclaration } from '../communication/directory.js'
import { CommunicationService } from '../communication/service.js'
import type { MessageTransport } from '../communication/transport.js'
import { createHttpsMessageClientTransport, createHttpsMessageServer } from '../communication/https-transport.js'
import type { HttpsMessageServer } from '../communication/https-transport.js'
import { createRoutedMessageTransport } from '../communication/routed-transport.js'
import { readFile } from 'node:fs/promises'
import { FileSessionBackend } from '../session/file-backend.js'
import type { SessionEventId } from '../session/ids.js'
import { formatSessionAddress, parseSessionId } from '../session/ids.js'
import { SessionRepository } from '../session/repository.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { AgentActionReference } from '../agent/contract.js'
import type { AgentSendCommand } from '../agent/contract.js'
import type { OutboxMessageSnapshot } from '../communication/types.js'
import { CommunicationError } from '../communication/errors.js'
import { isLocalHostMember } from './config.js'
import type { ResolvedHostSpec } from './config.js'
import { validateHostMemberSession } from './binding.js'
import { HostError } from './errors.js'
import { hostRuntimeEventCatalog } from './initialization.js'
import { compileHostMessageCatalog } from './message-catalog.js'
import { runHostScheduler } from './scheduler.js'
import { createHostSlot } from './slot.js'
import type { HostRunReport, HostSlot } from './runtime-types.js'
import { acquireHostStorageLock } from './storage-lock.js'
import type { HostStorageLock } from './storage-lock.js'

export type HostStatus = 'ready' | 'stopping' | 'stopped' | 'failed'
export type HostShutdownMode = 'drain' | 'cancel'

export interface OpenHostOptions {
  readonly clock?: Clock
  readonly credentials?: Readonly<Record<string, string>>
}

export interface HostInputReceipt {
  readonly agentKey: string
  readonly eventId: SessionEventId
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(done, milliseconds)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

async function settle(tasks: readonly Promise<unknown>[]): Promise<unknown[]> {
  const results = await Promise.allSettled(tasks)
  return results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason)
}

/** Embeddable owner of assembled Agent slots, scheduling, routing and shutdown. */
export class AtomicHost {
  readonly #spec: ResolvedHostSpec
  readonly #clock: Clock
  readonly #storageLock: HostStorageLock
  readonly #repository: SessionRepository
  readonly #directory: SessionDirectory
  readonly #transport: MessageTransport
  readonly #remoteTransports: readonly MessageTransport[]
  readonly #server: HttpsMessageServer | undefined
  readonly #remoteRecipients: ReadonlySet<string>
  readonly #service: CommunicationService
  readonly #declarations: readonly EffectLease<SessionDirectoryDeclaration>[]
  readonly #slots: readonly HostSlot[]
  readonly #byKey: ReadonlyMap<string, HostSlot>
  readonly #paused = new Set<string>()
  readonly #blockedRoutes = new Set<string>()
  readonly #lifetime = new AbortController()
  #status: HostStatus = 'ready'
  #cursor = 0
  #activity: Promise<HostRunReport> | undefined
  #shutdownTask: Promise<void> | undefined
  #shutdownMode: HostShutdownMode | undefined

  constructor(options: {
    readonly spec: ResolvedHostSpec
    readonly clock: Clock
    readonly storageLock: HostStorageLock
    readonly repository: SessionRepository
    readonly directory: SessionDirectory
    readonly transport: MessageTransport
    readonly remoteTransports: readonly MessageTransport[]
    readonly server?: HttpsMessageServer
    readonly remoteRecipients: ReadonlySet<string>
    readonly service: CommunicationService
    readonly declarations: readonly EffectLease<SessionDirectoryDeclaration>[]
    readonly slots: readonly HostSlot[]
  }) {
    this.#spec = options.spec
    this.#clock = options.clock
    this.#storageLock = options.storageLock
    this.#repository = options.repository
    this.#directory = options.directory
    this.#transport = options.transport
    this.#remoteTransports = options.remoteTransports
    this.#server = options.server
    this.#remoteRecipients = options.remoteRecipients
    this.#service = options.service
    this.#declarations = options.declarations
    this.#slots = options.slots
    this.#byKey = new Map(options.slots.map(slot => [slot.member.agentKey, slot]))
  }

  get status(): HostStatus { return this.#status }
  get instanceId(): string { return this.#storageLock.record.instanceId }

  /** Persist one user task without implicitly starting a model run. */
  async submitTask(agentKey: string, text: string, originLabel = 'host-user'): Promise<HostInputReceipt> {
    const slot = this.#slot(agentKey)
    const accepted = await slot.agent.submitInput({ kind: 'task', text, originLabel })
    return Object.freeze({ agentKey, eventId: accepted.stored.eventId })
  }

  /** Persist an answer for one exact Agent wait. */
  async submitAnswer(agentKey: string, wait: AgentActionReference, text: string, originLabel = 'host-user'): Promise<HostInputReceipt> {
    const slot = this.#slot(agentKey)
    const accepted = await slot.agent.submitInput({ kind: 'answer', wait, text, originLabel })
    return Object.freeze({ agentKey, eventId: accepted.stored.eventId })
  }

  /** Stop admitting new business runs for one slot; receipt and maintenance remain active. */
  pause(agentKey: string): void {
    const slot = this.#slot(agentKey)
    this.#paused.add(agentKey)
    slot.agent.pause()
  }

  /** Re-enable business admission for one slot. */
  resume(agentKey: string): void {
    this.#slot(agentKey)
    this.#paused.delete(agentKey)
  }

  /** Persist cancellation for one exact root; notification reaches an active Turn immediately. */
  cancel(agentKey: string, root: SessionEventId, reason = 'host-cancelled') {
    return this.#slot(agentKey).agent.cancel(root, reason)
  }

  /** Execute one explicit quota-limited Agent send command; Host scheduling owns later delivery. */
  sendMessage(agentKey: string, command: AgentSendCommand) {
    return this.#slot(agentKey).agent.sendMessage(command)
  }

  /** Run a finite number of persistent-work scans. */
  run(options: { readonly signal?: AbortSignal } = {}): Promise<HostRunReport> {
    this.#assertReady()
    if (this.#activity !== undefined) throw new HostError('HOST_BUSY', 'host-driver-active')
    const signal = options.signal === undefined
      ? this.#lifetime.signal
      : AbortSignal.any([this.#lifetime.signal, options.signal])
    const task = runHostScheduler({ slots: this.#slots, paused: this.#paused, scheduling: this.#spec.scheduling,
      clock: this.#clock, signal, isStopping: () => this.#status !== 'ready', canAttempt: message => this.#canAttempt(message),
      blockRoute: error => this.#blockRoute(error), blockedRoutes: () => [...this.#blockedRoutes], cursor: this.#cursor })
      .then(result => { this.#cursor = result.cursor; return result.report })
      .finally(() => { if (this.#activity === task) this.#activity = undefined })
    this.#activity = task
    return task
  }

  /** Continue finite scans until cancelled or shutdown starts. */
  serve(options: { readonly signal?: AbortSignal } = {}): Promise<HostRunReport> {
    this.#assertReady()
    if (this.#activity !== undefined) throw new HostError('HOST_BUSY', 'host-driver-active')
    const signal = options.signal === undefined
      ? this.#lifetime.signal
      : AbortSignal.any([this.#lifetime.signal, options.signal])
    const task = (async () => {
      let last: HostRunReport | undefined
      while (!signal.aborted && this.#status === 'ready') {
        const result = await runHostScheduler({ slots: this.#slots, paused: this.#paused, scheduling: this.#spec.scheduling,
          clock: this.#clock, signal, isStopping: () => this.#status !== 'ready', canAttempt: message => this.#canAttempt(message),
          blockRoute: error => this.#blockRoute(error), blockedRoutes: () => [...this.#blockedRoutes], cursor: this.#cursor })
        this.#cursor = result.cursor
        last = result.report
        if (!signal.aborted && this.#status === 'ready') await delay(this.#spec.scheduling.scanIntervalMs, signal)
      }
      return last ?? Object.freeze({ batches: 0, businessRuns: 0, maintenanceRuns: 0, deliveryAttempts: 0,
        stoppedBy: signal.aborted ? 'aborted' as const : 'host-stopping' as const,
        blockedRoutes: Object.freeze([...this.#blockedRoutes]), members: this.report().members })
    })().finally(() => { if (this.#activity === task) this.#activity = undefined })
    this.#activity = task
    return task
  }

  /** Pure bounded observation of every assembled slot. */
  report(): Pick<HostRunReport, 'members' | 'blockedRoutes'> & { readonly status: HostStatus; readonly hostKey: string; readonly instanceId: string } {
    const observedAt = new Date(this.#clock.now()).toISOString()
    return Object.freeze({ status: this.#status, hostKey: this.#spec.hostKey, instanceId: this.instanceId,
      blockedRoutes: Object.freeze([...this.#blockedRoutes]), members: Object.freeze(this.#slots.map(slot => Object.freeze({ agentKey: slot.member.agentKey,
        sessionId: slot.member.sessionId, paused: this.#paused.has(slot.member.agentKey),
        readiness: slot.agent.readiness(observedAt), agent: slot.agent.report() }))) })
  }

  /** Stop admission, join accepted work, and release each dependency in ownership order. */
  shutdown(options: { readonly mode?: HostShutdownMode } = {}): Promise<void> {
    const mode = options.mode ?? 'cancel'
    if (this.#shutdownTask !== undefined) {
      if (mode === 'cancel' && this.#shutdownMode === 'drain') {
        this.#shutdownMode = 'cancel'
        this.#lifetime.abort()
      }
      return this.#shutdownTask
    }
    if (this.#status === 'stopped') return Promise.resolve()
    this.#shutdownMode = mode
    this.#status = 'stopping'
    for (const slot of this.#slots) slot.agent.pause()
    if (mode === 'cancel') this.#lifetime.abort()
    const listenerTask = this.#server?.dispose()
    const transportTask = this.#transport.dispose()
    this.#shutdownTask = (async () => {
      if (this.#activity !== undefined) await this.#activity.catch(() => undefined)
      let failures = await settle([...this.#slots].reverse().map(slot => slot.agent.dispose()))
      if (failures.length > 0) return this.#cleanupFailed('agent-cleanup-failed', failures)
      failures = await settle(listenerTask === undefined ? [] : [listenerTask])
      if (failures.length > 0) return this.#cleanupFailed('listener-cleanup-failed', failures)
      failures = await settle([this.#service.dispose()])
      if (failures.length > 0) return this.#cleanupFailed('communication-cleanup-failed', failures)
      failures = await settle([...this.#slots].reverse().flatMap(slot => slot.tools === undefined ? [] : [slot.tools.dispose()]).concat([
        transportTask, ...this.#remoteTransports.map(transport => transport.dispose()),
        ...[...this.#slots].reverse().map(slot => slot.provider.dispose())]))
      if (failures.length > 0) return this.#cleanupFailed('provider-cleanup-failed', failures)
      failures = await settle([...this.#declarations].reverse().map(declaration => declaration.dispose()))
      if (failures.length > 0) return this.#cleanupFailed('directory-declaration-cleanup-failed', failures)
      failures = await settle([this.#directory.dispose(), this.#repository.dispose()])
      if (failures.length > 0) return this.#cleanupFailed('storage-cleanup-failed', failures)
      try { await this.#storageLock.dispose() }
      catch (cause) { return this.#cleanupFailed('storage-lock-cleanup-failed', [cause]) }
      this.#status = 'stopped'
    })()
    void this.#shutdownTask.catch(() => undefined)
    return this.#shutdownTask
  }

  #cleanupFailed(reason: string, failures: readonly unknown[]): never {
    this.#status = 'failed'
    throw new HostError('HOST_CLEANUP_FAILED', reason, {}, { cause: new AggregateError(failures) })
  }

  #canAttempt(message: OutboxMessageSnapshot): boolean {
    if (this.#blockedRoutes.has(message.envelope.recipient)) return false
    if (this.#remoteRecipients.has(message.envelope.recipient)) return true
    return this.#directory.status(message.envelope.recipient).kind === 'online'
  }

  #blockRoute(error: CommunicationError): boolean {
    const recipient = error.details?.recipient
    if (typeof recipient !== 'string' || !this.#remoteRecipients.has(recipient)) return false
    this.#blockedRoutes.add(recipient)
    return true
  }

  #slot(agentKey: string): HostSlot {
    this.#assertReady()
    const slot = this.#byKey.get(agentKey)
    if (slot === undefined) throw new HostError('HOST_NOT_READY', 'agent-slot-unavailable', { agentKey })
    return slot
  }

  #assertReady(): void {
    if (this.#status !== 'ready') throw new HostError('HOST_INACTIVE', 'host-not-ready', { status: this.#status })
  }
}

/** Validate saved bindings, declare all local addresses, then publish an assembled Host. */
export async function openHost(spec: ResolvedHostSpec, options: OpenHostOptions = {}): Promise<AtomicHost> {
  const clock = options.clock ?? systemClock
  for (const member of spec.members.filter(isLocalHostMember)) {
    if (member.enabled && member.model.kind !== 'scripted-fixed' && options.credentials?.[member.model.credentialRef] === undefined) {
      throw new HostError('HOST_CONFIG_INVALID', 'model-credential-missing', { credentialRef: member.model.credentialRef })
    }
  }
  const tls = spec.https.kind === 'mutual-tls' ? {
    ca: await readFile(spec.https.caFile),
    serverCert: await readFile(spec.https.serverCertFile),
    serverKey: await readFile(spec.https.serverKeyFile),
    clientCert: await readFile(spec.https.clientCertFile),
    clientKey: await readFile(spec.https.clientKeyFile),
  } : undefined
  const storageLock = await acquireHostStorageLock(spec.storage.root, spec.hostKey)
  const backend = new FileSessionBackend({ root: storageLock.root, maxRecordBytes: spec.storage.maxRecordBytes })
  const repository = new SessionRepository({ backend, catalog: hostRuntimeEventCatalog,
    maxLineageDepth: spec.storage.maxLineageDepth, clock })
  const directory = createSessionDirectory()
  const remoteTransports = new Map<string, MessageTransport>()
  if (spec.https.kind === 'mutual-tls' && tls !== undefined) {
    for (const route of spec.routes.filter(item => item.origin !== null)) {
      const key = `${route.ownerHost}\u0000${route.origin}\u0000${route.serverName}`
      if (!remoteTransports.has(key)) remoteTransports.set(key, createHttpsMessageClientTransport({
        origin: route.origin!, serverName: route.serverName!, hostKey: spec.hostKey,
        tls: { ca: tls.ca, cert: tls.clientCert, key: tls.clientKey }, limits: spec.https.limits,
      }))
    }
  }
  const routes = new Map(spec.routes.map(route => [formatSessionAddress(parseSessionId(route.sessionId)), route]))
  const transport = createRoutedMessageTransport(directory, recipient => {
    const route = routes.get(recipient)
    if (route === undefined) return { kind: 'unavailable' }
    if (route.ownerHost === spec.hostKey && route.origin === null) return { kind: 'local' }
    const remote = remoteTransports.get(`${route.ownerHost}\u0000${route.origin}\u0000${route.serverName}`)
    return remote === undefined ? { kind: 'unavailable' } : { kind: 'remote', transport: remote }
  })
  const service = new CommunicationService({ directory, transport, limits: spec.communication, clock })
  const declarations: EffectLease<SessionDirectoryDeclaration>[] = []
  const sessions: SessionHandle[] = []
  const slots: HostSlot[] = []
  let server: HttpsMessageServer | undefined
  try {
    const messageCatalog = compileHostMessageCatalog(spec.messages)
    const localMembers = spec.members.filter(isLocalHostMember)
    for (const member of localMembers) {
      const route = spec.routes.find(item => item.sessionId === member.sessionId)
      if (route === undefined || route.ownerHost !== spec.hostKey || route.origin !== null) {
        throw new HostError('HOST_ROUTE_BLOCKED', 'local-member-route-invalid', { agentKey: member.agentKey })
      }
      declarations.push(await directory.declare(formatSessionAddress(parseSessionId(member.sessionId)), 'active'))
    }
    const enabledMembers = localMembers.filter(item => item.enabled)
    for (const member of enabledMembers) {
      const session = await repository.open(parseSessionId(member.sessionId))
      sessions.push(session)
      validateHostMemberSession(session, spec.hostKey, member)
    }
    for (let index = 0; index < sessions.length; index++) {
      slots.push(await createHostSlot(sessions[index]!, enabledMembers[index]!, service, messageCatalog, clock,
        options.credentials ?? {}, storageLock.root))
    }
    if (spec.https.kind === 'mutual-tls' && tls !== undefined) {
      server = await createHttpsMessageServer({ directory, host: spec.https.listen.host, port: spec.https.listen.port,
        tls: { ca: tls.ca, cert: tls.serverCert, key: tls.serverKey }, limits: spec.https.limits,
        peers: spec.https.peers.map(peer => ({ hostKey: peer.hostKey,
          fingerprint256: peer.fingerprint256,
          senders: new Set(peer.sessionIds.map(sessionId => formatSessionAddress(parseSessionId(sessionId)))) })) })
    }
    const remoteRecipients = new Set(spec.routes.filter(route => route.origin !== null)
      .map(route => formatSessionAddress(parseSessionId(route.sessionId))))
    return new AtomicHost({ spec, clock, storageLock, repository, directory, transport, remoteRecipients,
      remoteTransports: [...remoteTransports.values()], ...(server === undefined ? {} : { server }), service, declarations, slots })
  } catch (cause) {
    const consumerFailures = await settle([...slots].reverse().map(slot => slot.agent.dispose()))
    if (consumerFailures.length > 0) throw new HostError('HOST_CLEANUP_FAILED', 'open-rollback-agent-failed', {}, { cause: new AggregateError([cause, ...consumerFailures]) })
    const cleanupFailures = await settle([...(server === undefined ? [] : [server.dispose()]), service.dispose(), transport.dispose(),
      ...[...remoteTransports.values()].map(remote => remote.dispose()),
      ...[...slots].reverse().flatMap(slot => slot.tools === undefined ? [] : [slot.tools.dispose()]),
      ...[...slots].reverse().map(slot => slot.provider.dispose()),
      ...[...declarations].reverse().map(declaration => declaration.dispose()), directory.dispose(), repository.dispose()])
    if (cleanupFailures.length > 0) throw new HostError('HOST_CLEANUP_FAILED', 'open-rollback-failed', {}, { cause: new AggregateError([cause, ...cleanupFailures]) })
    try { await storageLock.dispose() }
    catch (lockFailure) { throw new HostError('HOST_CLEANUP_FAILED', 'open-rollback-lock-failed', {}, { cause: new AggregateError([cause, lockFailure]) }) }
    throw cause
  }
}
