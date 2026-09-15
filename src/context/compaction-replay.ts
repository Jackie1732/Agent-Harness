import type { ModelInvocationId } from '../model/ids.js'
import type { CommittedSessionEvent } from '../session/types.js'
import type { SessionEventId } from '../session/ids.js'
import type { ContextCompaction, ContextCompactionResult, ContextProfile, ContextUnitReference } from './contract.js'
import { buildContextFromSources } from './assembly-core.js'
import { decodeCapturedFacts } from './surface-codec.js'
import { asCompactionUnit, compactionLeaf, excerptHistory, finishCompaction } from './compaction.js'
import type { CompactionBase } from './compaction.js'
import { decodeContextCompaction } from './compaction-codec.js'
import { assertUnambiguousCompactions, resolveCompactionLeaves } from './compaction-selection.js'
import type { ResolvedCompaction } from './compaction-selection.js'
import { invalidSource, invalidState } from './errors.js'
import { assertLocalProfile } from './history.js'
import type { ContextFacts } from './history.js'
import { modelComplete } from './model-history.js'
import { precedingContextAssembly } from './model-link.js'
import { prepareContextFacts, prepareContextSources } from './prepare.js'
import type { PreparedContextSources } from './prepare.js'
import { decodeContextProfile } from './profile.js'
import { assertEventCut, knownEvent, snapshotAtCut } from './sources.js'
import { equalJson, sourceKey } from './validation.js'

export interface UnsupportedContextVersion { readonly kind: 'unsupported'; readonly version: string }
function supported(value: ContextCompaction): UnsupportedContextVersion | undefined {
  if (value.rendererVersion !== 'context-neutral/v1') return { kind: 'unsupported', version: value.rendererVersion }
  if (value.algorithm.name !== (value.algorithm.kind === 'excerpt' ? 'excerpt-history/v1' : 'adopt-model-text/v1')) return { kind: 'unsupported', version: value.algorithm.name }
  return undefined
}
function originalProfile(facts: ContextFacts, eventId: SessionEventId): CommittedSessionEvent<ContextProfile> {
  const event = knownEvent(facts.index, eventId, 'context/profile-recorded')
  return { ...event, payload: decodeContextProfile(event.payload) }
}

/** Verify a model-authored summary against its independently rebuilt compaction input. No model is invoked here. */
export function modelCompactionCandidate(facts: ContextFacts, invocationId: ModelInvocationId,
  protectedRefs: readonly ContextUnitReference[]): ContextCompactionResult | UnsupportedContextVersion {
  const model = facts.local.models.invocations.find(item => item.invocationId === invocationId)
  if (model?.state !== 'settled' || !modelComplete(model) || model.settled.payload.result.stopReason !== 'stop') invalidSource('summary-not-completed-clean-stop')
  const blocks = [...model.settled.payload.result.blocks].sort((a, b) => a.index - b.index)
  if (blocks.length === 0 || blocks.some(block => block.kind !== 'text' || !block.complete)) invalidSource('summary-not-text-only')
  const assembly = precedingContextAssembly(facts.index.snapshot, model.prepared)
  if (assembly === undefined || assembly.payload.purpose !== 'compaction' || assembly.payload.selection.compactionSource === null) invalidSource('summary-assembly-relation')
  if (assembly.payload.rendererVersion !== 'context-neutral/v1') return { kind: 'unsupported', version: assembly.payload.rendererVersion }
  const originalCut = snapshotAtCut(facts.index.snapshot, assembly.payload.coverage)
  const profile = originalProfile(facts, assembly.payload.selection.profileEventId)
  const prepared = prepareContextSources(originalCut, profile, assembly.payload.selection)
  if ('kind' in prepared) invalidState('summary-input-source-rebuild')
  const rebuilt = buildContextFromSources(prepared, decodeCapturedFacts(assembly.payload.captured), assembly.payload.budget.sessionMaxRecordBytes, [])
  if (rebuilt.kind !== 'ready' || !equalJson(rebuilt.assembly, assembly.payload)) invalidState('summary-input-full-rebuild')
  const source = assembly.payload.selection.compactionSource
  const protections = new Map([...source.protectedRefs, ...protectedRefs].map(ref => [sourceKey(ref), ref]))
  const combined = [...protections.values()]
  const units = resolveCompactionLeaves(facts, profile.payload, assembly.payload.selection.history, source.units, combined)
  const base: CompactionBase = { cut: { coverage: facts.index.coverage }, profileEventId: profile.stored.eventId,
    profile: profile.payload, history: assembly.payload.selection.history, units, protectedRefs: combined }
  const textBlocks = blocks.filter(block => block.kind === 'text')
  return finishCompaction(base, { kind: 'model-text', name: 'adopt-model-text/v1', invocationId,
    assemblyEventId: assembly.stored.eventId, preparedEventId: model.prepared.stored.eventId, settledEventId: model.settled.stored.eventId,
    blockIndices: textBlocks.map(block => block.index) }, textBlocks.map(block => block.text).join('\n\n'),
  units.map(unit => ({ kind: 'omitted-with-reason', reference: unit.reference, reason: 'model-generated-summary' })))
}

/** A historical Compaction is checked at its own cut before it can replace any current units. */
export function resolveStoredCompaction(prepared: PreparedContextSources, eventId: SessionEventId,
  protectedRefs: readonly ContextUnitReference[]): ResolvedCompaction | UnsupportedContextVersion {
  const { facts, profile, selection } = prepared
  const event = knownEvent(facts.index, eventId, 'context/compaction-committed')
  const value = decodeContextCompaction(event.payload)
  const unsupported = supported(value)
  if (unsupported !== undefined) return unsupported
  assertEventCut(facts.index.snapshot, event, value.coverage)
  const original = originalProfile(facts, value.profileEventId)
  const prior = snapshotAtCut(facts.index.snapshot, value.coverage)
  const historicalFacts = prepareContextFacts(prior, original.payload)
  if ('kind' in historicalFacts) invalidState('compaction-original-cut')
  assertLocalProfile(historicalFacts, value.profileEventId, original.payload)
  const oldLeaves = resolveCompactionLeaves(historicalFacts, original.payload, value.history, value.leaves.map(leaf => leaf.reference), value.protectedRefs)
  let rebuilt: ContextCompactionResult | UnsupportedContextVersion
  if (value.algorithm.kind === 'excerpt') {
    rebuilt = excerptHistory({ cut: { coverage: historicalFacts.index.coverage }, profileEventId: original.stored.eventId,
      profile: original.payload, history: value.history, units: oldLeaves, protectedRefs: value.protectedRefs }, value.algorithm.maxExcerptBytes)
  } else rebuilt = modelCompactionCandidate(historicalFacts, value.algorithm.invocationId, value.protectedRefs)
  if (rebuilt.kind === 'unsupported') return rebuilt
  if (rebuilt.kind !== 'ready' || !equalJson(rebuilt.compaction, value)) invalidState('compaction-content-rebuild')
  const current = resolveCompactionLeaves(facts, profile, selection.history, value.leaves.map(leaf => leaf.reference), protectedRefs)
  if (!equalJson(current.map(compactionLeaf), value.leaves)) invalidSource('compaction-leaf-facts-changed')
  return { value, leaves: current, unit: asCompactionUnit(eventId, value, current) }
}
export function resolveSelectedCompactions(prepared: PreparedContextSources): readonly ResolvedCompaction[] | UnsupportedContextVersion {
  const { selection } = prepared
  const protectedRefs = [...selection.requiredInputs, ...selection.observations, ...selection.memory.required, ...selection.outboxPayloads]
  const resolved: ResolvedCompaction[] = []
  for (const eventId of selection.compactions) {
    const item = resolveStoredCompaction(prepared, eventId, protectedRefs)
    if ('kind' in item) return item
    resolved.push(item)
  }
  assertUnambiguousCompactions(resolved)
  return Object.freeze(resolved)
}
