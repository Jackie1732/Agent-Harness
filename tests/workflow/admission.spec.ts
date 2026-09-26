import { describe, expect, it } from 'vitest'
import { createDurableEventCatalog } from '../../src/session/event-catalog.js'
import { MemorySessionBackend } from '../../src/session/memory-backend.js'
import { parseSessionId } from '../../src/session/ids.js'
import { SessionRepository } from '../../src/session/repository.js'
import { parseChannelId } from '../../src/communication/ids.js'
import { ProtocolCapacity } from '../../src/communication/protocol-capacity.js'
import { systemClock } from '../../src/foundation/clock.js'
import { WorkflowAdmission } from '../../src/workflow/admission.js'
import { projectWorkflowSession } from '../../src/workflow/projection.js'
import { workflowAssignmentCommittedEvent, workflowDefinitionRecordedEvent } from '../../src/workflow/session-events.js'
import { workflowFixture } from './fixtures.js'

function recipe() {
  const base = workflowFixture()
  return { ...base, limits: { ...base.limits, maxProtocolMessages: 12, maxQuestions: 0, maxIncomingQuestions: 0,
    maxGroups: 0, maxGroupRecipients: 0, maxIncomingGroupMessages: 0, maxProgress: 0 } }
}
function capacity(maxPending = 4, maxMessageBytes = 128 * 1024) {
  return new ProtocolCapacity({ maxMessageBytes, maxPendingInbox: maxPending, maxPendingOutbox: maxPending,
    maxDeliveryAttempts: 3, maxAttemptsPerRun: 3, maxSendJournalConflicts: 4 })
}

describe('Workflow CP-W admission', () => {
  it('commits once under the shared mailbox gate and restores the reservation after reopen', async () => {
    const repo = new SessionRepository({ backend: new MemorySessionBackend({ maxRecordBytes: 256 * 1024 }),
      catalog: createDurableEventCatalog([workflowDefinitionRecordedEvent, workflowAssignmentCommittedEvent]), maxLineageDepth: 4 })
    const coordinatorId = parseSessionId('87000000-0000-4000-8000-000000000001')
    const memberId = parseSessionId('87000000-0000-4000-8000-000000000002')
    const coordinator = await repo.create({ sessionId: coordinatorId })
    const member = await repo.create({ sessionId: memberId })
    try {
      await coordinator.append(workflowDefinitionRecordedEvent, { definition: recipe() })
      const shared = capacity()
      let tick = Date.now()
      const admission = new WorkflowAdmission(coordinator, shared, { now: () => tick++ })
      let checked = 0
      const assignment = await admission.admitRoot('read', member, parseChannelId('71000000-0000-4000-8000-000000000101'), () => { checked++ })
      expect(checked).toBe(1)
      expect(projectWorkflowSession(coordinator.snapshot()).assignments).toHaveLength(1)
      expect(shared.hasCapacity(member, 'outbox')).toBe(true)
      await expect(admission.admitRoot('read', member, assignment.payload.channelId, () => { checked++ }))
        .rejects.toThrow('node-not-ready')
      expect(checked).toBe(2)
      await coordinator.dispose(); await member.dispose()
      const reopenedCoordinator = await repo.open(coordinatorId)
      const reopenedMember = await repo.open(memberId)
      const restored = capacity()
      await new WorkflowAdmission(reopenedCoordinator, restored, systemClock).restore(assignment, reopenedMember)
      await expect(restored.run(async () => restored.check(new Map([[reopenedMember.header.address,
        { inbox: 2, outbox: 2 }]]), new Map([[reopenedMember.header.address, reopenedMember]]))))
        .rejects.toThrow('reservation exceeds capacity')
      await reopenedCoordinator.dispose(); await reopenedMember.dispose()
    } finally { await repo.dispose() }
  })

  it('rejects insufficient mailbox capacity and current Host policy before CP-W', async () => {
    const repo = new SessionRepository({ backend: new MemorySessionBackend({ maxRecordBytes: 256 * 1024 }),
      catalog: createDurableEventCatalog([workflowDefinitionRecordedEvent, workflowAssignmentCommittedEvent]), maxLineageDepth: 4 })
    const coordinator = await repo.create({ sessionId: parseSessionId('87000000-0000-4000-8000-000000000001') })
    const member = await repo.create({ sessionId: parseSessionId('87000000-0000-4000-8000-000000000002') })
    try {
      await coordinator.append(workflowDefinitionRecordedEvent, { definition: recipe() })
      const channel = parseChannelId('71000000-0000-4000-8000-000000000101')
      const denied = new WorkflowAdmission(coordinator, capacity(), systemClock)
      await expect(denied.admitRoot('read', member, channel, () => { throw new Error('host-policy-denied') }))
        .rejects.toThrow('host-policy-denied')
      const oversized = new WorkflowAdmission(coordinator, capacity(4, 4096), systemClock)
      await expect(oversized.admitRoot('read', member, channel, () => undefined)).rejects.toThrow('workflow-message-bytes')
      const full = new WorkflowAdmission(coordinator, capacity(2), systemClock)
      await expect(full.admitRoot('read', member, channel, () => undefined)).rejects.toThrow('reservation exceeds capacity')
      expect(projectWorkflowSession(coordinator.snapshot()).assignments).toHaveLength(0)
    } finally { await coordinator.dispose(); await member.dispose(); await repo.dispose() }
  })
})
