import { snapshotJson } from '../foundation/json.js'
import type { SessionEventId, SessionId, SessionLogPosition } from '../session/ids.js'
import type { CommittedSessionEvent, SessionSnapshot } from '../session/types.js'
import type { ContextAssemblyRead, ContextCompaction, ContextInput, ContextMemoryHead, ContextProfile, ContextRebuildResult } from './contract.js'
import { decodeContextAssembly } from './assembly-codec.js'
import { buildContextFromSources } from './assembly-core.js'
import { resolveSelectedCompactions } from './compaction-replay.js'
import { invalidSource, invalidState } from './errors.js'
import { collectContextFacts } from './history.js'
import { contextModelAdoption } from './model-link.js'
import { prepareContextSources } from './prepare.js'
import { decodeContextProfile } from './profile.js'
import { validateAllMaterialSources } from './references.js'
import { assertEventCut, knownEvent, requireSourceIndex, snapshotAtCut } from './sources.js'
import { decodeCapturedFacts } from './surface-codec.js'
import { equalJson, eventId } from './validation.js'
import { decodeAgentContextAssembly } from './agent-codec.js'
import { assembleAgentContext } from './agent-assembler.js'

export interface ContextSessionSnapshot {
  readonly sessionId: SessionId
  readonly localPosition: SessionLogPosition
  readonly profiles: readonly CommittedSessionEvent<ContextProfile>[]
  readonly profileHeads: readonly { readonly profileKey: string; readonly eventId: SessionEventId }[]
  readonly inputs: readonly CommittedSessionEvent<ContextInput>[]
  readonly memory: readonly ContextMemoryHead[]
  readonly compactions: readonly CommittedSessionEvent<ContextCompaction>[]
  readonly assemblies: readonly ContextAssemblyRead[]
}
/** Local revision heads do not inherit an ancestor's memory, rules, or pending execution. */
export function projectContextSession(snapshot: SessionSnapshot): ContextSessionSnapshot {
  const index = requireSourceIndex(snapshot)
  const facts = collectContextFacts(index, { maxUnits: 10000 })
  if ('kind' in facts) invalidSource('context-projection-unit-limit')
  validateAllMaterialSources(facts)
  const material = facts.local.material
  const result: ContextSessionSnapshot = { sessionId: index.snapshot.header.sessionId, localPosition: index.snapshot.localPosition,
    profiles: material.profiles, profileHeads: [...material.profileHeads].map(([profileKey, eventId]) => ({ profileKey, eventId })),
    inputs: material.inputs, memory: material.memory, compactions: material.compactions,
    assemblies: material.assemblies.map(committed => ({ committed, adoption: contextModelAdoption(index.snapshot, committed) })) }
  return snapshotJson(result) as unknown as ContextSessionSnapshot
}
/** Inspection retains unknown renderer versions; it never silently executes a different renderer. */
export function readAssembly(snapshot: SessionSnapshot, id: SessionEventId): ContextAssemblyRead {
  const index = requireSourceIndex(snapshot)
  const stored = knownEvent(index, eventId(id), 'context/assembly-committed')
  const committed = Object.freeze({ ...stored, payload: [2, 3, 4].includes(stored.stored.payloadVersion) ? decodeAgentContextAssembly(stored.payload, stored.stored.payloadVersion as 2 | 3 | 4) : decodeContextAssembly(stored.payload) })
  assertEventCut(index.snapshot, committed, committed.payload.coverage)
  return Object.freeze({ committed, adoption: contextModelAdoption(index.snapshot, committed) })
}
/** Independent reconstruction compares the full candidate, not just its stored Request or digest. */
export function rebuildAssembly(snapshot: SessionSnapshot, id: SessionEventId): ContextRebuildResult {
  const read = readAssembly(snapshot, id)
  const original = read.committed.payload
  if ([2, 3, 4].includes(read.committed.stored.payloadVersion)) {
    const value = decodeAgentContextAssembly(original, read.committed.stored.payloadVersion as 2 | 3 | 4)
    if (value.rendererVersion !== `context-neutral/v${read.committed.stored.payloadVersion}`) return { kind: 'unsupported', version: value.rendererVersion }
    const result = assembleAgentContext(snapshotAtCut(snapshot, value.coverage), value.consumer, value.captured, value.budget.sessionMaxRecordBytes)
    if (result.kind !== 'ready' || !equalJson(result.assembly, value)) invalidState('agent-assembly-full-content-rebuild')
    return Object.freeze({ kind: 'rebuilt', request: result.request, assembly: result.assembly, adoption: read.adoption })
  }
  if (original.rendererVersion !== 'context-neutral/v1') return { kind: 'unsupported', version: original.rendererVersion }
  const cut = snapshotAtCut(snapshot, original.coverage)
  const index = requireSourceIndex(cut)
  const event = knownEvent(index, original.selection.profileEventId, 'context/profile-recorded')
  const profile = { ...event, payload: decodeContextProfile(event.payload) }
  const prepared = prepareContextSources(cut, profile, original.selection)
  if ('kind' in prepared) invalidState('assembly-source-rebuild')
  const compactions = resolveSelectedCompactions(prepared)
  if ('kind' in compactions) return compactions
  const result = buildContextFromSources(prepared, decodeCapturedFacts(original.captured), original.budget.sessionMaxRecordBytes, compactions)
  if (result.kind !== 'ready' || !equalJson(result.assembly, original)) invalidState('assembly-full-content-rebuild')
  return Object.freeze({ kind: 'rebuilt', request: result.request, assembly: result.assembly, adoption: read.adoption })
}
