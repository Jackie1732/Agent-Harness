import { expect, it } from 'vitest'
import { agentFixture, clock, openStep } from './fixtures.js'
import { recoverAgentSession } from '../../src/agent/recovery.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { agentControlRequestedEvent } from '../../src/agent/session-events.js'

it('recovers an undecided step without invoking providers or rerunning the input', async () => {
  const f = await agentFixture()
  try {
    await openStep(f)
    const recovered = await recoverAgentSession(f.session, { predecessorStopped: true, supersedes: null, maxRecoveryWrites: 10, maxJournalConflicts: 4, clock })
    expect(recovered.kind).toBe('recovered')
    expect(recovered.report.inputs[0]?.status).toBe('review-required')
    expect(recovered.report.roots[0]).toMatchObject({ outcome: 'failed', budget: { models: 1 } })
    expect(projectAgentSession(f.session.snapshot()).openRecovery).toBeNull()
    expect((await recoverAgentSession(f.session, { predecessorStopped: true, supersedes: null, maxRecoveryWrites: 10, maxJournalConflicts: 4, clock })).kind).toBe('nothing-to-recover')
  } finally { await f.close() }
})

it('leaves a resumable open Run when a healthy recovery reaches its explicit write ceiling', async () => {
  const f = await agentFixture()
  try {
    await openStep(f)
    const partial = await recoverAgentSession(f.session, { predecessorStopped: true, supersedes: null, maxRecoveryWrites: 3, maxJournalConflicts: 4, clock })
    expect(partial.kind).toBe('recovery-incomplete')
    expect(partial).toHaveProperty('writes', 3)
    expect(partial.report.openRun).not.toBeNull()
    const completed = await recoverAgentSession(f.session, { predecessorStopped: true, supersedes: null, maxRecoveryWrites: 10, maxJournalConflicts: 4, clock })
    expect(completed.kind).toBe('recovered')
    expect(completed.report.openRun).toBeNull()
  } finally { await f.close() }
})

it('requires the exact stopped recovery identity before superseding a crashed recovery owner', async () => {
  const f = await agentFixture()
  try {
    const opened = await openStep(f)
    const owner = await f.journal.append(agentControlRequestedEvent, (_state, snapshot) => ({ kind: 'recovery' as const, targetRun: opened.run.stored.eventId,
      controls: [], through: snapshot.localPosition, predecessorStopped: true, supersedes: null, maxRecoveryWrites: 10 }))
    await expect(recoverAgentSession(f.session, { predecessorStopped: true, supersedes: null, maxRecoveryWrites: 10, maxJournalConflicts: 4, clock })).rejects.toMatchObject({ code: 'AGENT_RECOVERY_BUSY' })
    const result = await recoverAgentSession(f.session, { predecessorStopped: true, supersedes: owner.stored.eventId, maxRecoveryWrites: 10, maxJournalConflicts: 4, clock })
    expect(result.kind).toBe('recovered')
    expect(projectAgentSession(f.session.snapshot()).controls[0]?.supersededBy).not.toBeNull()
  } finally { await f.close() }
})
