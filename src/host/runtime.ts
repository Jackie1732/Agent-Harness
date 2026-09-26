import { AgentJournal } from '../agent/journal.js'
import { bindParentSubagents } from './parent-subagents.js'
import { HostObservationTasks } from './observation-tasks.js'
import { projectAgentSession } from '../agent/projection.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Clock } from '../foundation/clock.js'
import { systemClock } from '../foundation/clock.js'
import type { SessionEventId, SessionAddress } from '../session/ids.js'
import type { AgentActionReference, AgentSendCommand } from '../agent/contract.js'
import type { OutboxMessageSnapshot } from '../communication/types.js'
import type { CommunicationError } from '../communication/errors.js'
import { isLocalHostMember } from './config.js'
import type { ResolvedHostSpec } from './config.js'
import { HostError } from './errors.js'
import { runHostScheduler } from './scheduler.js'
import type { HostSchedulerState } from './scheduler.js'
import type { HostRunReport, HostSlot } from './runtime-types.js'
import { assembleHost } from './assembly.js'
import type { HostAssembly } from './assembly.js'
import type { HostRuntimeBindings } from './slot.js'
import { nodeHostTimer } from './timer.js'
import type { HostTimer } from './timer.js'
import { observeHostMembers } from './report.js'
import { HostObservations } from './observation.js'
import { exportHostConfig } from './config-export.js'
import { workflowObserver } from './workflow-observer.js'

export type HostStatus = 'ready' | 'stopping' | 'stopped' | 'failed'
export type HostShutdownMode = 'drain' | 'cancel'
export interface OpenHostOptions {
  readonly clock?: Clock
  readonly timer?: HostTimer
  readonly credentials?: Readonly<Record<string, string>>
  readonly bindings?: HostRuntimeBindings
}
export interface HostInputReceipt { readonly agentKey: string; readonly eventId: SessionEventId }
const hostTasks = new AsyncLocalStorage<ReadonlySet<symbol>>()

/** Public facade exposes operations and observations, never the owned handles. */
class HostRuntime {
  readonly #spec: ResolvedHostSpec
  readonly #clock: Clock
  readonly #timer: HostTimer
  readonly #assembly: HostAssembly
  readonly #fingerprint: string
  readonly #inputs: Map<string, AgentJournal>
  readonly #paused = new Set<string>()
  readonly #routingPaused = new Set<string>()
  readonly #offline = new Set<string>()
  readonly #mailboxTransitions = new Map<string, Promise<void>>()
  readonly #blockedRoutes = new Set<string>()
  readonly #lifetime = new AbortController()
  readonly #wake = new AbortController()
  readonly #tokens = new Set<symbol>()
  readonly #operations = new Set<Promise<unknown>>()
  readonly #observers = new HostObservationTasks()
  readonly #scheduler: HostSchedulerState = {
    cursor: 0, protocolNext: true, protocolCursor: 0, laneOrder: ['delivery', 'maintenance', 'business'], memberCursors: { delivery: 0, maintenance: 0, business: 0 },
    faults: new Set(), stalled: new Map(), cooldowns: new Map(), observations: new HostObservations(),
  }
  #status: HostStatus = 'ready'
  #activity: Promise<HostRunReport> | undefined
  #command: Promise<unknown> | undefined
  #shutdownTask: Promise<void> | undefined
  #shutdownMode: HostShutdownMode | undefined
  #stoppingAt: number | undefined

  constructor(spec: ResolvedHostSpec, clock: Clock, timer: HostTimer, assembly: HostAssembly) {
    this.#spec = spec; this.#clock = clock; this.#timer = timer; this.#assembly = assembly
    this.#fingerprint = exportHostConfig(spec).fingerprint
    this.#inputs = new Map(assembly.local.map(({ member, session }) => [member.agentKey, new AgentJournal(session, member.spec.limits.maxJournalConflicts, clock)]))
    for (const key of assembly.subagents?.suspendedParents ?? []) this.#paused.add(key)
    for (const member of spec.members.filter(isLocalHostMember)) if (!member.enabled) {
      this.#offline.add(member.agentKey); this.#paused.add(member.agentKey)
    }
  }
  get status(): HostStatus { return this.#status }
  get instanceId(): string { return this.#assembly.lock.record.instanceId }

  /** Bind explicit Host control to an existing configured parent root. */
  bindParent(parentAddress: SessionAddress, parentRoot: SessionEventId) {
    this.#assertReady()
    const parent = this.#assembly.slots.find(slot => slot.session.header.address === parentAddress && this.#assembly.local.some(item => item.session === slot.session))
    const domain = this.#assembly.subagents
    if (parent === undefined || this.#offline.has(parent.member.agentKey) || domain === undefined || !domain.options.config.parents.some(item => item.agentKey === parent.member.agentKey)
      || !projectAgentSession(parent.session.snapshot()).roots.some(root => root.id === parentRoot)) throw new HostError('HOST_NOT_READY', 'parent-control-not-authorized')
    return bindParentSubagents({ domain, parent, root: parentRoot, timer: this.#timer, scanIntervalMs: this.#spec.scheduling.scanIntervalMs,
      ...this.#observers.bind(parent.member.agentKey, task => this.#track(task)),
      assertReady: () => this.#assertReady(), assertExternalWait: () => {
        if ([...hostTasks.getStore() ?? []].some(token => this.#tokens.has(token))) throw new HostError('HOST_REENTRANT_WAIT', 'parent-cannot-wait-on-own-business-lane')
      }, track: task => this.#track(task), wake: () => this.#assembly.wakeup.notify() })
  }
  /** Bind operator access to one fixed coordinator without starting its driver. */
  workflow(workflowKey: string) {
    this.#assertReady()
    const domain = this.#assembly.workflows
    if (domain === undefined) throw new HostError('HOST_NOT_READY', 'workflows-disabled')
    domain.report(workflowKey)
    const wait = workflowObserver(domain, workflowKey, this.#timer, this.#spec.scheduling.scanIntervalMs,
      this.#observers.bind(`workflow:${workflowKey}`, task => this.#track(task)), () => {
        this.#assertReady()
        if ([...hostTasks.getStore() ?? []].some(token => this.#tokens.has(token))) throw new HostError('HOST_REENTRANT_WAIT', 'workflow-cannot-wait-on-own-driver')
      })
    const control = (kind: 'pause' | 'resume' | 'cancel', input: { readonly requestKey: string; readonly reason?: string }) => this.#track(async () => {
      this.#assertReady()
      const result = await domain.control(workflowKey, kind, input)
      this.#assembly.wakeup.notify()
      return result
    })
    return Object.freeze({ report: () => domain.report(workflowKey), readArtifact: (reference: unknown) => domain.readArtifact(workflowKey, reference), wait,
      pause: (input: { readonly requestKey: string; readonly reason?: string }) => control('pause', input),
      cancel: (input: { readonly requestKey: string; readonly reason?: string }) => control('cancel', input),
      resume: (input: { readonly requestKey: string; readonly reason?: string }) => control('resume', input) })
  }

  delegationReport() {
    return this.#assembly.subagents?.report(this.#spec.scheduling.maxReportEntries) ?? { count: 0, unresolved: 0, blocked: 0, failed: 0, active: 0, nextDeadline: null, delegations: [], truncated: false }
  }

  /** Persist a user task without implicitly starting inference. */
  submitTask(agentKey: string, text: string, originLabel = 'host-user'): Promise<HostInputReceipt> {
    this.#slot(agentKey)
    return this.#track(async () => {
      const accepted = await this.#inputs.get(agentKey)!.acceptInput({ kind: 'task', text, originLabel })
      this.#assembly.wakeup.notify()
      return Object.freeze({ agentKey, eventId: accepted.stored.eventId })
    })
  }
  /** Persist an answer for one exact durable wait. */
  submitAnswer(agentKey: string, wait: AgentActionReference, text: string, originLabel = 'host-user'): Promise<HostInputReceipt> {
    this.#slot(agentKey)
    return this.#track(async () => {
      const accepted = await this.#inputs.get(agentKey)!.acceptInput({ kind: 'answer', wait, text, originLabel })
      this.#assembly.wakeup.notify()
      return Object.freeze({ agentKey, eventId: accepted.stored.eventId })
    })
  }
  /** Stop new business turns; receipt, maintenance and delivery remain enabled. */
  pause(agentKey: string): void {
    const slot = this.#slot(agentKey); this.#paused.add(agentKey); slot.agent.pause()
  }
  /** Explicit resumption also rechecks a slot stopped for lack of domain progress. */
  resume(agentKey: string) {
    this.#slot(agentKey)
    const resumed = this.#assembly.subagents?.resume(agentKey) ?? []
    if (resumed.every(item => item.status === 'resumed')) this.#paused.delete(agentKey)
    this.#scheduler.stalled.delete(agentKey)
    this.#assembly.wakeup.notify()
    return resumed
  }
  /** Change outbound admission independently of business execution. */
  pauseRouting(agentKey: string): void { this.#slot(agentKey); this.#routingPaused.add(agentKey) }
  resumeRouting(agentKey: string): void { this.#slot(agentKey); this.#routingPaused.delete(agentKey); this.#assembly.wakeup.notify() }

  /** Detach a mailbox after its accepted work settles; reattachment constructs fresh slot owners. */
  setMailboxOnline(agentKey: string, online: boolean, mode: HostShutdownMode = 'drain'): Promise<void> {
    this.#assertReady()
    const slot = this.#assembly.slots.find(slot => slot.member.agentKey === agentKey)
    if (!this.#assembly.local.some(entry => entry.member.agentKey === agentKey)) throw new HostError('HOST_NOT_READY', 'agent-slot-unavailable')
    if (this.#mailboxTransitions.has(agentKey)) throw new HostError('HOST_BUSY', 'mailbox-transition-active')
    if (online === !this.#offline.has(agentKey)) return Promise.resolve()
    if (!online) { this.#offline.add(agentKey); this.#paused.add(agentKey); slot?.agent.pause(); this.#assembly.subagents?.stopParent(agentKey) }
    const observers = online ? undefined : this.#observers.closeParent(agentKey)
    const task = this.#track(async () => {
      if (online) {
        const replacement = await this.#assembly.reopen(agentKey)
        const index = slot === undefined ? -1 : this.#assembly.slots.indexOf(slot)
        if (index < 0) this.#assembly.slots.push(replacement)
        else this.#assembly.slots[index] = replacement
        this.#offline.delete(agentKey); this.#scheduler.stalled.delete(agentKey)
        this.#scheduler.faults.delete(agentKey)
        this.#assembly.wakeup.notify()
      } else if (slot !== undefined) {
        await observers
        await this.#assembly.subagents?.releaseParent(agentKey)
        if (mode === 'drain') await slot.agent.wait()
        await slot.dispose()
      }
    })
    this.#mailboxTransitions.set(agentKey, task)
    void task.then(() => this.#mailboxTransitions.delete(agentKey), () => { this.#mailboxTransitions.delete(agentKey); this.#scheduler.faults.add(agentKey) })
    return task
  }

  /** Notify an active root immediately, then join its durable cancellation. */
  cancel(agentKey: string, root: SessionEventId, reason = 'host-cancelled') {
    const slot = this.#slot(agentKey)
    this.#assembly.subagents?.notifyParentStop(agentKey, root)
    return this.#track(() => slot.agent.cancel(root, reason))
  }
  /** Send commands share the single business lane with Host drivers. */
  sendMessage(agentKey: string, command: AgentSendCommand) {
    const slot = this.#slot(agentKey)
    if (this.#activity !== undefined || this.#command !== undefined) throw new HostError('HOST_BUSY', 'host-business-active')
    const task = this.#track(() => slot.agent.sendMessage(command))
    this.#command = task
    void task.then(() => { this.#command = undefined }, () => { this.#command = undefined })
    return task
  }

  /** Admit at most maxBatchesPerRun domain tasks, joining every accepted task. */
  run(options: { readonly signal?: AbortSignal } = {}): Promise<HostRunReport> { return this.#drive(false, options.signal) }
  /** Keep scanning until explicit cancellation or Host shutdown. */
  serve(options: { readonly signal?: AbortSignal } = {}): Promise<HostRunReport> { return this.#drive(true, options.signal) }

  report() {
    return Object.freeze({ status: this.#status, shutdownMode: this.#shutdownMode ?? null, hostKey: this.#spec.hostKey, instanceId: this.instanceId,
      configVersion: this.#spec.schemaVersion, configFingerprint: this.#fingerprint, configuredMembers: this.#spec.members.length,
      remoteMembers: this.#spec.members.filter(member => member.kind === 'remote').length,
      unfinishedOperations: this.#operations.size,
      shutdownOverdue: this.#status === 'stopping' && this.#stoppingAt !== undefined && this.#timer.now() - this.#stoppingAt >= this.#spec.shutdown.diagnosticAfterMs,
      blockedRoutes: Object.freeze([...this.#blockedRoutes]),
      ...observeHostMembers(this.#assembly.slots.filter(slot => this.#assembly.local.some(item => item.session === slot.session)), this.#paused, this.#scheduler.faults, this.#clock, this.#spec.scheduling.maxReportEntries, this.#scheduler.observations, this.#assembly, this.#routingPaused) })
  }

  /** Close admission synchronously; repeated calls join one task and drain can upgrade to cancel. */
  shutdown(options: { readonly mode?: HostShutdownMode } = {}): Promise<void> {
    const mode = options.mode ?? this.#spec.shutdown.mode
    if (this.#shutdownTask === undefined) {
      this.#status = 'stopping'; this.#shutdownMode = mode
      this.#assembly.subagents?.closeAdmission()
      this.#assembly.workflows?.closeAdmission()
      this.#stoppingAt = this.#timer.now()
      const closingToken = Symbol('Host release')
      this.#tokens.add(closingToken)
      const closingChain = new Set(hostTasks.getStore()); closingChain.add(closingToken)
      // Publish before any Abort listener or resource callback can reenter.
      this.#shutdownTask = hostTasks.run(closingChain, () => Promise.resolve().then(async () => {
        await Promise.allSettled([...this.#operations, ...(this.#activity === undefined ? [] : [this.#activity])])
        try { await this.#assembly.dispose(); this.#status = 'stopped' }
        catch (cause) {
          this.#status = 'failed'
          throw new HostError('HOST_CLEANUP_FAILED', 'host-resources-retained', {}, { cause })
        }
      }).finally(() => this.#tokens.delete(closingToken)))
      void this.#shutdownTask.catch(() => undefined)
      this.#observers.close()
      for (const slot of this.#assembly.slots) if (slot.agent.status === 'accepting') slot.agent.pause()
      this.#assembly.server?.stopAdmission()
      this.#wake.abort()
    }
    if (mode === 'cancel' && this.#status === 'stopping') { this.#shutdownMode = 'cancel'; this.#lifetime.abort() }
    if ([...hostTasks.getStore() ?? []].some(token => this.#tokens.has(token))) throw new HostError('HOST_REENTRANT_WAIT', 'host-task-cannot-join-shutdown')
    return this.#shutdownTask
  }

  /** Disposal always requests cooperative cancellation and shares shutdown settlement. */
  dispose(): Promise<void> { return this.shutdown({ mode: 'cancel' }) }

  #drive(continuous: boolean, external?: AbortSignal): Promise<HostRunReport> {
    this.#assertReady()
    if (this.#activity !== undefined || this.#command !== undefined) throw new HostError('HOST_BUSY', 'host-driver-active')
    const signal = external === undefined ? this.#lifetime.signal : AbortSignal.any([external, this.#lifetime.signal])
    const task = this.#track(async () => {
      let report: HostRunReport
      do {
        const notified = this.#assembly.wakeup.scan()
        report = await runHostScheduler({ slots: this.#assembly.slots, paused: this.#paused, routingPaused: this.#routingPaused, offline: this.#offline,
          scheduling: this.#spec.scheduling, clock: this.#clock, timer: this.#timer, signal, wakeSignal: this.#wake.signal,
          isStopping: () => this.#status !== 'ready', canAttempt: message => this.#canAttempt(message),
          blockRoute: error => this.#blockRoute(error), blockedRoutes: () => [...this.#blockedRoutes], state: this.#scheduler,
          scanWake: () => this.#assembly.wakeup.scan(), assembly: this.#assembly })
        if (!continuous || signal.aborted || this.#status !== 'ready') return report
        await this.#timer.wait(this.#spec.scheduling.scanIntervalMs, AbortSignal.any([signal, this.#wake.signal, notified]))
      } while (this.#status === 'ready' && !signal.aborted)
      return report
    })
    this.#activity = task
    void task.then(() => { this.#activity = undefined }, () => { this.#activity = undefined })
    return task
  }
  #track<T>(operation: () => Promise<T>): Promise<T> {
    const token = Symbol('Host task')
    this.#tokens.add(token)
    const chain = new Set(hostTasks.getStore()); chain.add(token)
    const task = hostTasks.run(chain, () => Promise.resolve().then(operation))
    this.#operations.add(task)
    const settled = () => { this.#operations.delete(task); this.#tokens.delete(token) }
    void task.then(settled, settled)
    return task
  }
  #canAttempt(message: OutboxMessageSnapshot): boolean {
    if (this.#blockedRoutes.has(message.envelope.recipient)) return false
    if (this.#assembly.remoteRecipients.has(message.envelope.recipient)) return true
    const kind = this.#assembly.directory.status(message.envelope.recipient).kind
    return kind === 'online' || kind === 'ended'
  }
  #blockRoute(error: CommunicationError): boolean {
    const recipient = error.details?.recipient
    if (error.code !== 'MESSAGE_TRANSPORT_SOURCE_INVALID' || typeof recipient !== 'string'
      || ![...this.#assembly.remoteRecipients].some(address => address === recipient)) return false
    this.#blockedRoutes.add(recipient); return true
  }
  #slot(agentKey: string): HostSlot {
    this.#assertReady()
    const slot = this.#assembly.slots.find(slot => slot.member.agentKey === agentKey)
    if (slot === undefined) throw new HostError('HOST_NOT_READY', 'agent-slot-unavailable', { agentKey })
    return slot
  }
  #assertReady(): void {
    if (this.#status !== 'ready') throw new HostError('HOST_INACTIVE', 'host-not-ready', { status: this.#status })
  }
}
export type AtomicHost = HostRuntime

/** Validate stored facts and complete assembly before exposing the Host facade. */
export async function openHost(spec: ResolvedHostSpec, options: OpenHostOptions = {}): Promise<AtomicHost> {
  const clock = options.clock ?? systemClock
  const credentials = Object.freeze({ ...options.credentials })
  for (const member of spec.members.filter(isLocalHostMember)) {
    if (options.bindings?.createModelProvider === undefined && member.enabled && member.model.kind !== 'scripted-fixed'
      && credentials[member.model.credentialRef] === undefined) throw new HostError('HOST_CONFIG_INVALID', 'model-credential-missing')
  }
  const assembly = await assembleHost(spec, clock, credentials, options.bindings ?? {})
  return new HostRuntime(spec, clock, options.timer ?? nodeHostTimer, assembly)
}
