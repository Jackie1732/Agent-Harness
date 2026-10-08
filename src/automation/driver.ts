import type { HarnessClient } from '../client/client.js'
import { ApiError, ClientAbortError, ClientTransportError } from '../client/errors.js'
import type { SessionEventId } from '../session/ids.js'
import type { InputObservation } from '../protocol/results.js'
import type { AutomationConfig } from './config-types.js'
import type { AutomationJournal, AutomationTrigger } from './journal.js'
import type { AutomationObservation } from './events.js'
import { AutomationError } from './validation.js'

export interface AutomationNotice {
  readonly kind: 'automation-observation'; readonly triggerKey: string; readonly jobKey: string
  readonly journalEventId: SessionEventId; readonly runAcceptance: 'not-started' | 'returned' | 'unknown' | 'not-accepted'
  readonly observation: AutomationObservation
}
/** A terminal Root outcome still has to release execution before automation reports closed. */
export function automationExecutionStatus(observation: AutomationObservation | null): 'unobserved' | 'pending' | 'waiting-for-user' | 'settling' | 'closed' | 'recovery-required' | 'read-unavailable' {
  if (observation === null) return 'unobserved'
  if (observation.recoveryRequired) return 'recovery-required'
  if (observation.readErrorCode !== null) return 'read-unavailable'
  if (observation.root?.outcome !== null && observation.root !== null) return observation.root.executionPending ? 'settling' : 'closed'
  return observation.root?.waitingForUser === true ? 'waiting-for-user' : 'pending'
}
function failureCode(error: ApiError | ClientTransportError | ClientAbortError): string { return error instanceof ApiError ? error.code : error.name }
function sameObservation(left: AutomationObservation | null, right: AutomationObservation): boolean {
  if (left === null) return false
  const significant = (value: AutomationObservation) => ({ error: value.readErrorCode, recovery: value.recoveryRequired,
    input: value.input === null ? null : { ...value.input, cuts: [] }, root: value.root === null ? null : { ...value.root, cuts: [] } })
  return JSON.stringify(significant(left)) === JSON.stringify(significant(right))
}
/** Owns a single mutation attempt per durable intent and consumes the original API's certified observations. */
export class AutomationDriver {
  readonly #config: AutomationConfig
  readonly #journal: AutomationJournal
  readonly #client: HarnessClient
  readonly #notice: (notice: AutomationNotice) => Promise<void>
  readonly #now: () => number
  constructor(options: { readonly config: AutomationConfig; readonly journal: AutomationJournal; readonly client: HarnessClient;
    readonly notice: (notice: AutomationNotice) => Promise<void>; readonly now: () => number }) {
    this.#config = options.config; this.#journal = options.journal; this.#client = options.client; this.#notice = options.notice; this.#now = options.now
  }
  /** Continue only stages with no durable intent; an unresolved intent is never resent. */
  async drive(triggerKey: string): Promise<void> {
    let trigger = this.#journal.get(triggerKey)!
    const job = this.#config.jobs.find(job => job.jobKey === trigger.jobKey)!
    if (trigger.runIntent !== null || trigger.rejection !== null) { await this.observe(triggerKey); return }
    if (trigger.submitIntent !== null && trigger.inputEventId === null) { await this.observe(triggerKey); return }
    let status
    try { status = await this.#hostStatus() }
    catch (error) { await this.#readFailure(triggerKey, error); return }
    if (status.hostStatus !== 'ready') return
    if (trigger.submitIntent === null) {
      await this.#journal.append({ kind: 'submit-intent', triggerKey })
      try {
        const receipt = await this.#client.request('input.submit', { agentKey: job.agentKey, submissionKey: triggerKey, text: trigger.text })
        await this.#journal.append({ kind: 'submitted', triggerKey, inputEventId: receipt.inputEventId })
      } catch (error) { await this.#rejected(triggerKey, 'submit', error); await this.#observeSources(triggerKey); return }
    }
    if (this.#journal.blockedRuns.length > 0) return
    trigger = this.#journal.get(triggerKey)!
    if (trigger.observation?.recoveryRequired) return
    await this.#journal.append({ kind: 'run-intent', triggerKey })
    try {
      const result = await this.#client.request('host.run', { expectedInstanceId: status.instanceId })
      await this.#journal.append({ kind: 'run-returned', triggerKey, instanceId: result.instanceId })
    } catch (error) { await this.#rejected(triggerKey, 'run', error) }
    await this.#observeSources(triggerKey)
  }
  async #hostStatus() {
    const status = await this.#client.request('host.status', {})
    if (status.report.hostKey !== this.#config.hostKey) throw new AutomationError('AUTOMATION_CONFLICT')
    return status
  }
  async #rejected(triggerKey: string, operation: 'submit' | 'run', error: unknown): Promise<void> {
    if (!(error instanceof ApiError || error instanceof ClientAbortError || error instanceof ClientTransportError)) throw error
    await this.#journal.append({ kind: 'rejected', triggerKey, operation, acceptance: error.acceptance === 'not-accepted' ? 'not-accepted' : 'unknown', code: failureCode(error) })
  }
  /** Read remote facts without implicit submit, run, retry or cancellation. */
  async observe(triggerKey: string): Promise<void> {
    const trigger = this.#journal.get(triggerKey)!
    if (trigger.submitIntent === null) return
    try { await this.#hostStatus() }
    catch (error) { await this.#readFailure(triggerKey, error); return }
    await this.#observeSources(triggerKey)
  }
  async #readFailure(triggerKey: string, error: unknown): Promise<void> {
    if (!(error instanceof ApiError || error instanceof ClientAbortError || error instanceof ClientTransportError)) throw error
    if (this.#journal.get(triggerKey)!.submitIntent === null) return
    await this.#publishObservation(triggerKey, { observedAt: new Date(this.#now()).toISOString(), readErrorCode: failureCode(error),
      recoveryRequired: error instanceof ApiError && error.code === 'API_RECOVERY_REQUIRED', input: null, root: null })
  }
  async #observeSources(triggerKey: string): Promise<void> {
    const trigger = this.#journal.get(triggerKey)!
    const job = this.#config.jobs.find(job => job.jobKey === trigger.jobKey)!
    let observation: AutomationObservation, input: InputObservation | undefined
    const inputFact = () => input === undefined ? null : { eventId: input.inputEventId, status: input.status, rootId: input.rootId, reason: input.reason,
      instanceId: input.instanceId, cuts: input.cuts.map(cut => ({ sessionId: cut.sessionId, through: cut.through })) }
    try {
      input = await this.#client.request('input.get', { agentKey: job.agentKey,
        ...(trigger.inputEventId === null ? { submissionKey: triggerKey } : { inputEventId: trigger.inputEventId }) })
      const root = input.rootId === null ? null : await this.#client.request('root.get', { agentKey: job.agentKey, rootId: input.rootId })
      observation = { observedAt: new Date(this.#now()).toISOString(), readErrorCode: null, recoveryRequired: input.recoveryRequired || root?.recoveryRequired === true,
        input: inputFact(),
        root: root === null ? null : { rootId: root.rootId, outcome: root.outcome, executionPending: root.executionPending,
          waitingForUser: root.waits.some(wait => wait.descriptor.kind === 'user'), finalEventId: root.final?.modelSettledId ?? null,
          instanceId: root.instanceId, cuts: root.cuts.map(cut => ({ sessionId: cut.sessionId, through: cut.through })) } }
    } catch (error) {
      if (!(error instanceof ApiError || error instanceof ClientAbortError || error instanceof ClientTransportError)) throw error
      observation = { observedAt: new Date(this.#now()).toISOString(), readErrorCode: failureCode(error),
        recoveryRequired: input?.recoveryRequired === true || error instanceof ApiError && error.code === 'API_RECOVERY_REQUIRED', input: inputFact(), root: null }
    }
    await this.#publishObservation(triggerKey, observation)
  }
  async #publishObservation(triggerKey: string, observation: AutomationObservation): Promise<void> {
    if (sameObservation(this.#journal.get(triggerKey)!.observation, observation)) return
    const journalEventId = await this.#journal.append({ kind: 'observed', triggerKey, observation })
    const current = this.#journal.get(triggerKey)!
    await this.#notice({ kind: 'automation-observation', triggerKey, jobKey: current.jobKey, journalEventId, runAcceptance: runAcceptance(current), observation })
  }
}
export function runAcceptance(trigger: AutomationTrigger): AutomationNotice['runAcceptance'] {
  return trigger.runIntent === null ? 'not-started' : trigger.runReturned ? 'returned'
    : trigger.rejection?.operation === 'run' && trigger.rejection.acceptance === 'not-accepted' ? 'not-accepted' : 'unknown'
}
