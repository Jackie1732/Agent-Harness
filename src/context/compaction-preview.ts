import type { JsonValue } from '../foundation/json.js'
import type { SessionSnapshot } from '../session/types.js'
import type {
  ContextCompactionInput,
  ContextCompactionResult,
  RuleCompactionRequest,
} from './contract.js'
import { excerptHistory } from './compaction.js'
import { resolveCompactionLeaves } from './compaction-selection.js'
import { invalidSource } from './errors.js'
import { assertLocalProfile } from './history.js'
import { prepareContextFacts, contextArgumentFields } from './prepare.js'
import { decodeContextProfile } from './profile.js'
import { decodeRuleCompactionRequest } from './selection.js'
import { knownEvent } from './sources.js'
import { contextJson, equalJson, exact, record } from './validation.js'

/** Preview rule compaction from a fixed Session cut without writing or reading runtime services. */
export function previewCompaction(input: ContextCompactionInput): ContextCompactionResult {
  const fields = contextArgumentFields(input, ['snapshot', 'profile', 'request'])
  const supplied = record(contextJson(fields.profile))
  exact(supplied, ['kind', 'stored', 'payload'])
  if (supplied.kind !== 'known') invalidSource('profile-not-committed')
  const profile = decodeContextProfile(supplied.payload)
  const request = decodeRuleCompactionRequest(fields.request as RuleCompactionRequest)
  const facts = prepareContextFacts(fields.snapshot as SessionSnapshot, profile)
  if ('kind' in facts) return facts
  assertLocalProfile(facts, request.profileEventId, profile)
  const stored = knownEvent(facts.index, request.profileEventId, 'context/profile-recorded')
  if (!equalJson(stored as unknown as JsonValue, supplied)) invalidSource('profile-record-mismatch')
  const units = resolveCompactionLeaves(facts, profile, request.history, request.units, request.protectedRefs)
  return excerptHistory({
    cut: { coverage: facts.index.coverage },
    profileEventId: request.profileEventId,
    profile,
    history: request.history,
    units,
    protectedRefs: request.protectedRefs,
  }, request.maxExcerptBytes)
}
