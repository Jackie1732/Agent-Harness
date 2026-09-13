import type { EffectLease } from '../effect/index.js'
import type { SessionAddress } from '../session/index.js'
import { CommunicationError } from './errors.js'
import type { MessageEnvelope, MessageDeliveryOutcome } from './types.js'

/** Public routing status without access to a receiver or Session object. */
export type DirectoryStatus =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'known-offline' }
  | { readonly kind: 'online' }
  | { readonly kind: 'ended' }

/** Mutable lifecycle control retained by the address declaration owner. */
export interface SessionDirectoryDeclaration {
  readonly address: SessionAddress
  readonly lifecycle: 'active' | 'ended'
  /** Permanently mark this declaration as ended. */
  markEnded(): void
}

/** In-process address catalog. Receiver routes remain private to Communication. */
export interface SessionDirectory {
  /** Declare one known address for the lifetime of the returned lease. */
  declare(address: SessionAddress, lifecycle: 'active' | 'ended'): Promise<EffectLease<SessionDirectoryDeclaration>>
  /** Inspect one address without receiving its route. */
  status(address: SessionAddress): DirectoryStatus
  /** Stop routing and release every declaration. */
  dispose(): Promise<void>
}

/** Receiver route available only to the in-process Transport implementation. */
export interface DirectoryReceiver {
  verifyDeliveryAttempt(envelope: MessageEnvelope): boolean
  acceptDelivery(
    envelope: MessageEnvelope,
    authenticatedSender: SessionAddress,
    signal: AbortSignal,
  ): Promise<MessageDeliveryOutcome>
}

interface Entry {
  readonly token: object
  lifecycle: 'active' | 'ended'
  receiver?: DirectoryReceiver
}

interface DirectoryState {
  readonly entries: Map<SessionAddress, Entry>
  active: boolean
}

const states = new WeakMap<SessionDirectory, DirectoryState>()

function stateOf(directory: SessionDirectory): DirectoryState {
  const state = states.get(directory)
  if (state === undefined) throw new CommunicationError('MESSAGE_DIRECTORY_CONFLICT', 'unsupported Session Directory implementation')
  return state
}

function conflict(message: string, address: SessionAddress): CommunicationError {
  return new CommunicationError('MESSAGE_DIRECTORY_CONFLICT', message, { details: { address } })
}

/** Register the private online route for one already-declared active address. */
export function registerDirectoryReceiver(
  directory: SessionDirectory,
  address: SessionAddress,
  receiver: DirectoryReceiver,
): EffectLease<DirectoryReceiver> {
  const state = stateOf(directory)
  if (!state.active) throw conflict('Session Directory is inactive', address)
  const entry = state.entries.get(address)
  if (entry === undefined) throw conflict('Session address is not declared', address)
  if (entry.lifecycle === 'ended') throw conflict('ended Session address cannot register a receiver', address)
  if (entry.receiver !== undefined) throw conflict('Session address already has a receiver', address)
  entry.receiver = receiver
  let disposeTask: Promise<void> | undefined
  return Object.freeze({
    label: `Session receiver ${address}`,
    value: receiver,
    dispose: () => {
      if (disposeTask !== undefined) return disposeTask
      if (entry.receiver === receiver) delete entry.receiver
      disposeTask = Promise.resolve()
      return disposeTask
    },
  })
}

/** Resolve a private receiver route for the in-process Transport. */
export function resolveDirectoryReceiver(
  directory: SessionDirectory,
  address: SessionAddress,
): { readonly status: DirectoryStatus; readonly receiver?: DirectoryReceiver } {
  const state = stateOf(directory)
  const entry = state.entries.get(address)
  if (!state.active || entry === undefined) return Object.freeze({ status: Object.freeze({ kind: 'unknown' as const }) })
  if (entry.lifecycle === 'ended') return Object.freeze({ status: Object.freeze({ kind: 'ended' as const }) })
  if (entry.receiver === undefined) return Object.freeze({ status: Object.freeze({ kind: 'known-offline' as const }) })
  return Object.freeze({ status: Object.freeze({ kind: 'online' as const }), receiver: entry.receiver })
}

/** Mark an attached active address ended after its Session terminal event commits. */
export function markDirectoryAddressEnded(directory: SessionDirectory, address: SessionAddress): void {
  const state = stateOf(directory)
  const entry = state.entries.get(address)
  if (!state.active || entry === undefined) throw conflict('Session address declaration is inactive', address)
  entry.lifecycle = 'ended'
}

/** Create one isolated in-process Session Directory. */
export function createSessionDirectory(): SessionDirectory {
  const state: DirectoryState = { entries: new Map(), active: true }
  const directory: SessionDirectory = {
    async declare(address, lifecycle) {
      if (!state.active) throw conflict('Session Directory is inactive', address)
      if (state.entries.has(address)) throw conflict('Session address is already declared', address)
      const token = Object.freeze({})
      const entry: Entry = { token, lifecycle }
      state.entries.set(address, entry)
      const declaration: SessionDirectoryDeclaration = Object.freeze({
        address,
        get lifecycle() { return entry.lifecycle },
        markEnded() {
          if (!state.active || state.entries.get(address)?.token !== token) {
            throw conflict('Session address declaration is inactive', address)
          }
          entry.lifecycle = 'ended'
        },
      })
      let disposeTask: Promise<void> | undefined
      return Object.freeze({
        label: `Session address ${address}`,
        value: declaration,
        dispose: () => {
          if (disposeTask !== undefined) return disposeTask
          if (state.entries.get(address)?.token === token) state.entries.delete(address)
          disposeTask = Promise.resolve()
          return disposeTask
        },
      })
    },
    status(address) {
      return resolveDirectoryReceiver(directory, address).status
    },
    async dispose() {
      if (!state.active) return
      state.active = false
      state.entries.clear()
    },
  }
  const frozen = Object.freeze(directory)
  states.set(frozen, state)
  return frozen
}
