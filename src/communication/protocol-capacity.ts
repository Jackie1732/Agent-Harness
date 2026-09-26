import { SerialGate } from '../foundation/serial-gate.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { MessageEnvelope, MailboxLimits } from './types.js'
import { projectCommunicationFacts } from './projection.js'
import { CommunicationError } from './errors.js'

export type MailboxDirection = 'inbox' | 'outbox'
export interface MailboxReservation { readonly inbox: number; readonly outbox: number }

type HeldReservation = {
  readonly quotas: ReadonlyMap<string, MailboxReservation>
  readonly matches: (envelope: MessageEnvelope) => boolean
}

/** Serializes ordinary writes and domain reservations against the same Mailbox limits. */
export class ProtocolCapacity {
  readonly #gate = new SerialGate()
  readonly #held = new Map<object, HeldReservation>()
  #closed = false
  constructor(readonly limits: MailboxLimits) {}

  run<T>(write: () => Promise<T>): Promise<T> { return this.#gate.run(write) }
  drain(): Promise<void> { return this.run(async () => undefined) }
  closeAdmission(): void { this.#closed = true }

  /** Call under run() before the domain's durable reservation commit. */
  check(quotas: ReadonlyMap<string, MailboxReservation>, handles: ReadonlyMap<string, SessionHandle>,
    restoring?: (envelope: MessageEnvelope) => boolean): void {
    if (this.#closed) throw new CommunicationError('MESSAGE_SEND_FORBIDDEN', 'channel-admission-closed')
    for (const [address, quota] of quotas) for (const direction of ['inbox', 'outbox'] as const) {
      const held = [...this.#held.values()].reduce((sum, item) => sum + (item.quotas.get(address)?.[direction] ?? 0), 0)
      const handle = handles.get(address)
      const ordinary = handle === undefined ? 0 : projectCommunicationFacts(handle.snapshot())[direction]
        .filter(item => item.status === 'pending' && this.#classify(item.envelope) === undefined
          && !restoring?.(item.envelope)).length
      const maximum = direction === 'inbox' ? this.limits.maxPendingInbox : this.limits.maxPendingOutbox
      if (ordinary + held + quota[direction] > maximum) {
        throw new CommunicationError('MESSAGE_OUTBOX_FULL', 'protocol mailbox reservation exceeds capacity')
      }
    }
  }

  /** Install only after the domain's commit has been confirmed. */
  install(token: object, quotas: ReadonlyMap<string, MailboxReservation>, matches: (envelope: MessageEnvelope) => boolean): void {
    this.#held.set(token, { quotas, matches })
  }
  retire(token: object): void { this.#held.delete(token) }

  hasCapacity(handle: SessionHandle, direction: MailboxDirection, envelope?: MessageEnvelope): boolean {
    const facts = projectCommunicationFacts(handle.snapshot())[direction]
    const reservation = envelope === undefined ? undefined : this.#classify(envelope)
    if (reservation !== undefined) {
      const used = facts.filter(item => this.#classify(item.envelope) === reservation).length
      return used < (reservation.quotas.get(handle.header.address)?.[direction] ?? 0)
    }
    const held = [...this.#held.values()].reduce((sum, item) => sum + (item.quotas.get(handle.header.address)?.[direction] ?? 0), 0)
    const ordinary = facts.filter(item => item.status === 'pending' && this.#classify(item.envelope) === undefined).length
    return ordinary + held < (direction === 'inbox' ? this.limits.maxPendingInbox : this.limits.maxPendingOutbox)
  }

  #classify(envelope: MessageEnvelope): HeldReservation | undefined {
    return [...this.#held.values()].find(item => item.matches(envelope))
  }
}
