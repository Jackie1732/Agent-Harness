import { projectAgentSession } from '../agent/projection.js'
import { delegationClosure, sessionDelegationsClosed } from '../subagent/closure.js'
import { effectiveResourceRelease } from '../subagent/resource-evidence.js'
import { ProtocolCapacity } from './protocol-capacity.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { SessionAddress, SessionEventId } from '../session/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { DelegationRequested } from '../subagent/event-contract.js'
import { delegationRequestedEvent, childBoundEvent, subagentProtocolRecordedEvent } from '../subagent/session-events.js'
import { subagentMessageKind } from '../subagent/messages.js'
import { CommunicationError } from './errors.js'
import { projectCommunicationFacts } from './projection.js'
import type { MessageSendCommand, MessageSendKey } from './send-command.js'
import type { MailboxLimits, MessageEnvelope } from './types.js'

const leaseBrand: unique symbol = Symbol('delegation-channel-lease')
/** Process-local capability; only its issuing Communication Service can authorize it. */
export interface DelegationChannelLease { readonly [leaseBrand]: true }
type Reservation = {
  readonly token: DelegationChannelLease
  readonly event: CommittedSessionEvent<DelegationRequested>
  readonly parent: SessionHandle
  child?: SessionHandle
  revoked?: ReadonlyMap<SessionAddress, number>
}

/** Owns lifetime mailbox reservations and atomic admission with ordinary mailbox writes. */
export class DelegationChannels {
  readonly #capacity: ProtocolCapacity
  readonly #reservations = new Map<SessionEventId, Reservation>()
  readonly #tokens = new WeakMap<DelegationChannelLease, Reservation>()
  #uncertain = false
  #closed = false
  closeAdmission(): void { this.#closed = true; this.#capacity.closeAdmission() }
  drain(): Promise<void> { return this.#capacity.drain() }
  constructor(readonly limits: MailboxLimits, capacity = new ProtocolCapacity(limits)) { this.#capacity = capacity }

  run<T>(write: () => Promise<T>): Promise<T> { return this.#capacity.run(write) }

  /** The callback may perform a local CP-D commit only; it must not acquire live child resources. */
  admit(parent: SessionHandle, request: DelegationRequested,
    commit: () => Promise<CommittedSessionEvent<DelegationRequested>>): Promise<DelegationChannelLease> {
    request = delegationRequestedEvent.decode(request)
    return this.run(async () => {
      this.#assertKnown()
      if (this.#closed) invalid('channel-admission-closed')
      this.#checkReservation(parent, request)
      let event
      try { event = await commit() } catch (cause) {
        if (parent.status !== 'open' || cause instanceof Error && 'code' in cause && ['AGENT_COMMIT_UNKNOWN', 'SESSION_APPEND_OUTCOME_UNKNOWN'].includes(String(cause.code))) this.#uncertain = true
        throw cause
      }
      if (!equal(event.payload, request)) { this.#uncertain = true; invalid('delegation-commit-mismatch') }
      return this.#install(parent, event)
    })
  }

  /** Rebuild all reservations before exposing receivers or admitting fresh Host work. */
  restore(parent: SessionHandle, event: CommittedSessionEvent<DelegationRequested>): Promise<DelegationChannelLease> {
    return this.run(async () => {
      this.#assertKnown()
      if (this.#closed) invalid('channel-admission-closed')
      const prior = this.#reservations.get(event.stored.eventId)
      if (prior !== undefined) {
        if (prior.parent !== parent || !equal(prior.event, event)) invalid('delegation-restore-conflict')
        return prior.token
      }
      this.#checkReservation(parent, event.payload)
      return this.#install(parent, event)
    })
  }

  /** Return reservations only after durable business, resource, input and transport closure. */
  retire(token: DelegationChannelLease): void {
    const reservation = this.#require(token)
    const snapshot = reservation.parent.snapshot()
    if (!delegationClosure(projectAgentSession(snapshot), reservation.event.stored.eventId, snapshot.history.at(-1)!.events.filter(item => item.kind === 'known')).closed) invalid('delegation-not-closed')
    if (reservation.child !== undefined) {
      const child = reservation.child.snapshot()
      if (!sessionDelegationsClosed(projectAgentSession(child), child.history.at(-1)!.events.filter(item => item.kind === 'known'))) invalid('child-protocol-still-open')
    }
    this.#reservations.delete(reservation.event.stored.eventId); this.#tokens.delete(token); this.#capacity.retire(token)
  }

  bindChild(token: DelegationChannelLease, child: SessionHandle): void {
    const reservation = this.#require(token)
    const request = reservation.event.payload
    const bound = child.snapshot().history.at(-1)?.events.find(item => item.stored.type === childBoundEvent.type)
    if (child.header.address !== request.childAddress || child.header.parent !== undefined || bound?.kind !== 'known') invalid('child-channel-binding')
    const payload = childBoundEvent.decode(bound.payload)
    if (payload.delegation !== reservation.event.stored.eventId || !equal(payload.requested, request)
      || reservation.child !== undefined && reservation.child !== child) invalid('child-channel-binding')
    reservation.child = child
  }

  /** Stop fresh business intents while allowing already persisted sends and terminal results to settle. */
  revoke(token: DelegationChannelLease): void {
    const reservation = this.#require(token)
    reservation.revoked ??= new Map([reservation.parent, reservation.child].filter((handle): handle is SessionHandle => handle !== undefined)
      .map(handle => [handle.header.address, handle.snapshot().localPosition]))
  }

  assertSend(token: DelegationChannelLease, handle: SessionHandle, key: MessageSendKey, command: MessageSendCommand): void {
    const reservation = this.#require(token)
    if (reservation.parent !== handle && reservation.child !== handle) invalid('foreign-channel-sender')
    const event = handle.snapshot().history.at(-1)?.events.find(item => item.stored.eventId === key.eventId)
    if (key.index !== 0 || event?.kind !== 'known' || event.stored.type !== subagentProtocolRecordedEvent.type) invalid('protocol-send-source')
    const protocol = subagentProtocolRecordedEvent.decode(event.payload)
    if (protocol.delegation !== reservation.event.stored.eventId || !equal(protocol.command, command)) invalid('protocol-send-source')
    if (reservation.revoked !== undefined && protocol.kind !== 'result' && event.stored.sequence > (reservation.revoked.get(handle.header.address) ?? 0)) invalid('delegation-revoked')
    this.#assertOnline(reservation, handle)
    if (protocol.kind === 'task' || protocol.kind === 'question' || protocol.kind === 'answer') {
      const source = protocol.source
      const checkpoint = handle.snapshot().history.at(-1)?.events.some(item => item.kind === 'known'
        && item.stored.type === 'agent/turn-settled' && record(item.payload).outcome === 'waiting'
        && (source.kind === 'delegation' && reservation.event.payload.source.kind === 'programmatic'
          || item.stored.sequence > (source.kind === 'action' ? event.stored.sequence : reservation.event.stored.sequence)))
      if (!checkpoint) invalid('protocol-before-wait-checkpoint')
    }
  }

  authorizeReceive(envelope: MessageEnvelope): boolean {
    const reservation = this.#envelopeReservation(envelope)
    if (reservation === undefined) return false
    const sender = envelope.sender === reservation.event.payload.parentAddress ? reservation.parent : reservation.child
    const recipient = envelope.recipient === reservation.event.payload.parentAddress ? reservation.parent : reservation.child
    if (sender === undefined || recipient === undefined) return false
    try { this.#assertOnline(reservation, recipient) } catch { return false }
    const outgoing = projectCommunicationFacts(sender.snapshot()).outbox.find(item => item.messageId === envelope.messageId)
    return outgoing !== undefined && equal(outgoing.envelope, envelope)
  }

  /** Returns whether one fresh message fits; protocol messages consume their pre-reserved lifetime quota. */
  hasCapacity(handle: SessionHandle, direction: 'inbox' | 'outbox', envelope?: MessageEnvelope): boolean {
    this.#assertKnown()
    return this.#capacity.hasCapacity(handle, direction, envelope)
  }

  #install(parent: SessionHandle, event: CommittedSessionEvent<DelegationRequested>): DelegationChannelLease {
    const stored = parent.snapshot().history.at(-1)?.events.find(item => item.stored.eventId === event.stored.eventId)
    if (stored?.kind !== 'known' || stored.stored.type !== delegationRequestedEvent.type || !equal(stored.payload, event.payload)) invalid('uncommitted-delegation')
    const token: DelegationChannelLease = Object.freeze({ [leaseBrand]: true as const })
    const reservation = { token, event, parent }
    this.#reservations.set(event.stored.eventId, reservation); this.#tokens.set(token, reservation)
    this.#capacity.install(token, new Map([
      [event.payload.parentAddress, event.payload.mailboxReserve.parent],
      [event.payload.childAddress, event.payload.mailboxReserve.child],
    ]), envelope => matches(envelope, event.payload, event.stored.eventId))
    return token
  }
  #checkReservation(parent: SessionHandle, request: DelegationRequested): void {
    if (request.parentAddress !== parent.header.address || [...this.#reservations.values()].some(item => item.event.payload.childAddress === request.childAddress)) invalid('delegation-address-conflict')
    const restoring = findEventId(parent, request)
    this.#capacity.check(new Map([
      [request.parentAddress, request.mailboxReserve.parent],
      [request.childAddress, request.mailboxReserve.child],
    ]), new Map([[parent.header.address, parent]]), envelope => restoring !== undefined && matches(envelope, request, restoring))
  }
  #envelopeReservation(envelope: MessageEnvelope): Reservation | undefined {
    const kind = subagentMessageKind(envelope.type)
    if (kind === null || envelope.payloadVersion !== 1) return undefined
    const id = record(envelope.payload).delegation
    const reservation = typeof id === 'string' ? this.#reservations.get(id as SessionEventId) : undefined
    if (reservation === undefined) return undefined
    return matches(envelope, reservation.event.payload, reservation.event.stored.eventId) ? reservation : undefined
  }
  #assertOnline(reservation: Reservation, handle: SessionHandle): void {
    const state = projectAgentSession(handle.snapshot())
    const opened = state.subagents.resources.filter(item => item.opened.payload.delegation === reservation.event.stored.eventId && item.opened.payload.component === 'protocol').at(-1)
    if (opened === undefined || effectiveResourceRelease(opened, state.subagents.recoveries) !== null) invalid('protocol-generation-inactive')
  }
  #require(token: DelegationChannelLease): Reservation {
    this.#assertKnown()
    const value = this.#tokens.get(token)
    if (value === undefined || this.#reservations.get(value.event.stored.eventId) !== value) invalid('channel-lease-inactive')
    return value
  }
  #assertKnown(): void { if (this.#uncertain) invalid('admission-outcome-unknown') }
}
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function equal(left: unknown, right: unknown): boolean { return Buffer.from(canonicalJsonBytes(left as import('../foundation/json.js').JsonValue)).equals(Buffer.from(canonicalJsonBytes(right as import('../foundation/json.js').JsonValue))) }
function findEventId(parent: SessionHandle, request: DelegationRequested): SessionEventId | undefined {
  return parent.snapshot().history.at(-1)?.events.find(item => item.kind === 'known' && item.stored.type === delegationRequestedEvent.type && equal(item.payload, request))?.stored.eventId
}
function invalid(reason: string): never { throw new CommunicationError('MESSAGE_SEND_FORBIDDEN', reason) }

function matches(envelope: MessageEnvelope, request: DelegationRequested, id: SessionEventId): boolean {
  const kind = subagentMessageKind(envelope.type)
  if (kind === null || envelope.payloadVersion !== 1 || record(envelope.payload).delegation !== id) return false
  const parentSends = kind === 'task' || kind === 'answer'
  return envelope.sender === (parentSends ? request.parentAddress : request.childAddress)
    && envelope.recipient === (parentSends ? request.childAddress : request.parentAddress) && envelope.channelId === request.channelId
}
