import { createHash } from 'node:crypto'
import { SerialGate } from '../foundation/serial-gate.js'
import { EffectOwner } from '../effect/owner.js'
import { acquireHostStorageLock } from '../host/storage-lock.js'
import { FileSessionBackend } from '../session/file-backend.js'
import { SessionRepository } from '../session/repository.js'
import { SessionError } from '../session/errors.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { SessionEventId } from '../session/ids.js'
import type { SessionSnapshot } from '../session/types.js'
import { AutomationError } from './validation.js'
import { automationFactEvent, automationCatalog } from './events.js'
import type { AutomationFact, AutomationObservation } from './events.js'
import type { AutomationConfig } from './config-types.js'
import { automationConfigDigest } from './config.js'

/** One durable trigger and the receipt or uncertainty of each single mutation attempt. */
export interface AutomationTrigger {
  readonly triggerKey: string; readonly jobKey: string; readonly externalEventId: string; readonly text: string; readonly acceptedEventId: SessionEventId
  readonly submitIntent: SessionEventId | null; readonly inputEventId: SessionEventId | null; readonly runIntent: SessionEventId | null
  readonly runReturned: boolean; readonly runUnknownAcknowledged: boolean
  readonly rejection: { readonly operation: 'submit' | 'run'; readonly acceptance: 'not-accepted' | 'unknown'; readonly code: string } | null
  readonly observation: AutomationObservation | null; readonly observationEventId: SessionEventId | null
}

/** Open a separate automation storage root, preserving its marker if repository release fails. */
export async function openAutomationJournal(config: AutomationConfig): Promise<{ readonly journal: AutomationJournal; dispose(): Promise<void> }> {
  const owner = new EffectOwner('automation-journal')
  let repository: SessionRepository | undefined, released = false
  try {
    const lease = await owner.run('durable-journal', async context => {
      await context.apply('storage-lock', () => acquireHostStorageLock(config.journal.root, `automation:${config.automationKey}`), async lock => {
        if (repository !== undefined && !released) throw new AutomationError('AUTOMATION_INACTIVE')
        await lock.dispose()
      })
      repository = await context.apply('repository', () => new SessionRepository({ backend: new FileSessionBackend({ root: config.journal.root, maxRecordBytes: config.journal.maxRecordBytes }),
        catalog: automationCatalog, maxLineageDepth: 0 }), async value => { await value.dispose(); released = true })
      let session: SessionHandle
      try { session = await repository.open(config.journal.sessionId) }
      catch (error) { if (!(error instanceof SessionError && error.code === 'SESSION_NOT_FOUND')) throw error; session = await repository.create({ sessionId: config.journal.sessionId }) }
      const journal = new AutomationJournal(session, { automationKey: config.automationKey, configDigest: automationConfigDigest(config), jobKeys: config.jobs.map(job => job.jobKey),
        maxTriggers: config.journal.maxTriggers, maxEvents: config.journal.maxEvents })
      await journal.initialize()
      return journal
    })
    return { journal: lease.value, dispose: () => owner.dispose() }
  } catch (error) {
    try { await owner.dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Automation journal startup failed') }
    throw error
  }
}
/** Hash all identity fields with JSON separators, independent of external event spelling. */
export function automationTriggerKey(automationKey: string, jobKey: string, externalEventId: string): string {
  return createHash('sha256').update(JSON.stringify([automationKey, jobKey, externalEventId])).digest('hex')
}
/** An unresolved run intent remains uncertain even when its Root can later be observed. */
export function isUnknownRun(trigger: AutomationTrigger): boolean {
  return trigger.runIntent !== null && !trigger.runReturned && !(trigger.rejection?.operation === 'run' && trigger.rejection.acceptance === 'not-accepted')
}
function invalid(): never { throw new AutomationError('AUTOMATION_JOURNAL_INVALID') }

/** The Session owns append serialization; this gate owns trigger-level deduplication and phase checks. */
export class AutomationJournal {
  readonly #session: SessionHandle
  readonly #gate = new SerialGate()
  readonly #maxTriggers: number
  readonly #maxEvents: number
  readonly #triggers = new Map<string, AutomationTrigger>()
  readonly #automationKey: string
  readonly #configDigest: string
  readonly #jobKeys: ReadonlySet<string>
  #configured = false

  constructor(session: SessionHandle, options: { readonly automationKey: string; readonly configDigest: string; readonly jobKeys: readonly string[]; readonly maxTriggers: number; readonly maxEvents: number }) {
    this.#session = session; this.#maxTriggers = options.maxTriggers; this.#maxEvents = options.maxEvents
    this.#automationKey = options.automationKey; this.#configDigest = options.configDigest
    this.#jobKeys = new Set(options.jobKeys)
    const snapshot = session.snapshot()
    if (snapshot.header.parent !== undefined || snapshot.lifecycle !== 'active' || snapshot.localPosition > options.maxEvents) invalid()
    for (const event of snapshot.history.at(-1)!.events) {
      if (event.kind !== 'known' || event.stored.type !== automationFactEvent.type) invalid()
      this.#apply(automationFactEvent.decode(event.payload), event.stored.eventId)
    }
  }
  /** Initialize a new journal or verify its existing immutable configuration binding. */
  async initialize(): Promise<void> {
    if (!this.#configured) await this.append({ kind: 'configured', automationKey: this.#automationKey, configDigest: this.#configDigest })
  }
  get healthy(): boolean { return this.#session.status === 'open' }
  get triggers(): readonly AutomationTrigger[] { return [...this.#triggers.values()] }
  get blockedRuns(): readonly AutomationTrigger[] { return this.triggers.filter(trigger => isUnknownRun(trigger) && !trigger.runUnknownAcknowledged) }
  get snapshot(): SessionSnapshot { return this.#session.snapshot() }
  get(triggerKey: string): AutomationTrigger | undefined { return this.#triggers.get(triggerKey) }
  /** Accept one new trigger or return the exact prior content without another network attempt. */
  accept(jobKey: string, externalEventId: string, text: string, queued: number, maximumQueued: number): Promise<{ readonly trigger: AutomationTrigger; readonly reused: boolean }> {
    return this.#gate.run(async () => {
      const triggerKey = automationTriggerKey(this.#automationKey, jobKey, externalEventId), prior = this.#triggers.get(triggerKey)
      if (prior !== undefined) {
        if (prior.text !== text) throw new AutomationError('AUTOMATION_CONFLICT')
        return { trigger: prior, reused: true }
      }
      if (this.#triggers.size >= this.#maxTriggers || queued >= maximumQueued) throw new AutomationError('AUTOMATION_LIMIT')
      await this.#append({ kind: 'accepted', triggerKey, jobKey, externalEventId, text })
      return { trigger: this.#triggers.get(triggerKey)!, reused: false }
    })
  }
  /** Append only a valid transition, then publish it from the committed fact. */
  append(fact: AutomationFact): Promise<SessionEventId> { return this.#gate.run(() => this.#append(fact)) }
  async #append(fact: AutomationFact): Promise<SessionEventId> {
    if (this.#session.snapshot().localPosition >= this.#maxEvents) throw new AutomationError('AUTOMATION_LIMIT')
    this.#check(fact)
    const event = await this.#session.append(automationFactEvent, fact)
    this.#apply(event.payload, event.stored.eventId)
    return event.stored.eventId
  }
  #check(fact: AutomationFact): void {
    if (fact.kind === 'configured') {
      if (this.#configured || fact.automationKey !== this.#automationKey || fact.configDigest !== this.#configDigest || this.#triggers.size !== 0) invalid()
      return
    }
    if (!this.#configured) invalid()
    const prior = this.#triggers.get(fact.triggerKey)
    if (fact.kind === 'accepted') {
      if (prior !== undefined || this.#triggers.size >= this.#maxTriggers || !this.#jobKeys.has(fact.jobKey)
        || automationTriggerKey(this.#automationKey, fact.jobKey, fact.externalEventId) !== fact.triggerKey) invalid()
      return
    }
    if (prior === undefined) invalid()
    switch (fact.kind) {
      case 'submit-intent': if (prior.submitIntent !== null) invalid(); return
      case 'submitted': if (prior.submitIntent === null || prior.inputEventId !== null) invalid(); return
      case 'run-intent': if (prior.inputEventId === null || prior.runIntent !== null || prior.rejection !== null) invalid(); return
      case 'run-returned': if (prior.runIntent === null || prior.runReturned || prior.rejection !== null) invalid(); return
      case 'rejected': if (prior.rejection !== null || (fact.operation === 'submit' ? prior.submitIntent === null || prior.inputEventId !== null : prior.runIntent === null || prior.runReturned)) invalid(); return
      case 'observed':
        if (prior.submitIntent === null || fact.observation.input !== null && prior.inputEventId !== null && prior.inputEventId !== fact.observation.input.eventId
          || fact.observation.root !== null && fact.observation.input?.rootId !== fact.observation.root.rootId) invalid()
        return
      case 'run-unknown-acknowledged': if (!isUnknownRun(prior) || prior.runUnknownAcknowledged || fact.runIntent !== prior.runIntent) invalid(); return
    }
  }
  #apply(fact: AutomationFact, eventId: SessionEventId): void {
    this.#check(fact)
    if (fact.kind === 'configured') { this.#configured = true; return }
    if (fact.kind === 'accepted') {
      this.#triggers.set(fact.triggerKey, Object.freeze({ triggerKey: fact.triggerKey, jobKey: fact.jobKey, externalEventId: fact.externalEventId,
        text: fact.text, acceptedEventId: eventId, submitIntent: null, inputEventId: null, runIntent: null, runReturned: false,
        runUnknownAcknowledged: false, rejection: null, observation: null, observationEventId: null }))
      return
    }
    const prior = this.#triggers.get(fact.triggerKey)!
    const update = fact.kind === 'submit-intent' ? { submitIntent: eventId }
      : fact.kind === 'submitted' ? { inputEventId: fact.inputEventId }
        : fact.kind === 'run-intent' ? { runIntent: eventId }
          : fact.kind === 'run-returned' ? { runReturned: true }
            : fact.kind === 'rejected' ? { rejection: { operation: fact.operation, acceptance: fact.acceptance, code: fact.code } }
              : fact.kind === 'observed' ? { observation: fact.observation, observationEventId: eventId }
                : { runUnknownAcknowledged: true }
    this.#triggers.set(fact.triggerKey, Object.freeze({ ...prior, ...update }))
  }
}
