import { describe, expect, it } from 'vitest'
import { createDurableEventCatalog } from '../../src/session/event-catalog.js'
import { MemorySessionBackend } from '../../src/session/memory-backend.js'
import { parseSessionId } from '../../src/session/ids.js'
import { SessionRepository } from '../../src/session/repository.js'
import { projectWorkflowSession } from '../../src/workflow/projection.js'
import { workflowDefinitionRecordedEvent, workflowNodeResolvedEvent } from '../../src/workflow/session-events.js'
import { workflowFixture } from './fixtures.js'

describe('workflow definition replay', () => {
  it('reopens a coordinator and recovers the same definition and initial ready set', async () => {
    const repo = new SessionRepository({ backend: new MemorySessionBackend({ maxRecordBytes: 256 * 1024 }),
      catalog: createDurableEventCatalog([workflowDefinitionRecordedEvent, workflowNodeResolvedEvent]), maxLineageDepth: 4 })
    const sessionId = parseSessionId('87000000-0000-4000-8000-000000000001')
    const first = await repo.create({ sessionId })
    expect(projectWorkflowSession(first.snapshot()).definition).toBeNull()
    await first.append(workflowDefinitionRecordedEvent, { definition: workflowFixture() })
    const recorded = projectWorkflowSession(first.snapshot())
    expect(recorded.ready).toEqual(['read'])
    await first.append(workflowNodeResolvedEvent, { definition: recorded.definition!.stored.eventId,
      nodeKey: 'read', outcome: 'skipped', reason: 'guard-false' })
    const decided = projectWorkflowSession(first.snapshot())
    expect(decided.ready).toEqual([])
    expect(decided.resolved).toMatchObject([{ nodeKey: 'read', outcome: 'skipped' }])
    await first.dispose()
    const reopened = await repo.open(sessionId)
    expect(projectWorkflowSession(reopened.snapshot())).toEqual(decided)
    await reopened.append(workflowNodeResolvedEvent, { definition: recorded.definition!.stored.eventId,
      nodeKey: 'read', outcome: 'skipped', reason: 'guard-false' })
    expect(() => projectWorkflowSession(reopened.snapshot())).toThrow('resolution-conflict')
    await reopened.dispose()
    await repo.dispose()
  })
})
