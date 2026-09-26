import { AsyncLocalStorage } from 'node:async_hooks'
import { clockTimestamp } from '../foundation/clock.js'
import { projectCommunicationFacts } from '../communication/projection.js'
import type { SessionEventId } from '../session/ids.js'
import { assertAgentExecutionQuiescent } from './execution-health.js'
import type { AgentInput, AgentInputReference, AgentSendCommand, AgentSpec, AgentRunSelection } from './contract.js'
import type { SessionAgentOptions, AgentRuntime, AgentTurnControl } from './runtime-contract.js'
import { decodeRunSelection } from './event-codec.js'
import { workAssignmentAcceptedEvent, sameWorkflowValue } from '../workflow/work-binding.js'
import { AgentError } from './errors.js'
import { AgentJournal } from './journal.js'
import { decodeAgentSpec, decodeSubagentAgentSpec, decodeWorkflowAgentSpec } from './spec-codec.js'
import { decodeAgentInput, decodeAgentCommand, referenceKey, inputReference } from './input-codec.js'
import { projectAgentSession } from './projection.js'
import { projectAgentReport } from './report.js'
import type { AgentRunReport } from './report.js'
import { selectAgentInput } from './scheduling.js'
import { driveAgentTurn } from './turn-driver.js'
import { executeAgentSend } from './action-driver.js'
import { manageAgentWaits, settleAgentStops, synchronizeAgentReceipts } from './management.js'
import { inspectAgentReadiness } from './readiness.js'
import { expireAgentRoot } from './root-policy.js'
import * as events from './session-events.js'
import { subagentSessionEventDefinitions } from '../subagent/session-events.js'
import { subagentContextProfileRecordedEvent, subagentContextAssemblyCommittedEvent, workflowContextProfileRecordedEvent, workflowContextAssemblyCommittedEvent } from '../context/session-events.js'

const driverTask = new AsyncLocalStorage<ReadonlySet<symbol>>()

/** Local lifecycle owner; cross-instance ownership is exclusively the durable open Run. */
export class SessionAgent {
  #runtime: AgentRuntime
  #ownsMailbox = false
  #token: symbol | undefined
  #status: 'accepting' | 'disposing' | 'disposed' | 'faulted' = 'accepting'
  #desired: 'continue' | 'pause' = 'continue'
  #task: Promise<AgentRunReport> | undefined
  #taskKind: 'drive' | 'command' | 'maintenance' | undefined
  #selection: AgentRunSelection | undefined
  #ownedRun: SessionEventId | null = null
  #failure: AgentError | undefined
  #driveController: AbortController | undefined
  #turn: AgentTurnControl | undefined
  #endTask: ReturnType<SessionAgentOptions['session']['end']> | undefined
  #disposeTask: Promise<void> | undefined
  readonly #operations = new Set<Promise<unknown>>()

  constructor(options: SessionAgentOptions) {
    const state = projectAgentSession(options.session.snapshot())
    if (options.communication !== undefined && (options.mailbox !== undefined || options.dispatcher !== undefined)) throw new AgentError('AGENT_SPEC_INVALID', 'communication-owner-conflict')
    if (state.spec === null) throw new AgentError('AGENT_SPEC_INVALID', 'spec-not-installed')
    if (options.model.limits.maxToolCalls > 64 || options.model.limits.maxToolCalls * 256 + 4096 > options.session.maxRecordBytes) {
      throw new AgentError('AGENT_LIMIT_EXCEEDED', 'model-intent-settlement-budget')
    }
    if (options.model.snapshot().sessionId !== options.session.header.sessionId || options.context.snapshot().sessionId !== options.session.header.sessionId
      || options.tools !== undefined && options.tools.snapshot().sessionId !== options.session.header.sessionId
      || options.mailbox !== undefined && options.mailbox.sessionId !== options.session.header.sessionId) throw new AgentError('AGENT_SOURCE_INVALID', 'borrowed-session-mismatch')
    const executionEvents = events.agentExecutionEvents(state.spec.payload.protocolVersion)
    if (Object.values(executionEvents).some(definition => !options.session.supportsEventDefinition(definition))) throw new AgentError('AGENT_CATALOG_INCOMPATIBLE', 'execution-events-required')
    if (state.spec.payload.protocolVersion !== 1 && [...subagentSessionEventDefinitions, subagentContextProfileRecordedEvent, subagentContextAssemblyCommittedEvent]
      .some(definition => !options.session.supportsEventDefinition(definition))) throw new AgentError('AGENT_CATALOG_INCOMPATIBLE', 'delegation-events-required')
    if (state.spec.payload.protocolVersion === 3 && [workflowContextProfileRecordedEvent, workflowContextAssemblyCommittedEvent, workAssignmentAcceptedEvent]
      .some(definition => !options.session.supportsEventDefinition(definition))) throw new AgentError('AGENT_CATALOG_INCOMPATIBLE', 'workflow-events-required')
    this.#runtime = { ...options, events: executionEvents, journal: new AgentJournal(options.session, state.spec.payload.limits.maxJournalConflicts, options.clock) }
  }
  get status() { return this.#status }
  get failure() { return this.#failure }
  snapshot() { return projectAgentSession(this.#runtime.session.snapshot()) }
  report(): AgentRunReport { return projectAgentReport(this.#runtime.session.snapshot()) }
  readiness(observedAt = clockTimestamp(this.#runtime.clock)) {
    return inspectAgentReadiness(this.#runtime.session.snapshot(), this.#runtime.messageCatalog, observedAt)
  }

  /** Acceptance persists a copied input; it does not start or interrupt a Turn. */
  submitInput(value: AgentInput) {
    this.#accepting()
    const input = decodeAgentInput(value)
    return this.#track(this.#runtime.journal.append(events.agentInputAcceptedEvent, state => ({ spec: state.spec!.stored.eventId, input })))
  }

  /** Drive bounded work. Concurrent calls on this instance join its current drive, with no new cancellation authority. */
  start(options: { readonly signal?: AbortSignal; readonly selection?: AgentRunSelection } = {}): Promise<AgentRunReport> {
    this.#accepting()
    if (this.#isReentrant()) throw new AgentError('AGENT_REENTRANT_WAIT', 'driver-cannot-join-itself')
    const selection = decodeRunSelection(options.selection ?? { kind: 'ordinary' })
    if (selection.kind === 'workflow' && this.snapshot().spec!.payload.protocolVersion !== 3) throw new AgentError('AGENT_SPEC_INVALID', 'workflow-requires-v3')
    if (this.#task !== undefined) {
      if (this.#taskKind !== 'drive') throw new AgentError('AGENT_BUSY', 'command-active')
      if (!sameWorkflowValue(this.#selection!, selection)) throw new AgentError('AGENT_BUSY', 'different-run-selection')
      return this.#task
    }
    if (options.signal?.aborted === true) throw new AgentError('AGENT_CANCELLED', 'run-cancelled-before-admission')
    this.#desired = 'continue'
    this.#driveController = new AbortController()
    const signals = [this.#driveController.signal, options.signal, this.#runtime.signal, this.#runtime.scope?.signal].filter((value): value is AbortSignal => value !== undefined)
    this.#selection = selection
    return this.#launch('drive', () => this.#drive(AbortSignal.any(signals), selection))
  }
  /** Stop claiming inputs after the current Turn reaches its durable checkpoint. */
  pause(): void { this.#accepting(); this.#desired = 'pause' }
  wait(): Promise<AgentRunReport> {
    if (this.#isReentrant() && this.#task !== undefined) throw new AgentError('AGENT_REENTRANT_WAIT', 'driver-cannot-join-itself')
    return this.#task ?? Promise.resolve(this.report())
  }

  /** Perform bounded management work without admitting a Turn, Model, Tool or send command. */
  maintain(options: { readonly signal?: AbortSignal } = {}): Promise<AgentRunReport> {
    this.#accepting()
    if (this.#isReentrant()) throw new AgentError('AGENT_REENTRANT_WAIT', 'driver-cannot-join-itself')
    if (this.#task !== undefined) {
      if (this.#taskKind !== 'maintenance') throw new AgentError('AGENT_BUSY', 'driver-active')
      return this.#task
    }
    if (options.signal?.aborted === true) throw new AgentError('AGENT_CANCELLED', 'maintenance-cancelled-before-admission')
    if (!this.readiness().canMaintain) return Promise.resolve(this.report())
    this.#driveController = new AbortController()
    const signal = AbortSignal.any([this.#driveController.signal, options.signal, this.#runtime.signal, this.#runtime.scope?.signal]
      .filter((value): value is AbortSignal => value !== undefined))
    return this.#launch('maintenance', async () => {
      assertAgentExecutionQuiescent(this.#runtime.session.snapshot())
      const run = await this.#runtime.journal.append(events.agentMaintenanceRunStartedEvent, state => ({
        spec: state.spec!.stored.eventId, kind: 'maintenance' as const,
      }))
      this.#ownedRun = run.stored.eventId
      const runtime: AgentRuntime = { ...this.#runtime, signal,
        management: { remaining: this.snapshot().spec!.payload.limits.maxManagementPerRun } }
      let stoppedBy: 'idle' | 'run-budget' | 'cancelled' = 'idle'
      if (signal.aborted) stoppedBy = 'cancelled'
      else {
        await manageAgentWaits(runtime)
        if (runtime.management!.remaining === 0) stoppedBy = 'run-budget'
        else if (runtime.signal?.aborted === true) stoppedBy = 'cancelled'
      }
      await runtime.journal.append(events.agentMaintenanceRunSettledEvent, () => ({
        run: run.stored.eventId, stoppedBy, reason: stoppedBy,
      }))
      return this.report()
    })
  }

  /** Observe one root deadline and notify its active Turn before persisting expiry. */
  expire(rootTurnId: SessionEventId): Promise<AgentRunReport> {
    this.#accepting()
    return this.#track((async () => {
      const root = this.snapshot().roots.find(item => item.id === rootTurnId)
      if (root === undefined) throw new AgentError('AGENT_SOURCE_INVALID', 'unknown-root')
      if (root.outcome !== null || root.stopControl !== null) return this.report()
      if (root.deadline > clockTimestamp(this.#runtime.clock)) return this.report()
      if (this.#turn?.root === rootTurnId) this.#turn.controller.abort()
      await expireAgentRoot(this.#runtime, rootTurnId)
      return this.report()
    })())
  }

  /** Notify only the current runtime Turn; the owning control protocol separately persists its request. */
  notifyStop(rootTurnId: SessionEventId): void { if (this.#turn?.root === rootTurnId) this.#turn.controller.abort() }

  /** Persist one root's stop request. A returned report may still show an executing action awaiting actual release. */
  cancel(rootTurnId: SessionEventId, reason = 'caller-cancelled'): Promise<AgentRunReport> {
    this.#accepting()
    return this.#track((async () => {
      const root = this.snapshot().roots.find(root => root.id === rootTurnId)
      if (root === undefined) throw new AgentError('AGENT_SOURCE_INVALID', 'unknown-root')
      if (root.outcome !== null) return this.report()
      if (this.#turn?.root === rootTurnId) this.#turn.controller.abort()
      if (root.stopControl === null) {
        try { await this.#runtime.journal.append(events.agentControlRequestedEvent, () => ({ kind: 'cancel-work' as const, root: rootTurnId, reason })) }
        catch (error) {
          const current = this.snapshot().roots.find(item => item.id === rootTurnId)!
          if (this.#runtime.journal.faulted || current.outcome === null && current.stopControl === null) throw error
        }
      }
      if (this.snapshot().openRun === null) await settleAgentStops(this.#runtime)
      return this.report()
    })())
  }

  /** Release a queued/review input explicitly; historical unknown execution and cleanup remain unchanged. */
  abandonInput(input: AgentInputReference, reason = 'caller-requested'): Promise<AgentRunReport> {
    this.#accepting()
    const copied = inputReference(input, this.snapshot().spec!.payload.protocolVersion)
    return this.#track((async () => {
      const control = await this.#runtime.journal.append(this.#runtime.events.abandonRequested, () => ({ kind: 'abandon-input' as const, input: copied, reason }))
      await this.#runtime.journal.append(events.agentControlSettledEvent, () => ({ control: control.stored.eventId, outcome: 'completed' as const,
        reason, rootOutcome: null, responseDisposition: null }))
      await synchronizeAgentReceipts(this.#runtime)
      return this.report()
    })())
  }

  /** Accept one quota-limited outbox command without a root task or automatic delivery. */
  sendMessage(value: AgentSendCommand): Promise<AgentRunReport> {
    this.#accepting()
    const command = decodeAgentCommand(value)
    if (this.#task !== undefined) throw new AgentError('AGENT_BUSY', 'driver-active')
    return this.#launch('command', async () => {
      let runtime = this.#runtime
      assertAgentExecutionQuiescent(runtime.session.snapshot())
      const run = await runtime.journal.append(events.agentBusinessEvents(this.snapshot().spec!.payload.protocolVersion).started, state => {
        if (state.openRun !== null) throw new AgentError('AGENT_BUSY', 'driver-active')
        return { spec: state.spec!.stored.eventId, kind: 'command' as const, ...(state.spec!.payload.protocolVersion === 3 ? { selection: { kind: 'ordinary' as const } } : {}) }
      })
      this.#ownedRun = run.stored.eventId
      await this.#attachCommunication(run.stored.eventId)
      runtime = this.#runtime
      const state = this.snapshot()
      if (state.commands.length >= state.spec!.payload.maxDirectSendCommandsPerSession) {
        await runtime.journal.append(events.agentBusinessEvents(this.snapshot().spec!.payload.protocolVersion).settled, () => ({ run: run.stored.eventId, stoppedBy: 'command-budget' as const, reason: 'direct-send-budget' })); return this.report()
      }
      const accepted = await runtime.journal.append(events.agentCommandAcceptedEvent, state => ({ run: run.stored.eventId, spec: state.spec!.stored.eventId, root: null, command }))
      const action = { eventId: accepted.stored.eventId, index: 0 }
      const result = await executeAgentSend(runtime, action, command)
      await runtime.journal.append(runtime.events.actionSettled, () => ({ action, result }))
      await runtime.journal.append(events.agentBusinessEvents(this.snapshot().spec!.payload.protocolVersion).settled, () => ({ run: run.stored.eventId, stoppedBy: 'command-settled' as const, reason: result.kind }))
      return this.report()
    })
  }

  /** Join this instance's current Turn and end only after all durable work and communication are settled. */
  endSession(reason = 'agent-ended') {
    if (this.#isReentrant()) throw new AgentError('AGENT_REENTRANT_WAIT', 'driver-cannot-end-itself')
    if (this.#endTask !== undefined) return this.#endTask
    this.#accepting()
    if (this.#taskKind === 'command') throw new AgentError('AGENT_BUSY', 'command-active')
    const task = (async () => {
      const control = await this.#runtime.journal.append(events.agentControlRequestedEvent, () => ({ kind: 'close-session' as const, reason }))
      try {
        if (this.#task !== undefined) await this.#task
        assertAgentExecutionQuiescent(this.#runtime.session.snapshot())
        const state = this.snapshot()
        if (state.openRun !== null || state.openRecovery !== null || state.roots.some(root => root.outcome === null)
          || state.controls.some(item => item.requested.stored.eventId !== control.stored.eventId && item.settled === null && item.supersededBy === null)
          || state.inputs.some(input => !['handled', 'abandoned', 'not-adopted'].includes(input.status))) throw new AgentError('AGENT_BUSY', 'session-has-work')
        await synchronizeAgentReceipts(this.#runtime)
        const mailbox = projectCommunicationFacts(this.#runtime.session.snapshot())
        if (mailbox.inbox.some(item => item.status === 'pending') || mailbox.outbox.some(item => item.status === 'pending')) throw new AgentError('AGENT_BUSY', 'communication-has-work')
        return this.#runtime.mailbox === undefined ? await this.#runtime.session.end(reason) : await this.#runtime.mailbox.endSession(reason)
      } catch (error) {
        if (this.#runtime.session.status === 'open' && this.#runtime.session.snapshot().lifecycle === 'active'
          && this.snapshot().openRun === null && this.snapshot().openRecovery === null) {
          await this.#runtime.journal.append(events.agentControlSettledEvent, () => ({ control: control.stored.eventId, outcome: 'rejected' as const,
            reason: 'session-end-not-accepted', rootOutcome: null, responseDisposition: null }))
        }
        throw error
      }
    })()
    this.#endTask = this.#track(task)
    void task.then(() => { this.#endTask = undefined }, () => { this.#endTask = undefined })
    return this.#endTask
  }

  /** Request cancellation and join owned resources; borrowed Session/Service/providers and durable waits survive. */
  dispose(): Promise<void> {
    if (this.#disposeTask !== undefined) {
      if (this.#isReentrant()) throw new AgentError('AGENT_REENTRANT_WAIT', 'driver-cannot-dispose-itself')
      return this.#disposeTask
    }
    this.#status = 'disposing'; this.#desired = 'pause'; this.#driveController?.abort(); this.#turn?.controller.abort()
    this.#disposeTask = (async () => {
      await Promise.allSettled([...this.#operations, ...(this.#task === undefined ? [] : [this.#task])])
      const results = await Promise.allSettled([this.#runtime.context.dispose(), this.#runtime.model.dispose(), ...(this.#runtime.tools === undefined ? [] : [this.#runtime.tools.dispose()]),
        ...(this.#ownsMailbox ? [this.#runtime.mailbox!.dispose()] : [])])
      this.#status = 'disposed'
      if (results.some(result => result.status === 'rejected')) {
        this.#failure ??= new AgentError('AGENT_CLEANUP_FAILED', 'owned-runner-release-failed')
        throw this.#failure
      }
    })()
    void this.#disposeTask.catch(() => { /* The shared task retains cleanup failure for external joiners. */ })
    if (this.#isReentrant()) throw new AgentError('AGENT_REENTRANT_WAIT', 'driver-cannot-dispose-itself')
    return this.#disposeTask
  }

  #isReentrant() { return this.#token !== undefined && driverTask.getStore()?.has(this.#token) === true }
  #fault(error: unknown) {
    if (this.#status === 'accepting') this.#status = 'faulted'
    this.#desired = 'pause'
    this.#driveController?.abort(); this.#turn?.controller.abort()
    this.#failure ??= error instanceof AgentError ? error : new AgentError('AGENT_RECOVERY_REQUIRED', 'driver-transition-incomplete')
  }
  #accepting() {
    if (this.#runtime.scope !== undefined && this.#runtime.scope.status !== 'accepting' || this.#endTask !== undefined || this.snapshot().closing !== null || this.#status !== 'accepting' || this.#runtime.signal?.aborted === true || this.#runtime.session.snapshot().lifecycle !== 'active') throw new AgentError('AGENT_INACTIVE', 'agent-not-accepting')
  }
  #track<T>(task: Promise<T>): Promise<T> {
    this.#operations.add(task)
    void task.then(() => this.#operations.delete(task), error => {
      this.#operations.delete(task)
      if (this.#status === 'accepting' && this.#runtime.journal.faulted) {
        this.#fault(error)
      }
    })
    return task
  }
  #launch(kind: 'drive' | 'command' | 'maintenance', operation: () => Promise<AgentRunReport>): Promise<AgentRunReport> {
    this.#token = Symbol('Agent task')
    const chain = new Set(driverTask.getStore()); chain.add(this.#token)
    const task = driverTask.run(chain, () => Promise.resolve().then(operation))
    this.#task = task
    this.#taskKind = kind
    void task.then(() => { this.#token = undefined; this.#task = undefined; this.#taskKind = undefined; this.#ownedRun = null; this.#driveController = undefined }, error => {
      this.#token = undefined
      this.#task = undefined
      this.#taskKind = undefined
      this.#driveController = undefined
      if (this.#runtime.journal.faulted || this.#ownedRun !== null && this.snapshot().openRun === this.#ownedRun) {
        this.#fault(error)
      }
    })
    return task
  }
  async #attachCommunication(run: SessionEventId): Promise<void> {
    const communication = this.#runtime.communication
    if (communication === undefined || this.#runtime.mailbox !== undefined) return
    try {
      const mailbox = await communication.service.attach(this.#runtime.session, { catalog: this.#runtime.messageCatalog, policy: communication.policy })
      this.#ownsMailbox = true
      this.#runtime = { ...this.#runtime, mailbox }
      this.#runtime = { ...this.#runtime, dispatcher: communication.service.createDispatcher(mailbox) }
    } catch {
      await this.#runtime.journal.append(events.agentBusinessEvents(this.snapshot().spec!.payload.protocolVersion).settled, () => ({ run, stoppedBy: 'faulted' as const, reason: 'mailbox-attach-failed' }))
      throw new AgentError('AGENT_COMMUNICATION_UNAVAILABLE', 'mailbox-attach-failed')
    }
  }
  async #drive(signal: AbortSignal, selection: AgentRunSelection): Promise<AgentRunReport> {
    let runtime: AgentRuntime = { ...this.#runtime, signal, management: { remaining: this.snapshot().spec!.payload.limits.maxManagementPerRun } }
    assertAgentExecutionQuiescent(runtime.session.snapshot())
    if (this.snapshot().openRun === null && this.snapshot().openRecovery === null) await settleAgentStops(runtime)
    if (runtime.management!.remaining === 0) return this.report()
    const run = await runtime.journal.append(events.agentBusinessEvents(this.snapshot().spec!.payload.protocolVersion).started, state => {
      if (state.openRun !== null) throw new AgentError('AGENT_BUSY', 'driver-active')
      return { spec: state.spec!.stored.eventId, kind: 'drive' as const, ...(state.spec!.payload.protocolVersion === 3 ? { selection } : {}) }
    })
    this.#ownedRun = run.stored.eventId
    if (!signal.aborted) await this.#attachCommunication(run.stored.eventId)
    runtime = { ...this.#runtime, signal, management: runtime.management! }
    const spec = this.snapshot().spec!.payload
    let dispatches = 0
    let stoppedBy: import('./contract.js').AgentRunStop = 'idle'
    for (let count = 0; count < (spec.protocolVersion === 3 ? 1 : spec.limits.maxTurnsPerRun); count++) {
      await manageAgentWaits(runtime)
      if (runtime.management!.remaining === 0) { stoppedBy = 'run-budget'; break }
      if (this.#desired === 'pause' || this.snapshot().closing !== null || this.#status !== 'accepting' || runtime.signal?.aborted === true) { stoppedBy = 'paused'; break }
      if (runtime.dispatcher !== undefined && runtime.mailbox?.snapshot().outbox.some(item => item.status === 'pending') === true
        && dispatches < spec.limits.maxDispatchRunsPerRun) { await runtime.dispatcher.dispatch({ signal }); dispatches++; await manageAgentWaits(runtime) }
      if (runtime.management!.remaining === 0) { stoppedBy = 'run-budget'; break }
      let candidate
      try { candidate = selectAgentInput(this.snapshot(), runtime.messageCatalog, selection) }
      catch (error) {
        if (!(error instanceof AgentError) || error.code !== 'AGENT_LIMIT_EXCEEDED') throw error
        stoppedBy = 'run-budget'; break
      }
      if (candidate === null) { stoppedBy = this.snapshot().waits.some(wait => wait.settled === null) ? 'waiting' : 'idle'; break }
      let turn
      try { turn = await runtime.journal.append(runtime.events.turnStarted, state => {
        const selected = selectAgentInput(state, runtime.messageCatalog, selection)
        if (selected === null) throw new AgentError('AGENT_BUSY', 'input-selection-changed')
        const wait = selected.reservedBy === null ? undefined : state.waits.find(wait => referenceKey(wait.reference) === referenceKey(selected.reservedBy!))
        const descriptor = wait?.created.payload.result.kind === 'wait' ? wait.created.payload.result.descriptor : undefined
        const root = descriptor === undefined ? undefined : state.roots.find(root => root.id === descriptor.root)
        const original = root === undefined ? selected : state.inputs.find(item => item.reference.eventId === state.turns.find(turn => turn.started.stored.eventId === root.id)!.started.payload.input.eventId)!
        const work = original.work
        return { ...(state.spec!.payload.protocolVersion === 3 ? { work: work === undefined ? null : { accepted: original.reference.eventId, assignment: work.assignment, allowance: work.value.effectiveAllowance, toolNames: work.value.toolNames, nativeActions: work.value.nativeActions } } : {}),
          ...(state.spec!.payload.protocolVersion !== 1 ? { protocolSource: selected.protocol?.inbox ?? selected.work?.inbox ?? null } : {}), run: run.stored.eventId, input: selected.reference, lane: selected.lane, ordinal: state.turns.length + 1,
          root: root?.id ?? null, predecessor: selected.reservedBy,
          deadline: root?.deadline ?? work?.value.deadline ?? (state.spec!.payload.protocolVersion !== 1 && state.spec!.payload.subagents.role === 'child' ? state.spec!.payload.subagents.deadline : null),
          observedAt: clockTimestamp(runtime.clock) }
      }) } catch (error) {
        if (error instanceof AgentError && error.code === 'AGENT_BUSY' && error.message.includes('input-selection-changed')) { stoppedBy = 'idle'; break }
        throw error
      }
      const controller = new AbortController()
      this.#turn = { root: turn.payload.root ?? turn.stored.eventId, controller }
      try { await driveAgentTurn(runtime, turn.stored.eventId, runtime.signal === undefined ? controller.signal : AbortSignal.any([controller.signal, runtime.signal])) }
      finally { this.#turn = undefined }
      try { assertAgentExecutionQuiescent(runtime.session.snapshot()) }
      catch (error) { this.#fault(error); stoppedBy = 'faulted'; break }
      stoppedBy = 'run-budget'
    }
    await settleAgentStops(runtime)
    await runtime.journal.append(events.agentBusinessEvents(this.snapshot().spec!.payload.protocolVersion).settled, () => ({ run: run.stored.eventId, stoppedBy, reason: stoppedBy }))
    await settleAgentStops(runtime)
    return this.report()
  }
}

/** Install a complete immutable Spec through the same compare-and-append admission as runtime events. */
export function installAgentSpec(session: SessionAgentOptions['session'], value: AgentSpec, clock: SessionAgentOptions['clock']) {
  const spec = value.protocolVersion === 3 ? decodeWorkflowAgentSpec(value) : value.protocolVersion === 2 ? decodeSubagentAgentSpec(value) : decodeAgentSpec(value)
  if (session.maxRecordBytes < 4096 || spec.limits.maxResultBytes + 4096 > session.maxRecordBytes) throw new AgentError('AGENT_LIMIT_EXCEEDED', 'minimum-settlement-budget')
  return new AgentJournal(session, spec.limits.maxJournalConflicts, clock).append(spec.protocolVersion === 3 ? events.workflowAgentSpecRecordedEvent : spec.protocolVersion === 2 ? events.subagentAgentSpecRecordedEvent : events.agentSpecRecordedEvent, () => spec)
}
