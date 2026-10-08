import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { SerialGate } from '../foundation/serial-gate.js'
import { EffectOwner } from '../effect/owner.js'
import { acquireHostStorageLock } from '../host/storage-lock.js'
import { FileSessionBackend } from '../session/file-backend.js'
import { SessionRepository } from '../session/repository.js'
import { SessionError } from '../session/errors.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { JsonObject } from '../foundation/json.js'
import { snapshotJson } from '../foundation/json.js'
import type { ResolvedOperatorProfile } from './profile.js'
import type { OperatorIntent } from './types.js'
import { OperatorError } from './errors.js'
import { operatorFactEvent, operatorCatalog } from './intent-events.js'
import type { OperatorFact } from './intent-events.js'

/** The append gate owns reservations only; it is never held during a control request. */
export class OperatorJournal {
  readonly #gate = new SerialGate()
  readonly #intents = new Map<string, OperatorIntent>()
  readonly #checkpoints = new Map<string, number>()
  #configured = false
  #reserved = 0
  #sameCertificate = true

  constructor(readonly session: SessionHandle, readonly profile: ResolvedOperatorProfile, readonly bindingDigest: string,
    readonly certificateFingerprint: string | null = null) {
    const snapshot = session.snapshot()
    if (snapshot.header.parent !== undefined || snapshot.lifecycle !== 'active') throw new OperatorError('OPERATOR_JOURNAL_INVALID', 1)
    for (const record of snapshot.history.at(-1)!.events) {
      if (record.kind !== 'known' || record.stored.type !== operatorFactEvent.type) throw new OperatorError('OPERATOR_JOURNAL_INVALID', 1)
      this.#apply(operatorFactEvent.decode(record.payload))
    }
  }
  async initialize(): Promise<void> {
    if (!this.#configured) await this.#gate.run(async () => {
      this.#capacity(1)
      await this.#append({ kind: 'configured', profileKey: this.profile.profileKey, bindingDigest: this.bindingDigest,
        certificateFingerprint: this.certificateFingerprint })
    })
  }
  get healthy(): boolean { return this.session.status === 'open' }
  get sameCertificate(): boolean { return this.#sameCertificate }
  get intents(): readonly OperatorIntent[] { return [...this.#intents.values()] }
  get(id: string): OperatorIntent | undefined { return this.#intents.get(id) }
  eventCheckpoint(sessionId: string): number | undefined { return this.#checkpoints.get(sessionId) }

  prepare(input: Omit<OperatorIntent, 'id' | 'outcome' | 'preparedAt' | 'acknowledgementReason'>): Promise<OperatorIntent> {
    input = snapshotJson(input as JsonObject) as typeof input
    return this.#gate.run(async () => {
      if (this.#intents.size >= this.profile.journal.maxIntents) throw new OperatorError('OPERATOR_JOURNAL_FULL', 3)
      if (!this.#sameCertificate) throw new OperatorError('OPERATOR_AUTHENTICATION_CHANGED', 3)
      this.#capacity(2)
      const intent = { ...input, id: randomUUID(), preparedAt: new Date().toISOString(),
        acknowledgementReason: input.acknowledgedIntent === null ? null : 'operator-requested-new-batch' as const }
      await this.#append({ kind: 'prepared', intent })
      return this.#intents.get(intent.id)!
    })
  }
  complete(id: string, outcome: NonNullable<OperatorIntent['outcome']>): Promise<void> {
    return this.#gate.run(async () => {
      const current = this.#intents.get(id)
      if (current === undefined || current.outcome !== null) throw new OperatorError('OPERATOR_INTENT_INVALID', 2)
      // This slot was reserved before sending. Optional records cannot consume it.
      await this.#append({ kind: 'outcome', intentId: id, outcome })
    })
  }
  checkpoint(sessionId: string, sequence: number): Promise<void> {
    return this.#gate.run(async () => {
      if (this.#checkpoints.get(sessionId) === sequence) return
      this.#capacity(1); await this.#append({ kind: 'checkpoint', sessionId, sequence })
    })
  }
  #capacity(count: number): void {
    if (!this.healthy) throw new OperatorError('OPERATOR_JOURNAL_FAILED', 1)
    if (this.session.snapshot().localPosition + this.#reserved + count > this.profile.journal.maxEvents) throw new OperatorError('OPERATOR_JOURNAL_FULL', 3)
  }
  async #append(fact: OperatorFact): Promise<void> {
    await this.session.append(operatorFactEvent, fact)
    this.#apply(fact)
  }
  #apply(fact: OperatorFact): void {
    switch (fact.kind) {
      case 'configured':
        if (this.#configured || fact.profileKey !== this.profile.profileKey || fact.bindingDigest !== this.bindingDigest) throw new OperatorError('OPERATOR_BINDING_CHANGED', 2)
        this.#configured = true; this.#sameCertificate = fact.certificateFingerprint === this.certificateFingerprint; break
      case 'prepared':
        if (!this.#configured || this.#intents.has(fact.intent.id)) throw new OperatorError('OPERATOR_JOURNAL_INVALID', 1)
        this.#intents.set(fact.intent.id, { ...fact.intent, outcome: null }); this.#reserved++; break
      case 'outcome': {
        const current = this.#intents.get(fact.intentId)
        if (current === undefined || current.outcome !== null) throw new OperatorError('OPERATOR_JOURNAL_INVALID', 1)
        this.#intents.set(current.id, { ...current, outcome: fact.outcome }); this.#reserved--; break
      }
      case 'checkpoint': this.#checkpoints.set(fact.sessionId, fact.sequence); break
    }
  }
}

/** Acquire the process lock before the journal writer; failed release retains its lock. */
export async function openOperatorJournal(profile: ResolvedOperatorProfile, bindingDigest: string, certificateFingerprint: string | null = null) {
  const owner = new EffectOwner('operator-journal')
  let repository: SessionRepository | undefined, released = false
  try {
    const lease = await owner.run('journal', async context => {
      await context.apply('storage-lock', () => acquireHostStorageLock(profile.journal.root, `operator:${profile.profileKey}`), async lock => {
        if (repository !== undefined && !released) throw new OperatorError('OPERATOR_JOURNAL_FAILED', 1)
        await lock.dispose()
      })
      repository = await context.apply('repository', () => new SessionRepository({
        backend: new FileSessionBackend(profile.journal), catalog: operatorCatalog, maxLineageDepth: 0,
      }), async value => { await value.dispose(); released = true })
      let session: SessionHandle
      try { session = await repository.open(profile.journal.sessionId) }
      catch (error) {
        if (!(error instanceof SessionError) || error.code !== 'SESSION_NOT_FOUND') throw error
        session = await repository.create({ sessionId: profile.journal.sessionId })
      }
      const journal = new OperatorJournal(session, profile, bindingDigest, certificateFingerprint)
      await journal.initialize()
      return journal
    })
    return { journal: lease.value, dispose: () => owner.dispose() }
  } catch (error) {
    try { await owner.dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Operator journal startup failed') }
    throw error
  }
}

/** Borrow an immutable snapshot without opening a writer or changing a crash prefix. */
export async function inspectOperatorJournal(profile: ResolvedOperatorProfile): Promise<readonly JsonObject[]> {
  // File backend root preparation creates directories; offline inspection only admits existing roots.
  await stat(join(profile.journal.root, 'sessions'))
  const repository = new SessionRepository({ backend: new FileSessionBackend(profile.journal), catalog: operatorCatalog, maxLineageDepth: 0 })
  try {
    const snapshot = await repository.read(profile.journal.sessionId)
    return snapshot.history.at(-1)!.events.map(record => {
      if (record.kind !== 'known') throw new OperatorError('OPERATOR_JOURNAL_INVALID', 1)
      return operatorFactEvent.decode(record.payload)
    })
  } finally { await repository.dispose() }
}
