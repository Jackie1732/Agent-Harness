import { expect, it } from 'vitest'
import { foldAgentSession } from '../../src/agent/projection.js'
import { AgentJournal } from '../../src/agent/journal.js'
import { WorkflowJournal } from '../../src/workflow/journal.js'
import { nextWorkPublication } from '../../src/workflow/publication.js'
import { artifactPublishedEvent, workExecutionReleasedEvent, workProposalRecordedEvent } from '../../src/workflow/result-events.js'
import { workflowDecisionCommittedEvent, workflowProposalReceivedEvent } from '../../src/workflow/coordinator-events.js'
import { workProtocolRecordedEvent, workflowSourceCommands } from '../../src/workflow/protocol.js'
import { decodeWorkflowProposalMessage } from '../../src/workflow/result-events.js'
import { projectWorkflowSession } from '../../src/workflow/projection.js'
import { workflowProposalMessage } from '../../src/workflow/messages.js'
import { clock } from '../agent/fixtures.js'
import { workFixture } from './work-fixture.js'

async function complete(f: Awaited<ReturnType<typeof workFixture>>, outcome: 'released' | 'unknown' = 'released') {
  const accepted = await f.assign()
  await f.agent.start({ selection: { kind: 'workflow', assignment: accepted.payload.assignment } })
  expect(nextWorkPublication(f.session, clock)).toBeUndefined()
  const root = f.agent.snapshot().roots[0]!
  await f.agent.dispose()
  await f.provider?.dispose()
  const release = await f.journal.append(workExecutionReleasedEvent, () => ({ assignment: accepted.payload.assignment,
    accepted: accepted.stored.eventId, root: root.id, owner: 'test-host', generation: 1, outcome }))
  return { accepted, root, release }
}

it('publishes immutable text only after release and accepts the exact received candidate once', async () => {
  const f = await workFixture(false, 2, { kind: 'text', name: 'result' }, 'confirmed text')
  try {
    const { accepted, root, release } = await complete(f)
    await nextWorkPublication(f.session, clock)!()
    await nextWorkPublication(f.session, clock)!()
    expect(nextWorkPublication(f.session, clock)).toBeUndefined()
    const sources = foldAgentSession(f.session.snapshot()).sources
    const artifact = [...sources.values()].find(item => item.stored.type === artifactPublishedEvent.type)!
    expect(artifact.payload).toMatchObject({ text: 'confirmed text', byteLength: 14, name: 'result' })
    const proposal = [...sources.values()].find(item => item.stored.type === workProposalRecordedEvent.type)!
    const protocol = await new AgentJournal(f.session, 4, clock).append(workProtocolRecordedEvent,
      () => workflowSourceCommands(sources, proposal.stored.eventId))
    const command = protocol.payload.commands[0]!
    if (command.kind !== 'send') throw new Error('Expected send')
    const sent = await f.receiver.sendOnce({ eventId: protocol.stored.eventId, index: 0 }, command.request, command)
    const repeated = await f.receiver.sendOnce({ eventId: protocol.stored.eventId, index: 0 }, command.request, command)
    expect(repeated.messageId).toBe(sent.messageId)
    await f.service.createDispatcher(f.receiver).dispatch()
    const inbox = f.sender.snapshot().inbox[0]!
    const received = decodeWorkflowProposalMessage(inbox.envelope.payload)
    const coordinator = new WorkflowJournal(f.coordinator, clock)
    await coordinator.append(workflowProposalReceivedEvent, () => ({ definition: f.saved.stored.eventId,
      inbox: inbox.acceptedEventId, message: received }))
    const decision = { definition: f.saved.stored.eventId, assignment: accepted.payload.assignment,
      proposal: received.proposal, expectedOutputRevision: 0 as const, outcome: 'accepted' as const,
      value: received.value.value, artifacts: received.value.artifacts, reviews: [] }
    await expect(coordinator.append(workflowDecisionCommittedEvent, () => ({ ...decision, value: 'replaced' }))).rejects.toThrow('decision-source')
    const competing = await Promise.allSettled([coordinator.append(workflowDecisionCommittedEvent, () => decision),
      new WorkflowJournal(f.coordinator, clock).append(workflowDecisionCommittedEvent, () => decision)])
    expect(competing.filter(item => item.status === 'fulfilled')).toHaveLength(1)
    expect(competing.filter(item => item.status === 'rejected')).toHaveLength(1)
    expect(projectWorkflowSession(f.coordinator.snapshot()).decisions).toHaveLength(1)
    await expect(coordinator.append(workflowDecisionCommittedEvent, () => decision)).rejects.toThrow('decision-source')
    await expect(f.journal.append(artifactPublishedEvent, () => ({ ...artifactPublishedEvent.decode(artifact.payload),
      accepted: accepted.stored.eventId, root: root.id, executionRelease: release.stored.eventId }))).rejects.toThrow('work-proposal-already-published')
    await expect(f.receiver.send(workflowProposalMessage, command.request, command.payload)).rejects.toThrow('workflow-send-requires-durable-source')
    await expect(f.receiver.sendOnce({ eventId: accepted.stored.eventId, index: 0 }, command.request, command)).rejects.toThrow('workflow-send-source')
  } finally { await f.close() }
})

it.each([
  ['escaped message bytes', '\\"\n'.repeat(1800), 16384, 'released', 'workflow-message-bytes'],
  ['unknown execution release', 'valid text', 128 * 1024, 'unknown', 'work-result-unknown'],
] as const)('publishes bounded failure without partial artifacts for %s', async (_label, text, limit, outcome, reason) => {
  const f = await workFixture(false, 2, { kind: 'text', name: 'result' }, text, limit)
  try {
    await complete(f, outcome)
    await nextWorkPublication(f.session, clock)!()
    const sources = [...foldAgentSession(f.session.snapshot()).sources.values()]
    expect(sources.some(item => item.stored.type === artifactPublishedEvent.type)).toBe(false)
    expect(sources.find(item => item.stored.type === workProposalRecordedEvent.type)?.payload).toMatchObject({
      outcome: outcome === 'unknown' ? 'result-unknown' : 'failed', reason, value: null, artifacts: [],
    })
  } finally { await f.close() }
})

it('keeps an accepted JSON value and declared text artifacts exact, without repairing fenced output', async () => {
  const output = { kind: 'json' as const, schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    artifacts: [{ name: 'summary', source: { kind: 'json-text' as const, path: ['text'] } }] }
  const f = await workFixture(false, 2, output, '{"text":"immutable"}')
  try {
    await complete(f)
    await nextWorkPublication(f.session, clock)!()
    const stored = [...foldAgentSession(f.session.snapshot()).sources.values()].find(item => item.stored.type === artifactPublishedEvent.type)!
    expect(stored.payload).toMatchObject({ text: 'immutable', source: { kind: 'json-text', path: ['text'] } })
    await nextWorkPublication(f.session, clock)!()
    expect(nextWorkPublication(f.session, clock)).toBeUndefined()
  } finally { await f.close() }
  const invalid = await workFixture(false, 2, output, '```json\n{"text":"not accepted"}\n```')
  try {
    await complete(invalid)
    await nextWorkPublication(invalid.session, clock)!()
    const failure = [...foldAgentSession(invalid.session.snapshot()).sources.values()].find(item => item.stored.type === workProposalRecordedEvent.type)!
    expect(failure.payload).toMatchObject({ outcome: 'failed', reason: 'output-json', value: null, artifacts: [] })
    expect(invalid.agent.snapshot().roots[0]?.outcome).toBe('completed')
    expect([...foldAgentSession(invalid.session.snapshot()).sources.values()].some(item => item.stored.type === artifactPublishedEvent.type)).toBe(false)
  } finally { await invalid.close() }
})
