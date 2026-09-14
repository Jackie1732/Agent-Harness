import type { Scope } from '../extension/types.js'
import type { ToolDefinition, ToolProvider, ToolProviderDescriptor, ToolSchemaLimits } from './contract.js'
import { decodeDefinition } from './definition.js'
import { compileDefinition } from './schema-validator.js'
import type { CompiledToolDefinition } from './schema-validator.js'
import { ToolError } from './errors.js'
import { ownsToolTask } from './execution-context.js'
import { readDescriptor, readSchemaLimits } from './validation.js'

export type ToolRegistrationStatus = 'staging' | 'active' | 'retiring' | 'disposed'
/** Public control of one registration; never exposes its provider or a borrow ticket. */
export interface ToolRegistration {
  readonly definition: ToolDefinition
  readonly status: ToolRegistrationStatus
  /** Synchronously retires; then waits for full invocation settlement, not merely close(). */
  dispose(): Promise<void>
}
export interface ToolRegistrationSnapshot {
  readonly definition: ToolDefinition
  readonly provider: ToolProviderDescriptor
  readonly status: ToolRegistrationStatus
  readonly inFlight: number
}
interface Flight { readonly task: Promise<unknown>; readonly cancel: () => void }
interface Registration {
  readonly scope: Scope
  readonly compiled: CompiledToolDefinition
  readonly descriptor: ToolProviderDescriptor
  readonly provider: Pick<ToolProvider, 'prepare'>
  readonly controller: AbortController
  readonly flights: Map<symbol, Flight>
  readonly remove: () => void
  readonly stopListening: () => void
  retiring: boolean
  disposed: boolean
  closeTask?: Promise<void>
  unsafe?: ToolError
}
interface RegistryState {
  readonly limits: ToolSchemaLimits
  readonly slots: Map<string, Registration | symbol>
  closed: boolean
  closeTask?: Promise<void>
}
const registries = new WeakMap<ToolRegistry, RegistryState>()
function state(registry: ToolRegistry): RegistryState {
  const result = registries.get(registry)
  if (result === undefined) throw new ToolError('TOOL_REGISTRATION_INACTIVE', 'unrecognized tool registry')
  return result
}
function active(record: Registration): boolean {
  return !record.retiring && !record.disposed && record.scope.status === 'accepting' && !record.scope.signal.aborted
}
function status(record: Registration): ToolRegistrationStatus {
  if (record.disposed) return 'disposed'
  if (record.retiring || record.scope.signal.aborted) return 'retiring'
  return active(record) ? 'active' : 'staging'
}
function reentrant(record: Registration): boolean { return [...record.flights.keys()].some(ownsToolTask) }
function retire(record: Registration): Promise<void> {
  if (record.closeTask !== undefined) return record.closeTask
  record.retiring = true
  record.closeTask = Promise.resolve().then(async () => {
    await Promise.allSettled([...record.flights.values()].map(flight => flight.task))
    record.stopListening()
    record.disposed = true
    // Incomplete recovery keeps the name reserved. Replacing it would hide a resource leak.
    if (record.unsafe !== undefined) throw record.unsafe
    record.remove()
  })
  void record.closeTask.catch(() => undefined)
  record.controller.abort()
  for (const flight of record.flights.values()) flight.cancel()
  return record.closeTask
}

/** An explicit consumer-local namespace. Scope ancestry never grants visibility in another registry. */
export class ToolRegistry {
  constructor(limits: ToolSchemaLimits) {
    registries.set(this, { limits: readSchemaLimits(limits), slots: new Map(), closed: false })
  }

  /** Reserve a name synchronously. Staging registrations become visible only with their Scope. */
  register(scope: Scope, definition: ToolDefinition, provider: ToolProvider): ToolRegistration {
    const registry = state(this)
    if (registry.closed || !['staging', 'accepting'].includes(scope.status) || scope.signal.aborted) {
      throw new ToolError('TOOL_REGISTRATION_INACTIVE', 'registry or owning Scope is not accepting registrations')
    }
    const checked = decodeDefinition(definition, registry.limits)
    if (registry.slots.has(checked.name)) throw new ToolError('TOOL_REGISTRATION_CONFLICT', 'tool name is already reserved')
    const reservation = Symbol('tool reservation')
    registry.slots.set(checked.name, reservation)
    try {
      const descriptor = readDescriptor(provider.descriptor)
      if (typeof provider.prepare !== 'function' || typeof provider.dispose !== 'function'
        || !descriptor.tools.some(tool => tool.name === checked.name && tool.version === checked.version)) {
        throw new ToolError('TOOL_BINDING_MISMATCH', 'provider does not implement the selected tool version')
      }
      // Capture the method with the activation instance; never resolve it again after CP0.
      const binding = Object.freeze({ prepare: provider.prepare.bind(provider) })
      const compiled = compileDefinition(checked, registry.limits)
      if (registry.closed || !['staging', 'accepting'].includes(scope.status) || scope.signal.aborted) {
        throw new ToolError('TOOL_REGISTRATION_INACTIVE', 'registration lifecycle closed during validation')
      }
      const abort = (): void => { void retire(record) }
      const record: Registration = { scope, compiled, descriptor, provider: binding,
        controller: new AbortController(), flights: new Map(), retiring: false, disposed: false,
        remove: () => { if (registry.slots.get(checked.name) === record) registry.slots.delete(checked.name) },
        stopListening: () => scope.signal.removeEventListener('abort', abort),
      }
      registry.slots.set(checked.name, record)
      scope.signal.addEventListener('abort', abort, { once: true })
      if (scope.signal.aborted) void retire(record)
      return Object.freeze({ definition: compiled.definition,
        get status() { return status(record) },
        dispose: () => {
          const task = retire(record)
          return reentrant(record) ? Promise.reject(new ToolError('TOOL_REENTRANT_WAIT', 'tool task cannot wait for its own registration')) : task
        },
      })
    } catch (reason) {
      if (registry.slots.get(checked.name) === reservation) registry.slots.delete(checked.name)
      throw reason
    }
  }

  /** Return declarative visible tools only; no fallback to parent, sibling, or global namespaces. */
  definitions(): readonly ToolDefinition[] {
    const registry = state(this)
    return Object.freeze([...registry.slots.values()].flatMap(item => typeof item !== 'symbol' && active(item) ? [item.compiled.definition] : []))
  }
  snapshot(): readonly ToolRegistrationSnapshot[] {
    return Object.freeze([...state(this).slots.values()].flatMap(item => typeof item === 'symbol' ? [] : [Object.freeze({
      definition: item.compiled.definition, provider: item.descriptor, status: status(item), inFlight: item.flights.size,
    })]))
  }
  /** Retire this namespace without disposing borrowed provider clients. */
  dispose(): Promise<void> {
    const registry = state(this)
    registry.closed = true
    const records = [...registry.slots.values()].filter((item): item is Registration => typeof item !== 'symbol')
    if (registry.closeTask === undefined) {
      registry.closeTask = Promise.resolve().then(async () => {
        const results = await Promise.allSettled(records.map(record => record.closeTask!))
        if (results.some(result => result.status === 'rejected')) throw new ToolError('TOOL_CLEANUP_FAILED', 'tool registrations did not recover completely')
      })
      void registry.closeTask.catch(() => undefined)
      for (const record of records) retire(record)
    }
    if (records.some(reentrant)) return Promise.reject(new ToolError('TOOL_REENTRANT_WAIT', 'tool task cannot wait for its registry'))
    return registry.closeTask
  }
}

/** Package-private borrowing protocol; the public root intentionally does not re-export it. */
export interface ToolBorrow {
  readonly definition: ToolDefinition
  readonly descriptor: ToolProviderDescriptor
  readonly provider: Pick<ToolProvider, 'prepare'>
  readonly compiled: CompiledToolDefinition
  readonly signal: AbortSignal
  active(): boolean
  markUnsafe(error: ToolError): void
}
export function borrowTool(registry: ToolRegistry, name: string, token: symbol, task: Promise<unknown>, cancel: () => void): ToolBorrow | undefined {
  const owner = state(registry)
  const record = owner.slots.get(name)
  if (owner.closed || record === undefined || typeof record === 'symbol' || !active(record)) return undefined
  record.flights.set(token, { task, cancel })
  const remove = (): void => { record.flights.delete(token) }
  void task.then(remove, remove)
  return Object.freeze({ definition: record.compiled.definition, descriptor: record.descriptor, provider: record.provider,
    compiled: record.compiled, signal: record.controller.signal,
    active: () => active(record),
    markUnsafe: (error: ToolError) => { record.unsafe = error; void retire(record) },
  })
}
