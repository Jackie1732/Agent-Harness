import type {
  EventListener,
  MiddlewareHandler,
  RegistrationId,
  RegistrationStatus,
  ScopeId,
  ScopeStatus,
} from './types.js'

export type RegistrationKind = 'listener' | 'middleware'

export interface NameEntry {
  readonly token: object
  readonly registrations: Set<RegistrationRecord>
}

export interface StagedNames {
  readonly events: Map<string, NameEntry>
  readonly middleware: Map<string, NameEntry>
}

export interface ScopeRecord {
  readonly id: ScopeId
  readonly ordinal: number
  readonly label: string
  status: ScopeStatus
  readonly parent: ScopeRecord | undefined
  readonly children: Set<ScopeRecord>
  readonly abort: AbortController
  readonly registrations: Set<RegistrationRecord>
  readonly tasks: Set<TaskRecord>
  stagingRoot: ScopeRecord | undefined
  stagedNames: StagedNames | undefined
  disposalTask: Promise<void> | undefined
}

export interface RegistrationRecord {
  readonly id: RegistrationId
  readonly ordinal: number
  readonly kind: RegistrationKind
  readonly token: object
  readonly name: string
  readonly label: string
  readonly callback: EventListener<unknown> | MiddlewareHandler<unknown, unknown>
  readonly scope: ScopeRecord
  status: RegistrationStatus
  published: boolean
  disposalTask: Promise<void> | undefined
}

export interface TaskRecord {
  readonly token: number
  readonly kind: 'origin' | 'frame'
  readonly owner: ScopeRecord
  readonly registration: RegistrationRecord | undefined
  readonly settled: Promise<void>
  readonly resolveSettled: () => void
}

export interface OriginTaskRecord extends TaskRecord {
  readonly kind: 'origin'
  readonly pendingContinuations: Set<Promise<unknown>>
  mainSettled: boolean
}

/** Return a root and all of its current descendants in tree traversal order. */
export function collectSubtree(root: ScopeRecord): ScopeRecord[] {
  const records: ScopeRecord[] = []
  const visit = (record: ScopeRecord): void => {
    records.push(record)
    for (const child of record.children) visit(child)
  }
  visit(root)
  return records
}

/** Return whether a scope belongs to a target scope's current subtree. */
export function isWithin(candidate: ScopeRecord, target: ScopeRecord): boolean {
  for (let current: ScopeRecord | undefined = candidate; current !== undefined; current = current.parent) {
    if (current === target) return true
  }
  return false
}
