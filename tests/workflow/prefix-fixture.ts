import { MemorySessionBackend } from '../../src/session/memory-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import { sessionLogPosition } from '../../src/session/ids.js'
import type { SessionSnapshot } from '../../src/session/types.js'
import type { SessionHandle } from '../../src/session/session-handle.js'
import { hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { recoverAgentSession } from '../../src/agent/recovery.js'
import { projectAgentSession } from '../../src/agent/projection.js'

/** Copy a real stopped prefix into an isolated journal and reconcile without execution bindings. */
export async function recoverWorkPrefix(snapshot: SessionSnapshot, count: number, maxRecordBytes: number,
  interleave?: (session: SessionHandle) => Promise<void>) {
  const backend = new MemorySessionBackend({ maxRecordBytes })
  await seedWorkPrefix(backend, snapshot, count)
  const repository = new SessionRepository({ backend, catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
  try {
    const session = await repository.open(snapshot.header.sessionId)
    await interleave?.(session)
    const result = await recoverAgentSession(session, { predecessorStopped: true, supersedes: null,
      maxRecoveryWrites: 16, maxJournalConflicts: 4, clock: { now: () => Date.now() } })
    return { result, state: projectAgentSession(session.snapshot()), added: session.snapshot().history.at(-1)!.events.slice(count) }
  } finally { await repository.dispose() }
}

/** Preserve real event identities when constructing a causally closed multi-Session cut. */
export async function seedWorkPrefix(backend: MemorySessionBackend, snapshot: SessionSnapshot, count: number) {
  await backend.create(snapshot.header)
  const writer = await backend.openWriter(snapshot.header.sessionId)
  for (const event of snapshot.history.at(-1)!.events.slice(0, count)) await writer.append(sessionLogPosition(event.stored.sequence - 1), event.stored)
  await writer.dispose()
}
