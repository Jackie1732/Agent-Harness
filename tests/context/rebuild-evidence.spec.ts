import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  SessionContext,
  communicationSessionEventDefinitions,
  decodeMessageEnvelope,
  formatSessionAddress,
  messageEnvelopeDigest,
  parseChannelId,
  parseMessageId,
  parseSessionId,
  projectContextSession,
  readAssembly,
  rebuildAssembly,
} from '../../src/index.js'
import type { ContextAssembly, SessionEventId, SessionSnapshot } from '../../src/index.js'
import { inboxAcceptedEvent, inboxProcessedEvent } from '../../src/communication/session-events.js'
import { canonicalJsonBytes } from '../../src/foundation/canonical-json.js'
import { emptyMessageCatalog, profile, repository, scriptedModel, selection } from './fixtures.js'

async function recordedAssembly() {
  const repo = repository(undefined, communicationSessionEventDefinitions)
  const provider = scriptedModel()
  const session = await repo.create()
  const context = new SessionContext({ session, messageCatalog: emptyMessageCatalog })
  const originalProfile = await context.recordProfile(profile())
  const input = await context.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'replay', text: 'original input' })
  const memory = await context.recordMemory({ key: 'evidence', previousEventId: null, text: 'original memory', tags: ['research'],
    origin: { kind: 'host-authored', originLabel: 'replay', relatedTo: [{ eventId: input.stored.eventId, selector: 'user-input' }] } })
  const built = await context.assemble(selection(originalProfile.stored.eventId, provider.descriptor, {
    requiredInputs: [{ eventId: input.stored.eventId, selector: 'user-input' }],
    memory: { required: [{ eventId: memory.stored.eventId, selector: 'memory' }], query: { requiredTags: [], queryTags: [], topK: 0 } },
  }))
  if (built.kind !== 'ready') throw new Error('fixture requires a committed Assembly')
  return { repo, session, context, provider, originalProfile, memory, built,
    async close() { await context.dispose(); await provider.dispose(); await repo.dispose() } }
}

function replaceAssembly(snapshot: SessionSnapshot, id: SessionEventId, update: (original: ContextAssembly) => ContextAssembly): SessionSnapshot {
  const changed = structuredClone(snapshot)
  const event = changed.history.at(-1)!.events.find(event => event.stored.eventId === id)
  if (event?.kind !== 'known') throw new Error('fixture requires a known Assembly')
  const payload = update(event.payload as ContextAssembly)
  Object.assign(event, { payload, stored: { ...event.stored, payload } })
  return changed
}

describe('Independent Context rebuild evidence', () => {
  it.each(['request', 'provenance', 'source-membership', 'selection', 'budget'] as const)(
    'rejects changed %s even when the saved Request digest remains correct', async change => {
      const f = await recordedAssembly()
      try {
        const snapshot = replaceAssembly(f.session.snapshot(), f.built.committed.stored.eventId, original => {
          switch (change) {
            case 'request': {
              const request = { ...original.request, instructions: ['injected instructions'] }
              return { ...original, request, requestDigest: createHash('sha256').update(canonicalJsonBytes(request)).digest('hex') }
            }
            case 'provenance': return { ...original, provenance: original.provenance.map((entry, index) => index === 0 ? { ...entry, sourceDigest: '0'.repeat(64) } : entry) }
            case 'source-membership': return { ...original, selected: original.selected.map((unit, index) => index === 0 ? { ...unit, sourceEventIds: [f.originalProfile.stored.eventId] } : unit) }
            case 'selection': return { ...original, selection: { ...original.selection, requiredInputs: [] } }
            case 'budget': return { ...original, budget: { ...original.budget, requestBytes: original.budget.requestBytes + 1 } }
          }
        })
        const inspected = readAssembly(snapshot, f.built.committed.stored.eventId)
        expect(inspected.committed.payload.requestDigest).toBe(createHash('sha256').update(canonicalJsonBytes(inspected.committed.payload.request)).digest('hex'))
        expect(() => rebuildAssembly(snapshot, f.built.committed.stored.eventId)).toThrowError(expect.objectContaining({ code: 'CONTEXT_STATE_INVALID' }))
      } finally { await f.close() }
    },
  )

  it('keeps an unfamiliar renderer inspectable while refusing to substitute the current renderer', async () => {
    const f = await recordedAssembly()
    try {
      const snapshot = replaceAssembly(f.session.snapshot(), f.built.committed.stored.eventId, original => ({ ...original, rendererVersion: 'context-neutral/future' }))
      expect(readAssembly(snapshot, f.built.committed.stored.eventId).committed.payload.rendererVersion).toBe('context-neutral/future')
      expect(rebuildAssembly(snapshot, f.built.committed.stored.eventId)).toEqual({ kind: 'unsupported', version: 'context-neutral/future' })
    } finally { await f.close() }
  })

  it('retains an unfamiliar Compaction algorithm for inspection and reports it when rebuilding a dependent Assembly', async () => {
    const f = await recordedAssembly()
    try {
      const input = await f.context.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'compaction', text: 'original long evidence '.repeat(1000) })
      const compacted = await f.context.compact({ profileEventId: f.originalProfile.stored.eventId,
        history: { mode: 'local-suffix', representation: 'raw' }, units: [{ eventId: input.stored.eventId, selector: 'user-input' }],
        protectedRefs: [], maxExcerptBytes: 16 })
      if (compacted.kind !== 'committed') throw new Error('fixture requires beneficial Compaction')
      const assembled = await f.context.assemble(selection(f.originalProfile.stored.eventId, f.provider.descriptor, { compactions: [compacted.committed.stored.eventId] }))
      if (assembled.kind !== 'ready') throw new Error('fixture requires a dependent Assembly')
      const snapshot = structuredClone(f.session.snapshot())
      const event = snapshot.history.at(-1)!.events.find(event => event.stored.eventId === compacted.committed.stored.eventId)
      if (event?.kind !== 'known') throw new Error('fixture requires a known Compaction')
      const payload = { ...compacted.committed.payload, algorithm: { ...compacted.committed.payload.algorithm, name: 'excerpt-history/future' } }
      Object.assign(event, { payload, stored: { ...event.stored, payload } })
      expect(projectContextSession(snapshot).compactions[0]?.payload.algorithm.name).toBe('excerpt-history/future')
      expect(readAssembly(snapshot, assembled.committed.stored.eventId).committed.payload).toEqual(assembled.committed.payload)
      expect(rebuildAssembly(snapshot, assembled.committed.stored.eventId)).toEqual({ kind: 'unsupported', version: 'excerpt-history/future' })
    } finally { await f.close() }
  })

  it('rebuilds the complete original candidate after later Profile, Memory and Inbox changes', async () => {
    const f = await recordedAssembly()
    try {
      await f.context.recordProfile(profile('generation', { previousEventId: f.originalProfile.stored.eventId,
        sections: [{ name: 'new-rules', slot: 'rules', ordinal: 0, text: 'later private rule', originLabel: 'later' }] }))
      await f.context.retractMemory({ key: f.memory.payload.key, previousEventId: f.memory.stored.eventId, reasonCode: 'superseded' })
      await f.context.recordMemory({ key: 'later-memory', previousEventId: null, text: 'later private memory', tags: [],
        origin: { kind: 'host-authored', originLabel: 'later', relatedTo: [] } })
      const messageId = parseMessageId('50000000-0000-4000-8000-000000000201')
      const envelope = decodeMessageEnvelope({ envelopeVersion: 1, messageId,
        sender: formatSessionAddress(parseSessionId('30000000-0000-4000-8000-000000000299')), recipient: f.session.header.address,
        channelId: parseChannelId('40000000-0000-4000-8000-000000000201'), channelSequence: 1, correlationId: messageId,
        createdAt: '2026-10-11T00:00:00.000Z', type: 'context/later', payloadVersion: 1, payload: { text: 'later private message' } })
      await f.session.append(inboxAcceptedEvent, { envelope, digest: messageEnvelopeDigest(envelope) })
      await f.session.append(inboxProcessedEvent, { messageId })
      await f.context.dispose()
      await f.provider.dispose()
      const rebuilt = rebuildAssembly(f.session.snapshot(), f.built.committed.stored.eventId)
      expect(rebuilt.kind).toBe('rebuilt')
      if (rebuilt.kind !== 'rebuilt') throw new Error('fixture requires a rebuilt Assembly')
      expect(JSON.stringify(rebuilt.request)).not.toContain('later private')
      expect(rebuilt.assembly).toEqual(f.built.committed.payload)
      expect(rebuilt.request).toEqual(f.built.request)
      expect(rebuilt.assembly.selected).toContainEqual(expect.objectContaining({ reference: { eventId: f.memory.stored.eventId, selector: 'memory' } }))
    } finally { await f.close() }
  })
})
