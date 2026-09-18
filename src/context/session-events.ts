import { createDurableEventDefinition } from '../session/event-catalog.js'
import { decodeContextAssembly } from './assembly-codec.js'
import { decodeContextCompaction } from './compaction-codec.js'
import { decodeContextInput } from './input.js'
import { decodeContextMemory, decodeMemoryRetraction } from './memory.js'
import { decodeContextProfile, decodeAgentContextProfile } from './profile.js'
import { decodeAgentContextAssembly } from './agent-codec.js'

export const contextProfileRecordedEvent = createDurableEventDefinition({
  type: 'context/profile-recorded', payloadVersion: 1, ignorable: false, decode: decodeContextProfile,
})
export const contextInputRecordedEvent = createDurableEventDefinition({
  type: 'context/input-recorded', payloadVersion: 1, ignorable: false, decode: decodeContextInput,
})
export const contextMemoryRecordedEvent = createDurableEventDefinition({
  type: 'context/memory-recorded', payloadVersion: 1, ignorable: false, decode: decodeContextMemory,
})
export const contextMemoryRetractedEvent = createDurableEventDefinition({
  type: 'context/memory-retracted', payloadVersion: 1, ignorable: false, decode: decodeMemoryRetraction,
})
export const contextCompactionCommittedEvent = createDurableEventDefinition({
  type: 'context/compaction-committed', payloadVersion: 1, ignorable: false, decode: decodeContextCompaction,
})
export const contextAssemblyCommittedEvent = createDurableEventDefinition({
  type: 'context/assembly-committed', payloadVersion: 1, ignorable: false, decode: decodeContextAssembly,
})

export const agentContextProfileRecordedEvent = createDurableEventDefinition({
  type: 'context/profile-recorded', payloadVersion: 2, ignorable: false, decode: decodeAgentContextProfile,
})
export const agentContextAssemblyCommittedEvent = createDurableEventDefinition({
  type: 'context/assembly-committed', payloadVersion: 2, ignorable: false, decode: decodeAgentContextAssembly,
})

/** Exact identities composed into the Session Catalog; none of these facts is ignorable. */
export const contextSessionEventDefinitions = Object.freeze([
  contextProfileRecordedEvent, contextInputRecordedEvent, contextMemoryRecordedEvent,
  contextMemoryRetractedEvent, contextCompactionCommittedEvent, contextAssemblyCommittedEvent,
  agentContextProfileRecordedEvent, agentContextAssemblyCommittedEvent,
])
