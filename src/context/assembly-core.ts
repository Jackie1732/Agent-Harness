import { snapshotJson } from '../foundation/json.js'
import { inspectBoundedJson, JsonBoundaryError } from '../schema/bounded-json.js'
import { snapshotModelRequest } from '../model/request.js'
import type { ContextAssembly, ContextBuildResult, ContextCapturedFacts, ContextMemoryCandidate, ContextOmission, ContextUnitReference } from './contract.js'
import { measureAssemblyEnvelope, measureContextRequest, requestBudgetFailure } from './budget.js'
import { resolveCompactionLeaves } from './compaction-selection.js'
import type { ResolvedCompaction } from './compaction-selection.js'
import { invalidContext, invalidSource } from './errors.js'
import { executionBlock, resolveUnit } from './history.js'
import { retrieveSessionMemory } from './memory.js'
import type { PreparedContextSources } from './prepare.js'
import { contextProvenance, incompatibleContinuation, renderContextRequest } from './request-plan.js'
import type { SelectedGroup } from './request-plan.js'
import { capturedSurfaceBlock, resolveRequirements } from './requirements.js'
import { unitRepresentation } from './render.js'
import type { ContextUnit } from './unit.js'
import { compareUnits, selectedUnit } from './unit.js'
import { contextJsonCeiling, digest, integer, sourceKey } from './validation.js'

function group(unit: ContextUnit, placement: SelectedGroup['placement'], representation: 'raw' | 'historical-note/v1'): SelectedGroup {
  return { unit, placement, representation: unitRepresentation(unit, representation) }
}
function orderedHistory(pinned: readonly SelectedGroup[], selected: readonly SelectedGroup[]): SelectedGroup[] {
  return [...pinned, ...selected].sort((a, b) => compareUnits(a.unit, b.unit))
}
/** Policy operates only on already fixed, validated sources and observations. */
export function buildContextFromSources(prepared: PreparedContextSources, captured: ContextCapturedFacts,
  sessionMaxRecordBytes: number, compactions: readonly ResolvedCompaction[]): ContextBuildResult {
  integer(sessionMaxRecordBytes, 1, Number.MAX_SAFE_INTEGER)
  const { facts, profile, selection } = prepared
  const execution = executionBlock(facts)
  if (execution !== undefined) return execution
  const surface = capturedSurfaceBlock(facts, profile, captured)
  if (surface !== undefined) return surface
  const requirements = resolveRequirements(facts, profile, selection, captured)
  if ('kind' in requirements) return requirements
  if (facts.units.length + compactions.length > profile.budget.maxUnits) return { kind: 'resource-limit', limit: 'units', maximum: profile.budget.maxUnits }
  const requiredGroups = requirements.units.map(unit => group(unit, 'required', selection.history.representation))
  const protectedEvents = new Set(requirements.references.map(ref => ref.eventId))
  for (const item of compactions) for (const leaf of item.leaves) if (protectedEvents.has(leaf.reference.eventId)) invalidSource('compaction-overlaps-required')
  const pinned = compactions.map(item => group(item.unit, 'history', selection.history.representation)).sort((a, b) => compareUnits(a.unit, b.unit))
  const required = [...requirements.references, ...pinned.map(item => item.unit.reference)]
  const omitted: ContextOmission[] = []
  const memoryCandidates: ContextMemoryCandidate[] = []
  let groups: SelectedGroup[]
  let memoryEstimatedTokens = 0

  if (profile.purpose === 'compaction') {
    if (selection.compactionSource === null || selection.compactions.length > 0 || requirements.units.length > 0
      || selection.memory.query.topK !== 0 || captured.tools.length > 0) invalidSource('compaction-input-contract')
    const leaves = resolveCompactionLeaves(facts, profile, selection.history, selection.compactionSource.units, selection.compactionSource.protectedRefs)
    groups = leaves.map(unit => group(unit, 'compaction-source', selection.history.representation))
    required.push(...leaves.map(unit => unit.reference))
  } else {
    if (selection.compactionSource !== null) invalidSource('generation-has-compaction-source')
    const covered = new Set(compactions.flatMap(item => item.leaves.map(leaf => sourceKey(leaf.reference))))
    for (const item of compactions) for (const leaf of item.leaves) omitted.push({ reference: leaf.reference, reason: 'compacted' })
    const requiredKeys = new Set(required.map(sourceKey))
    const candidates = facts.units.filter(unit => {
      if (!unit.optionalHistory || !requirements.allowedOrdinals.has(unit.segmentOrdinal) || covered.has(sourceKey(unit.reference))) return false
      if (requiredKeys.has(sourceKey(unit.reference))) { omitted.push({ reference: unit.reference, reason: 'required-duplicate' }); return false }
      return true
    })
    const initial = renderContextRequest(profile, selection, captured, [...pinned, ...requiredGroups])
    const initialMeasure = measureContextRequest(initial, profile)
    if ('kind' in initialMeasure) return initialMeasure
    const initialFailure = requestBudgetFailure(initialMeasure, profile, required)
    if (initialFailure !== undefined) return initialFailure
    const historical: SelectedGroup[] = []
    let stopped = false
    for (let index = candidates.length - 1; index >= 0; index--) {
      const unit = candidates[index]
      if (unit === undefined) invalidSource('history-index')
      if (stopped) { omitted.push({ reference: unit.reference, reason: 'outside-suffix' }); continue }
      const candidate = group(unit, 'history', selection.history.representation)
      const nextGroups = [...orderedHistory(pinned, [...historical, candidate]), ...requiredGroups]
      const measure = measureContextRequest(renderContextRequest(profile, selection, captured, nextGroups), profile)
      if ('kind' in measure) return measure
      if (requestBudgetFailure(measure, profile, [unit.reference]) !== undefined) {
        omitted.push({ reference: unit.reference, reason: 'history-budget' }); stopped = true
      } else historical.push(candidate)
    }
    groups = [...orderedHistory(pinned, historical), ...requiredGroups]
    const memoryBase = measureContextRequest(renderContextRequest(profile, selection, captured, groups), profile)
    if ('kind' in memoryBase) return memoryBase
    if (selection.memory.query.topK !== 0) {
      // Bound candidate count before the retriever allocates or sorts its ranked report.
      let matching = 0
      for (const head of facts.local.material.memory) {
        const record = head.record
        if (record !== null && selection.memory.query.requiredTags.every(tag => record.payload.tags.includes(tag))) {
          if (++matching > profile.budget.maxMemoryCandidates) return { kind: 'resource-limit', limit: 'memory-candidates', maximum: profile.budget.maxMemoryCandidates }
        }
      }
      const candidates = retrieveSessionMemory(facts.local.material.memory, selection.memory.query)
      for (const { text: _text, ...candidate } of candidates) {
        void _text
        memoryCandidates.push(candidate)
        if (requiredKeys.has(sourceKey(candidate.reference))) continue
        if (!candidate.withinTopK) { omitted.push({ reference: candidate.reference, reason: 'memory-top-k' }); continue }
        const selected = group(resolveUnit(facts, candidate.reference), 'memory', selection.history.representation)
        const nextGroups = [...groups, selected]
        const measure = measureContextRequest(renderContextRequest(profile, selection, captured, nextGroups), profile)
        if ('kind' in measure) return measure
        const memoryTokens = measure.estimatedTokens - memoryBase.estimatedTokens
        if (memoryTokens > profile.budget.maxMemoryEstimatedTokens) { omitted.push({ reference: candidate.reference, reason: 'memory-budget' }); continue }
        if (requestBudgetFailure(measure, profile, [candidate.reference]) !== undefined) { omitted.push({ reference: candidate.reference, reason: 'request-budget' }); continue }
        groups = nextGroups; memoryEstimatedTokens = memoryTokens
      }
    }
  }
  return finishAssembly(prepared, captured, sessionMaxRecordBytes, groups, required, omitted, memoryCandidates,
    memoryEstimatedTokens, requirements.deferred, requirements.pendingOutbox)
}

function finishAssembly(prepared: PreparedContextSources, captured: ContextCapturedFacts, sessionMaxRecordBytes: number,
  groups: readonly SelectedGroup[], required: readonly ContextUnitReference[], omitted: readonly ContextOmission[],
  memoryCandidates: readonly ContextMemoryCandidate[], memoryEstimatedTokens: number,
  deferred: ContextAssembly['deferred'], pendingOutbox: ContextAssembly['pendingOutbox']): ContextBuildResult {
  const { profile, selection, facts } = prepared
  const incompatible = incompatibleContinuation(selection, groups)
  if (incompatible.length > 0) return { kind: 'blocked', reason: 'history-unrepresentable', references: incompatible.map(unit => unit.reference) }
  const raw = renderContextRequest(profile, selection, captured, groups)
  const measure = measureContextRequest(raw, profile)
  if ('kind' in measure) return measure
  const budgetFailure = requestBudgetFailure(measure, profile, required)
  if (budgetFailure !== undefined) return budgetFailure
  if (raw.messages.length === 0) return { kind: 'blocked', reason: 'history-unrepresentable', references: [] }
  let request
  try { request = snapshotModelRequest(raw) } catch { return { kind: 'blocked', reason: 'history-unrepresentable', references: groups.map(item => item.unit.reference) } }
  const provenanceCount = profile.sections.length + captured.tools.length + ['model', 'maxOutputTokens', 'temperature', 'topP', 'profile'].filter(field => Object.hasOwn(selection.target, field)).length
    + request.messages.reduce((count, message) => count + message.content.length + (message.role === 'assistant' && message.continuation !== undefined ? 1 : 0), 0)
  if (provenanceCount > profile.budget.maxProvenanceEntries) return { kind: 'resource-limit', limit: 'provenance', maximum: profile.budget.maxProvenanceEntries }
  const provenance = contextProvenance(profile, selection, captured, groups)
  const candidate: ContextAssembly = {
    purpose: profile.purpose, coverage: facts.index.coverage, selection, captured, required,
    selected: groups.map(item => selectedUnit(item.unit, item.placement, item.representation)), omitted, deferred, pendingOutbox, memoryCandidates,
    budget: { accounting: 'neutral-json-utf8-estimate/v1', precision: 'estimate', requestBytes: measure.bytes,
      estimatedInputTokens: measure.estimatedTokens, availableInputTokens: measure.availableTokens, memoryEstimatedTokens,
      assemblyEnvelopeUpperBoundBytes: 0, sessionMaxRecordBytes, sourceEvents: facts.index.sourceEvents, sourceBytes: facts.index.sourceBytes,
      units: facts.units.length }, request, provenance, rendererVersion: 'context-neutral/v1', requestDigest: digest(request),
  }
  try { inspectBoundedJson(candidate, { ...contextJsonCeiling, maxDepth: profile.budget.maxJsonDepth, maxNodes: profile.budget.maxJsonNodes }) }
  catch (reason) {
    if (reason instanceof JsonBoundaryError && reason.reason !== 'invalid') {
      const maximum = reason.reason === 'bytes' ? contextJsonCeiling.maxBytes
        : reason.reason === 'depth' ? profile.budget.maxJsonDepth : profile.budget.maxJsonNodes
      return { kind: 'resource-limit', limit: 'report', maximum }
    }
    return invalidContext('assembly-report')
  }
  const assembly = measureAssemblyEnvelope(facts.index.snapshot.header, facts.index.snapshot.localPosition, candidate)
  const size = assembly.budget.assemblyEnvelopeUpperBoundBytes
  if (size > profile.budget.maxAssemblyBytes) return { kind: 'budget-exceeded', limit: 'assembly-bytes', required: size, available: profile.budget.maxAssemblyBytes, references: required }
  if (size > sessionMaxRecordBytes) return { kind: 'budget-exceeded', limit: 'session-record-bytes', required: size, available: sessionMaxRecordBytes, references: required }
  const frozen = snapshotJson(assembly) as ContextAssembly
  return Object.freeze({ kind: 'ready', assembly: frozen, request: frozen.request })
}
