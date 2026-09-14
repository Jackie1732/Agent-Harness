import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import { snapshotJson } from '../foundation/json.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { ModelProvider, ModelRequest, ModelRunnerLimits, PreparedModelCall } from './contract.js'
import { jsonBytes, validateSettlementBudget } from './budget.js'
import { InvocationControl } from './control.js'
import { ModelError, providerFailureCode } from './errors.js'
import type { ModelErrorCode } from './errors.js'
import { parseModelInvocationId, systemModelIdentitySource } from './ids.js'
import type { ModelIdentitySource, ModelInvocationId } from './ids.js'
import { executeModelInvocation } from './invocation.js'
import { ModelJournal } from './journal.js'
import { projectModelSession } from './projection.js'
import type { ModelSessionSnapshot } from './projection.js'
import { snapshotModelRequest } from './request.js'
import type { ModelPreparedPayload } from './session-events.js'
import type { ModelSettlement } from './settlement.js'
import { decodePreparedSubmission } from './submission.js'
import { inheritsModelTask, inModelTask } from './task-context.js'

export interface SessionModelRunnerOptions {
  readonly session: SessionHandle
  readonly provider: ModelProvider
  readonly limits: ModelRunnerLimits
  readonly identities?: ModelIdentitySource
  /** Capture Component scope.signal here; Scope closes before Effect cleanup begins. */
  readonly signal?: AbortSignal
}

export interface ModelInvokeOptions {
  readonly signal?: AbortSignal
  readonly retryOf?: ModelInvocationId
}

export type ModelRunnerStatus = 'accepting' | 'disposing' | 'faulted' | 'disposed'

interface ActiveInvocation {
  readonly token: symbol
  readonly control: InvocationControl
  readonly task: Promise<CommittedSessionEvent<ModelSettlement>>
}

type Preparation =
  | { readonly ok: true; readonly payload: ModelPreparedPayload; readonly binding: PreparedModelCall }
  | { readonly ok: false; readonly reason: ModelError }

const faultingCodes = new Set<ModelErrorCode>([
  'MODEL_JOURNAL_COMMIT_UNKNOWN', 'MODEL_JOURNAL_WRITE_FAILED', 'MODEL_CLEANUP_FAILED', 'MODEL_SESSION_CHANGED', 'MODEL_STATE_INVALID',
])

/** Session-local admission and settlement tasks; the borrowed Writer remains external. */
export class SessionModelRunner {
  readonly #session: SessionHandle
  readonly #prepare: ModelProvider['prepare']
  readonly #limits: ModelRunnerLimits
  readonly #identities: ModelIdentitySource
  readonly #lifetime: AbortSignal | undefined
  readonly #journal: ModelJournal
  #active: ActiveInvocation | undefined
  #status: ModelRunnerStatus = 'accepting'
  #disposeTask: Promise<void> | undefined
  #failure: ModelError | undefined

  constructor(options: SessionModelRunnerOptions) {
    if (options.session.status !== 'open') {
      throw new ModelError('MODEL_RUNNER_INACTIVE', 'model runner requires an open active Session')
    }
    const snapshot = options.session.snapshot()
    // Stranded work is an invalid durable state, not an ordinary inactive Runner.
    projectModelSession(snapshot)
    if (snapshot.lifecycle !== 'active') throw new ModelError('MODEL_RUNNER_INACTIVE', 'model Session has ended')
    this.#session = options.session
    this.#limits = validateSettlementBudget(options.limits, options.session.maxRecordBytes)
    this.#journal = new ModelJournal(options.session, this.#limits.maxJournalConflicts)
    this.#prepare = options.provider.prepare.bind(options.provider)
    this.#identities = options.identities ?? systemModelIdentitySource
    this.#lifetime = options.signal
  }

  get status(): ModelRunnerStatus {
    return this.#status === 'accepting' && this.#lifetime?.aborted === true ? 'disposing' : this.#status
  }

  /** Observe only committed facts; no network or implicit recovery is performed. */
  snapshot(): ModelSessionSnapshot { return projectModelSession(this.#session.snapshot()) }

  invoke(request: ModelRequest, options: ModelInvokeOptions = {}): Promise<CommittedSessionEvent<ModelSettlement>> {
    if (this.status !== 'accepting') throw new ModelError('MODEL_RUNNER_INACTIVE', 'model runner is not accepting calls')
    if (options.signal?.aborted === true) throw new ModelError('MODEL_CALL_CANCELLED', 'model call was already cancelled')
    if (this.#active !== undefined) throw new ModelError('MODEL_SESSION_BUSY', 'model runner already owns a call')
    const token = Symbol('model invocation task')
    const control = new InvocationControl()
    const signals = [options.signal, this.#lifetime].filter((signal): signal is AbortSignal => signal !== undefined)
    let preparation: Preparation | undefined
    const task = inModelTask(token, () => Promise.resolve().then(async () => {
      if (preparation === undefined) throw new ModelError('MODEL_STATE_INVALID', 'model preparation was not published')
      if (!preparation.ok) throw preparation.reason
      return await executeModelInvocation(this.#journal, preparation.payload, preparation.binding, control, signals)
    }))
    const active = { token, control, task }
    this.#active = active
    void task.then(
      () => { if (this.#active === active) this.#active = undefined },
      reason => {
        if (this.#active === active) this.#active = undefined
        if (reason instanceof ModelError && faultingCodes.has(reason.code)) {
          this.#failure ??= reason
          if (this.#status === 'accepting') this.#status = 'faulted'
        }
      },
    )
    // Task identity is visible before any provider callback; snapshotting remains sync.
    inModelTask(token, () => {
      try {
        const input = snapshotModelRequest(request)
        if (jsonBytes(input) > this.#limits.maxInputBytes) throw new ModelError('MODEL_REQUEST_INVALID', 'model input exceeds its explicit byte budget')
        const invocationId = parseModelInvocationId(this.#identities.nextInvocationId())
        const retryOf = options.retryOf === undefined ? undefined : parseModelInvocationId(options.retryOf)
        const candidate = this.#prepare(input)
        if (typeof candidate.acquire !== 'function') throw new ModelError('MODEL_REQUEST_INVALID', 'model binding must acquire an exchange')
        const submission = decodePreparedSubmission(snapshotJson(candidate.submission))
        if (!Buffer.from(canonicalJsonBytes(input)).equals(Buffer.from(canonicalJsonBytes(submission.request)))) {
          throw new ModelError('MODEL_BINDING_MISMATCH', 'provider changed the neutral request during preparation')
        }
        const binding = Object.freeze({ submission, acquire: candidate.acquire.bind(candidate) })
        const payload: ModelPreparedPayload = { invocationId, submission, limits: this.#limits, ...(retryOf === undefined ? {} : { retryOf }) }
        preparation = { ok: true, payload, binding }
      } catch (reason) {
        // Provider preparation errors may carry request bodies or runtime credentials.
        // Preserve a stable code, never the arbitrary message, details, or cause.
        preparation = { ok: false, reason: new ModelError(providerFailureCode(reason), 'model preparation rejected the invocation') }
      }
    })
    return task
  }

  /** Stop admission now, request cancellation, then join the one active settlement. */
  dispose(): Promise<void> {
    if (this.#disposeTask === undefined) {
      this.#status = 'disposing'
      const active = this.#active
      const task = Promise.resolve().then(async () => {
        if (active !== undefined) await active.task.catch(() => undefined)
        this.#status = 'disposed'
        if (this.#failure !== undefined) throw this.#failure
      })
      this.#disposeTask = task
      void task.catch(() => undefined)
      active?.control.requestCancel()
    }
    if (this.#active !== undefined && inheritsModelTask(this.#active.token)) {
      return Promise.reject(new ModelError('MODEL_REENTRANT_WAIT', 'model runner cannot await its own invocation'))
    }
    return this.#disposeTask
  }
}
