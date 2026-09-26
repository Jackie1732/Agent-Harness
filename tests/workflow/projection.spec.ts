import { describe, expect, it } from 'vitest'
import { createDurableEventCatalog } from '../../src/session/event-catalog.js'
import { MemorySessionBackend } from '../../src/session/memory-backend.js'
import { parseSessionId } from '../../src/session/ids.js'
import { SessionRepository } from '../../src/session/repository.js'
import { projectWorkflowSession } from '../../src/workflow/projection.js'
import { workflowAssignmentCommittedEvent, workflowDefinitionRecordedEvent, workflowNodeResolvedEvent } from '../../src/workflow/session-events.js'
import { workflowAssignmentMailboxDemand } from '../../src/workflow/protocol-capacity.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import type { WorkflowDefinition } from '../../src/workflow/types.js'
import type { SessionEventId } from '../../src/session/ids.js'
import { snapshotJson } from '../../src/foundation/json.js'
import { workflowFixture } from './fixtures.js'

function rootAssignment(definition: WorkflowDefinition, definitionId: SessionEventId) {
  const node = definition.nodes[0]!
  const trial = node.attempts[0]!
  return snapshotJson({ definition: definitionId, nodeKey: node.nodeKey, attempt: 1, kind: 'production',
    memberKey: node.executor, memberAddress: definition.roster[0]!.address,
    channelId: '71000000-0000-4000-8000-000000000101',
    inputs: {}, sourceAccepted: [], effectiveAllowance: trial.workerGrant,
    reviewerReservations: trial.reviewerGrants, toolNames: trial.toolNames, nativeActions: trial.nativeActions,
    workspace: trial.workspace, workspaceBaseline: null,
    protocolReserve: workflowAssignmentMailboxDemand(definition, 'production'),
    deadline: new Date(Date.now() + 30_000).toISOString(), acceptance: node.acceptance })
}

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
    await first.dispose()
    const reopened = await repo.open(sessionId)
    expect(projectWorkflowSession(reopened.snapshot())).toEqual(recorded)
    await reopened.append(workflowNodeResolvedEvent, { definition: recorded.definition!.stored.eventId,
      nodeKey: 'read', outcome: 'skipped', reason: 'guard-false' })
    expect(() => projectWorkflowSession(reopened.snapshot())).toThrow('resolution-not-derived')
    await reopened.dispose()
    await repo.dispose()
  })
})

describe('workflow assignment replay', () => {
  it('records a bounded root assignment and preserves its budget reservation on reopen', async () => {
    const repo = new SessionRepository({ backend: new MemorySessionBackend({ maxRecordBytes: 256 * 1024 }),
      catalog: createDurableEventCatalog([workflowDefinitionRecordedEvent, workflowNodeResolvedEvent, workflowAssignmentCommittedEvent]), maxLineageDepth: 4 })
    const sessionId = parseSessionId('87000000-0000-4000-8000-000000000001')
    const first = await repo.create({ sessionId })
    try {
      const recipe = workflowFixture()
      const definition = decodeWorkflowDefinition(recipe)
      const recorded = await first.append(workflowDefinitionRecordedEvent, { definition: recipe })
      const node = definition.nodes[0]!
      const trial = node.attempts[0]!
      const assignment = rootAssignment(definition, recorded.stored.eventId)
      await first.append(workflowAssignmentCommittedEvent, assignment)
      const projected = projectWorkflowSession(first.snapshot())
      expect(projected.ready).toEqual([])
      expect(projected.assignments).toHaveLength(1)
      expect(projected.reservedBudget).toEqual(trial.workerGrant)
      await first.dispose()
      const reopened = await repo.open(sessionId)
      expect(projectWorkflowSession(reopened.snapshot())).toEqual(projected)
      await reopened.append(workflowAssignmentCommittedEvent, assignment)
      expect(() => projectWorkflowSession(reopened.snapshot())).toThrow('assignment-not-admissible')
      await reopened.dispose()
    } finally { await repo.dispose() }
  })

  it('rejects a persisted assignment that exceeds the workflow budget', async () => {
    const repo = new SessionRepository({ backend: new MemorySessionBackend({ maxRecordBytes: 256 * 1024 }),
      catalog: createDurableEventCatalog([workflowDefinitionRecordedEvent, workflowAssignmentCommittedEvent]), maxLineageDepth: 4 })
    const session = await repo.create({ sessionId: parseSessionId('87000000-0000-4000-8000-000000000001') })
    try {
      const recipe = workflowFixture()
      const underfunded = { ...recipe, budget: { ...recipe.budget, models: 1 } }
      const definition = decodeWorkflowDefinition(underfunded)
      const recorded = await session.append(workflowDefinitionRecordedEvent, { definition: underfunded })
      await session.append(workflowAssignmentCommittedEvent, rootAssignment(definition, recorded.stored.eventId))
      expect(() => projectWorkflowSession(session.snapshot())).toThrow('workflow-budget-exceeded')
    } finally { await session.dispose(); await repo.dispose() }
  })
})
