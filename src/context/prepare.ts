import { types as nodeTypes } from 'node:util'
import type { JsonValue } from '../foundation/json.js'
import type { CommittedSessionEvent, SessionSnapshot } from '../session/types.js'
import type { ContextBuildFailure, ContextProfile, ContextSelectionSpec } from './contract.js'
import { invalidContext, invalidSource } from './errors.js'
import { assertLocalProfile, collectContextFacts } from './history.js'
import type { ContextFacts } from './history.js'
import { decodeContextProfile } from './profile.js'
import { validateAllMaterialSources } from './references.js'
import { decodeContextSelection } from './selection.js'
import { indexSources, knownEvent } from './sources.js'
import { contextJson, equalJson, exact, record } from './validation.js'

export interface PreparedContextSources {
  readonly profile: ContextProfile
  readonly selection: ContextSelectionSpec
  readonly facts: ContextFacts
}

/** Build and validate the bounded domain view shared by assembly and compaction. */
export function prepareContextFacts(
  snapshot: SessionSnapshot,
  profile: ContextProfile,
): ContextFacts | Extract<ContextBuildFailure, { kind: 'resource-limit' }> {
  const index = indexSources(snapshot, profile.budget)
  if ('kind' in index) return index
  const facts = collectContextFacts(index, profile.budget)
  if ('kind' in facts) return facts
  validateAllMaterialSources(facts)
  return facts
}
/** Validate the small outer record without recursively copying a large Snapshot before its limits are known. */
export function contextArgumentFields(value: unknown, names: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) invalidContext('arguments')
  const proto: unknown = Object.getPrototypeOf(value)
  if (proto !== null && (typeof proto !== 'object' || Object.getPrototypeOf(proto) !== null)) invalidContext('argument-prototype')
  if (Object.getOwnPropertySymbols(value).length > 0) invalidContext('argument-symbols')
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Object.values(descriptors).some(item => !item.enumerable || !('value' in item))) invalidContext('argument-accessor')
  exact(value as Record<string, JsonValue>, names, optional)
  return value as Record<string, unknown>
}
export function prepareContextSources(snapshot: SessionSnapshot, profileInput: CommittedSessionEvent<ContextProfile>, selectionInput: ContextSelectionSpec): PreparedContextSources | ContextBuildFailure {
  const supplied = record(contextJson(profileInput))
  exact(supplied, ['kind', 'stored', 'payload'])
  if (supplied.kind !== 'known') invalidSource('profile-not-committed')
  const profile = decodeContextProfile(supplied.payload)
  const selection = decodeContextSelection(selectionInput)
  if (profile.budget.outputReserveTokens < selection.target.maxOutputTokens) invalidContext('output-reserve')
  if (profile.tokenAccounting.mode === 'exact-required') return { kind: 'blocked', reason: 'estimator-unavailable', references: [] }
  const facts = prepareContextFacts(snapshot, profile)
  if ('kind' in facts) return facts
  assertLocalProfile(facts, selection.profileEventId, profile)
  const stored = knownEvent(facts.index, selection.profileEventId, 'context/profile-recorded')
  if (!equalJson(stored as unknown as JsonValue, supplied)) invalidSource('profile-record-mismatch')
  return { profile, selection, facts }
}
