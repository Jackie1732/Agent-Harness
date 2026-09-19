import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FileSessionBackend,
  SessionRepository,
  acquireHostStorageLock,
  decodeHostConfig,
  initializeHost,
  openHost,
  parseSessionId,
  recoverHost,
  resolveHostConfig,
  systemClock,
} from '../../src/index.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { agentRunStartedEvent } from '../../src/agent/session-events.js'
import { hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { hostConfig } from './fixtures.js'

describe('Host recovery', () => {
  it('blocks ordinary open and reconciles an interrupted Run without Providers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-host-recovery-'))
    const spec = resolveHostConfig(decodeHostConfig(hostConfig(root), root))
    await initializeHost(spec)
    const lock = await acquireHostStorageLock(root, 'test-host')
    const repository = new SessionRepository({ backend: new FileSessionBackend({ root: lock.root, maxRecordBytes: spec.storage.maxRecordBytes }),
      catalog: hostRuntimeEventCatalog, maxLineageDepth: spec.storage.maxLineageDepth })
    const session = await repository.open(parseSessionId(spec.members[0]!.sessionId!))
    const installed = projectAgentSession(session.snapshot()).spec!
    await session.append(agentRunStartedEvent, { spec: installed.stored.eventId, kind: 'drive' })
    await repository.dispose(); await lock.dispose()

    await expect(openHost(spec)).rejects.toMatchObject({ code: 'HOST_RECOVERY_REQUIRED' })
    const recovered = await recoverHost(spec, { predecessorStopped: true, maxRecoveryWrites: 10,
      maxJournalConflicts: 4, clock: systemClock })
    expect(recovered[0]?.result.kind).toBe('recovered')
    const host = await openHost(spec)
    await host.shutdown()
  })
})
