import type { CapabilityKey } from './types.js'

/**
 * Create a capability key.
 *
 * The key is identified by object identity, so two independently created keys with the
 * same name never resolve to each other, and no process-global table is involved. The
 * name is carried for diagnostics only; a registry reports a name conflict when two
 * different keys with one name are declared to it.
 *
 * @param name - Diagnostic name of the capability.
 * @returns A frozen capability key.
 * @throws {TypeError} If the name is empty.
 */
export function createCapabilityKey<T>(name: string): CapabilityKey<T> {
  if (name.length === 0) throw new TypeError('capability key name must not be empty')
  return Object.freeze({ name })
}

/**
 * Read the diagnostic name of a key.
 *
 * @param key - Capability key.
 * @returns The name recorded at creation.
 */
export function capabilityKeyName(key: CapabilityKey<unknown>): string {
  return key.name
}
