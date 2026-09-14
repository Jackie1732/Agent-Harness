import type { Scope } from '../extension/types.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { CommittedSessionEvent } from '../session/types.js'
import { boundedJson } from '../schema/bounded-json.js'
import type { ModelIntentReference } from '../model/contract.js'
import type { DirectToolRequest, ToolInvocationLimits, ToolPhase, ToolPolicy, ToolPolicyIdentity, ToolRequestedPayload, ToolSettlement } from './contract.js'
import { ToolError } from './errors.js'
import { ownsToolTask, withToolTask } from './execution-context.js'
import { parseToolInvocationId, systemToolIdentitySource } from './ids.js'
import type { ToolIdentitySource } from './ids.js'
import { runToolInvocation } from './invocation.js'
import { projectToolSession } from './projection.js'
import type { ToolSessionSnapshot } from './projection.js'
import { borrowTool, ToolRegistry } from './registry.js'
import { decodeRequested, toolSessionEventDefinitions } from './session-events.js'
import { readIntentReference, readModelIntent, sourceKey } from './source.js'
import { exact, integer, object, readLimits, safeCode, toolName } from './validation.js'

export interface SessionToolRunnerOptions {
  readonly session: SessionHandle
  readonly registry: ToolRegistry
  readonly scope: Scope
  readonly policy: ToolPolicy
  readonly limits: ToolInvocationLimits
  readonly identity?: ToolIdentitySource
}
export type ToolRunnerStatus = 'accepting' | 'disposing' | 'faulted' | 'disposed'
interface Task { readonly token: symbol; readonly promise: Promise<CommittedSessionEvent<ToolSettlement>>; readonly controller: AbortController }

/** A borrowed Session entry point. dispose never ends the Session or releases its Writer. */
export class SessionToolRunner {
  readonly #session: SessionHandle
  readonly #registry: ToolRegistry
  readonly #scope: Scope
  readonly #limits: ToolInvocationLimits
  readonly #identity: ToolIdentitySource
  readonly #policy: Pick<ToolPolicy, 'decide'>
  readonly #policySignal: AbortSignal
  readonly #policyIdentity: ToolPolicyIdentity
  readonly #controller = new AbortController()
  #status: ToolRunnerStatus = 'accepting'
  #phase: ToolPhase = 'selection'
  #active: Task | undefined
  #disposeTask: Promise<void> | undefined
  #failure: ToolError | undefined
  #cleanupFailure: ToolError | undefined

  constructor(options: SessionToolRunnerOptions) {
    this.#session = options.session
    this.#registry = options.registry
    this.#scope = options.scope
    this.#limits = readLimits(options.limits)
    this.#identity = options.identity ?? systemToolIdentitySource
    const policy = options.policy
    if (policy === null || typeof policy !== 'object' || typeof policy.decide !== 'function'
      || !(policy.signal instanceof AbortSignal)) throw new ToolError('TOOL_POLICY_INVALID', 'an explicit lifecycle-bound policy is required')
    try { this.#policyIdentity = Object.freeze({ policyId: safeCode(policy.policyId), version: integer(policy.version) }) }
    catch { throw new ToolError('TOOL_POLICY_INVALID', 'policy identity is invalid') }
    this.#policy = Object.freeze({ decide: policy.decide.bind(policy) })
    this.#policySignal = policy.signal
    if (!toolSessionEventDefinitions.every(definition => this.#session.supportsEventDefinition(definition))) {
      throw new ToolError('TOOL_SESSION_CATALOG_INCOMPATIBLE', 'Session must own all four exact tool event definitions')
    }
    projectToolSession(this.#session.snapshot())
  }

  get status(): ToolRunnerStatus { return this.#status }
  get phase(): ToolPhase { return this.#phase }
  /** Safe retained infrastructure failure, including after dispose. */
  get failure(): ToolError | undefined { return this.#failure }
  snapshot(): ToolSessionSnapshot { return projectToolSession(this.#session.snapshot()) }

  /** Start one explicit direct request. Input is copied before the first asynchronous yield. */
  invoke(request: DirectToolRequest, options: { readonly signal?: AbortSignal } = {}): Promise<CommittedSessionEvent<ToolSettlement>> {
    this.#assertAccepting(options.signal)
    return this.#launch(options.signal, () => {
      const copy = object(boundedJson(request, { maxBytes: this.#limits.maxRequestBytes,
        maxDepth: Math.min(128, this.#limits.maxJsonDepth + 1), maxNodes: this.#limits.maxJsonNodes + 3 }))
      exact(copy, ['name', 'input'])
      const name = toolName(copy.name)
      const input = boundedJson(copy.input, { maxBytes: this.#limits.maxArgumentsBytes,
        maxDepth: this.#limits.maxJsonDepth, maxNodes: this.#limits.maxJsonNodes })
      return { name, source: { kind: 'direct' }, arguments: { kind: 'json', value: input } }
    })
  }

  /** Resolve only a local durable Model CP2. A previously settled source is a read, not reauthorization. */
  invokeModelIntent(reference: ModelIntentReference, options: { readonly signal?: AbortSignal } = {}): Promise<CommittedSessionEvent<ToolSettlement>> {
    const checked = readIntentReference(reference)
    const key = `${checked.invocationId}:${checked.outputBlockIndex}`
    const view = this.snapshot()
    const prior = view.invocations.find(item => sourceKey(item.requested.payload.source) === key)
    if (prior?.state === 'settled') return Promise.resolve(prior.settled)
    if (prior !== undefined) throw new ToolError('TOOL_SESSION_BUSY', 'model intent already has pending tool work')
    this.#assertAccepting(options.signal)
    return this.#launch(options.signal, () => {
      const source = readModelIntent(this.#session.snapshot(), checked)
      return { name: source.block.name, source: source.source, arguments: { kind: 'text', text: source.block.argumentsText } }
    })
  }

  /** Stop admission synchronously, request cancellation, and await the same full task on repeated calls. */
  dispose(): Promise<void> {
    if (this.#disposeTask === undefined) {
      this.#status = 'disposing'
      const task = this.#active?.promise
      this.#disposeTask = Promise.resolve().then(async () => {
        if (task !== undefined) await task.catch(() => undefined)
        this.#status = 'disposed'
        if (this.#cleanupFailure !== undefined) throw this.#cleanupFailure
      })
      void this.#disposeTask.catch(() => undefined)
      this.#controller.abort()
      this.#active?.controller.abort()
    }
    if (this.#active !== undefined && ownsToolTask(this.#active.token)) {
      return Promise.reject(new ToolError('TOOL_REENTRANT_WAIT', 'tool task cannot await its owning runner disposal'))
    }
    return this.#disposeTask
  }

  #assertAccepting(signal: AbortSignal | undefined): void {
    if (signal !== undefined && !(signal instanceof AbortSignal)) throw new ToolError('TOOL_REQUEST_INVALID', 'cancellation must be an AbortSignal')
    if (this.#status !== 'accepting' || this.#session.status !== 'open' || this.#scope.status !== 'accepting'
      || this.#scope.signal.aborted || this.#policySignal.aborted || this.#session.snapshot().lifecycle !== 'active') {
      throw new ToolError('TOOL_RUNNER_INACTIVE', 'tool runner or a borrowed lifecycle is not accepting')
    }
    if (signal?.aborted) throw new ToolError('TOOL_CANCELLED', 'tool request was cancelled before acceptance')
    if (this.#active !== undefined) throw new ToolError('TOOL_SESSION_BUSY', 'tool runner already has an active task')
  }

  #launch(signal: AbortSignal | undefined, capture: () => Pick<ToolRequestedPayload, 'name' | 'source' | 'arguments'>): Promise<CommittedSessionEvent<ToolSettlement>> {
    let resolve!: (result: CommittedSessionEvent<ToolSettlement>) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<CommittedSessionEvent<ToolSettlement>>((yes, no) => { resolve = yes; reject = no })
    const token = Symbol('tool invocation')
    const controller = new AbortController()
    const task: Task = { token, controller, promise }
    this.#active = task
    // Publish the managed task before calling an identity source, provider, or policy.
    void promise.then(() => this.#finished(task), reason => this.#finished(task, reason))
    try {
      withToolTask(token, () => {
        const captured = capture()
        const invocationId = parseToolInvocationId(this.#identity.nextInvocationId())
        const borrow = borrowTool(this.#registry, captured.name, token, promise, () => controller.abort())
        const combined = AbortSignal.any([this.#controller.signal, controller.signal, this.#scope.signal,
          this.#policySignal, ...(signal === undefined ? [] : [signal]), ...(borrow === undefined ? [] : [borrow.signal])])
        const request = decodeRequested({ ...captured, invocationId, limits: this.#limits,
          selection: borrow === undefined ? { kind: 'missing' } : { kind: 'resolved', definition: borrow.definition, provider: borrow.descriptor } })
        void Promise.resolve().then(() => withToolTask(token, () => runToolInvocation({
          session: this.#session, request, borrow, policy: this.#policy, policyIdentity: this.#policyIdentity,
          signal: combined, stop: () => controller.abort(), phase: value => { this.#phase = value },
        }))).then(resolve, reject)
      })
    } catch (reason) { reject(reason instanceof ToolError ? reason : new ToolError('TOOL_REQUEST_INVALID', 'tool request is not valid bounded JSON')) }
    return promise
  }

  #finished(task: Task, reason?: unknown): void {
    if (this.#active === task) this.#active = undefined
    if (reason instanceof ToolError && [
      'TOOL_JOURNAL_COMMIT_UNKNOWN', 'TOOL_JOURNAL_WRITE_FAILED', 'TOOL_SESSION_CHANGED',
      'TOOL_STATE_INVALID', 'TOOL_CLEANUP_FAILED', 'TOOL_POLICY_INVALID', 'TOOL_BINDING_MISMATCH', 'TOOL_PROVIDER_INVALID',
    ].includes(reason.code)) {
      this.#failure = reason
      if (reason.code === 'TOOL_CLEANUP_FAILED' || reason.details?.cleanupIncomplete === true) {
        this.#cleanupFailure = new ToolError('TOOL_CLEANUP_FAILED', 'tool runner retains incomplete cleanup', reason.details)
      }
      if (this.#status === 'accepting') this.#status = 'faulted'
      this.#controller.abort()
    }
  }
}
