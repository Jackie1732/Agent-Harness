import {
  EventNameConflictError,
  MiddlewareNameConflictError,
  ScopeInactiveError,
} from './errors.js'
import type {
  NameEntry,
  RegistrationKind,
  RegistrationRecord,
  ScopeRecord,
  StagedNames,
} from './records.js'
import type {
  EventListener,
  MiddlewareHandler,
  RegistrationHandle,
  RegistrationId,
  RegistrationStatus,
} from './types.js'

function requireLabel(label: string, kind: string): void {
  if (label.length === 0) throw new TypeError(`${kind} label must not be empty`)
}

function nameTable(names: StagedNames, kind: RegistrationKind): Map<string, NameEntry> {
  return kind === 'listener' ? names.events : names.middleware
}

/** Owns registration identity, publication, name consistency, and removal. */
export class RegistrationStore {
  readonly #published = new Map<number, RegistrationRecord>()
  readonly #activeEventNames = new Map<string, NameEntry>()
  readonly #activeMiddlewareNames = new Map<string, NameEntry>()
  #nextId = 0
  #nextOrdinal = 0

  constructor(private readonly onChange: () => void) {}

  /** Highest registration ordinal allocated before a new dispatch begins. */
  get upperBound(): number {
    return this.#nextOrdinal
  }

  /** Add one staged or immediately published registration. */
  register(
    scope: ScopeRecord,
    kind: RegistrationKind,
    token: { readonly name: string },
    label: string,
    callback: EventListener<unknown> | MiddlewareHandler<unknown, unknown>,
  ): RegistrationHandle {
    requireLabel(label, kind === 'listener' ? 'listener' : 'middleware handler')
    if (scope.status !== 'accepting' && scope.status !== 'staging') {
      const operation = kind === 'listener' ? 'on()' : 'intercept()'
      throw new ScopeInactiveError(String(scope.id), scope.label, scope.status, operation)
    }
    this.#assertNameAvailable(kind, token, scope)
    this.#nextId += 1
    this.#nextOrdinal += 1
    const record: RegistrationRecord = {
      id: `r${this.#nextId}` as RegistrationId,
      ordinal: this.#nextOrdinal,
      kind,
      token,
      name: token.name,
      label,
      callback,
      scope,
      status: 'registered',
      published: scope.status === 'accepting',
      disposalTask: undefined,
    }
    scope.registrations.add(record)
    if (record.published) {
      this.#published.set(record.ordinal, record)
      this.#addName(this.#activeNames(kind), record)
    } else {
      const stagingRoot = scope.stagingRoot
      const names = stagingRoot?.stagedNames
      if (names === undefined) throw new Error('staging scope has no name ledger')
      this.#addName(nameTable(names, kind), record)
    }
    this.onChange()
    return this.#createHandle(record)
  }

  /** Remove one registration immediately and return its stable release task. */
  dispose(record: RegistrationRecord): Promise<void> {
    if (record.disposalTask !== undefined) return record.disposalTask
    if (record.status === 'registered') {
      record.status = 'disposed'
      record.scope.registrations.delete(record)
      if (record.published) {
        this.#published.delete(record.ordinal)
        this.#removeName(this.#activeNames(record.kind), record)
      } else {
        const names = record.scope.stagingRoot?.stagedNames
        if (names !== undefined) this.#removeName(nameTable(names, record.kind), record)
      }
      this.onChange()
    }
    record.disposalTask = Promise.resolve()
    return record.disposalTask
  }

  /** Reject an invocation whose diagnostic name belongs to a different token. */
  assertInvocationName(
    kind: RegistrationKind,
    token: { readonly name: string },
    scope: ScopeRecord,
    operation: string,
  ): void {
    this.#assertActiveNameAvailable(kind, token.name, token, scope, operation)
  }

  /** Validate that every staged registration can join the published name tables. */
  validatePublication(registrations: readonly RegistrationRecord[]): void {
    for (const registration of registrations) {
      this.#assertActiveNameAvailable(
        registration.kind,
        registration.name,
        registration.token,
        registration.scope,
        'publish',
      )
    }
  }

  /** Publish registrations after the owning activation has completed all validation. */
  publish(registrations: readonly RegistrationRecord[]): void {
    for (const record of registrations) {
      record.published = true
      this.#published.set(record.ordinal, record)
      this.#addName(this.#activeNames(record.kind), record)
      this.onChange()
    }
  }

  /** Select the next currently eligible registration within a dispatch's ordinal range. */
  next(
    kind: RegistrationKind,
    token: object,
    cursor: number,
    upperBound: number,
  ): RegistrationRecord | undefined {
    let found: RegistrationRecord | undefined
    for (const registration of this.#published.values()) {
      if (registration.kind !== kind || registration.token !== token) continue
      if (registration.ordinal <= cursor || registration.ordinal > upperBound) continue
      if (registration.status !== 'registered' || !registration.published) continue
      if (registration.scope.status !== 'accepting') continue
      if (found === undefined || registration.ordinal < found.ordinal) found = registration
    }
    return found
  }

  #createHandle(record: RegistrationRecord): RegistrationHandle {
    return {
      id: record.id,
      scopeId: record.scope.id,
      label: record.label,
      get status(): RegistrationStatus { return record.status },
      dispose: () => this.dispose(record),
    }
  }

  #assertNameAvailable(
    kind: RegistrationKind,
    token: { readonly name: string },
    scope: ScopeRecord,
  ): void {
    this.#assertActiveNameAvailable(kind, token.name, token, scope, 'register')
    const stagedNames = scope.stagingRoot?.stagedNames
    if (stagedNames === undefined) return
    const entry = nameTable(stagedNames, kind).get(token.name)
    if (entry !== undefined && entry.token !== token) {
      this.#throwNameConflict(kind, token.name, entry, scope, 'register')
    }
  }

  #assertActiveNameAvailable(
    kind: RegistrationKind,
    name: string,
    token: object,
    scope: ScopeRecord,
    operation: string,
  ): void {
    const entry = this.#activeNames(kind).get(name)
    if (entry !== undefined && entry.token !== token) {
      this.#throwNameConflict(kind, name, entry, scope, operation)
    }
  }

  #throwNameConflict(
    kind: RegistrationKind,
    name: string,
    entry: NameEntry,
    scope: ScopeRecord,
    operation: string,
  ): never {
    const existing = [...entry.registrations]
      .sort((left, right) => left.ordinal - right.ordinal)[0]
    const existingScopeId = existing === undefined ? String(scope.id) : String(existing.scope.id)
    if (kind === 'listener') {
      throw new EventNameConflictError(name, existingScopeId, String(scope.id), operation)
    }
    throw new MiddlewareNameConflictError(name, existingScopeId, String(scope.id), operation)
  }

  #activeNames(kind: RegistrationKind): Map<string, NameEntry> {
    return kind === 'listener' ? this.#activeEventNames : this.#activeMiddlewareNames
  }

  #addName(table: Map<string, NameEntry>, registration: RegistrationRecord): void {
    const entry = table.get(registration.name)
    if (entry === undefined) {
      table.set(registration.name, { token: registration.token, registrations: new Set([registration]) })
      return
    }
    entry.registrations.add(registration)
  }

  #removeName(table: Map<string, NameEntry>, registration: RegistrationRecord): void {
    const entry = table.get(registration.name)
    if (entry === undefined) return
    entry.registrations.delete(registration)
    if (entry.registrations.size === 0) table.delete(registration.name)
  }
}
