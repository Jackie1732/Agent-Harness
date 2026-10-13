import { beforeAll, expect, it } from 'vitest'
import type { JsonObject, SessionSnapshot } from '../../src/index.js'
import { sessionLogPosition } from '../../src/session/ids.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { projectModelSession } from '../../src/model/projection.js'
import { agentStepDecidedEvent } from '../../src/agent/session-events.js'
import { modelPreparedEvent } from '../../src/model/session-events.js'
import { agentFixture } from './fixtures.js'
import { auditedAgent } from './audit-fixtures.js'

let snapshot: SessionSnapshot

beforeAll(async () => {
  const fixture = await agentFixture(), agent = auditedAgent(fixture)
  try {
    await agent.submitInput({ kind: 'task', text: 'first model source', originLabel: 'source-test' })
    await agent.submitInput({ kind: 'task', text: 'second model source', originLabel: 'source-test' })
    const result = await agent.start()
    expect(result.roots.map(root => root.outcome)).toEqual(['completed', 'completed'])
    snapshot = fixture.session.snapshot()
  } finally { await agent.dispose(); await fixture.close() }
})

function prefix(through: number): SessionSnapshot {
  const local = snapshot.history.at(-1)!, position = sessionLogPosition(through)
  return { ...snapshot, localPosition: position, history: [...snapshot.history.slice(0, -1),
    { ...local, through: position, events: local.events.slice(0, through) }] }
}

function changePayload(position: number, change: (payload: JsonObject) => JsonObject): SessionSnapshot {
  const local = snapshot.history.at(-1)!
  const events = local.events.map(event => {
    if (event.stored.sequence !== position || event.kind !== 'known') return event
    const payload = change(event.payload as JsonObject)
    return { ...event, payload, stored: { ...event.stored, payload } }
  })
  return { ...snapshot, history: [...snapshot.history.slice(0, -1), { ...local, events }] }
}

function decisions() {
  return snapshot.history.at(-1)!.events.filter(event => event.kind === 'known' && event.stored.type === agentStepDecidedEvent.type)
    .map(event => ({ event, payload: agentStepDecidedEvent.decode(event.stored.payload) }))
}

it('replays every committed prefix including an unsettled Model and both completed roots', () => {
  for (let through = 1; through <= snapshot.localPosition; through++) expect(() => projectAgentSession(prefix(through))).not.toThrow()
  expect(projectAgentSession(snapshot).roots.map(root => root.outcome)).toEqual(['completed', 'completed'])
  expect(projectModelSession(snapshot).invocations).toHaveLength(2)
})

it('refuses a Model settlement that exists only after the current Agent decision', () => {
  const [first, second] = decisions()
  const changed = changePayload(first!.event.stored.sequence, payload => ({ ...payload, model: second!.payload.model }))
  expect(() => projectAgentSession(changed)).toThrowError(expect.objectContaining({
    code: 'AGENT_STATE_INVALID', details: { reasonCode: 'missing-or-future-source' },
  }))
})

it('refuses an earlier settlement in place of the current invocation', () => {
  const [first, second] = decisions()
  const changed = changePayload(second!.event.stored.sequence, payload => ({ ...payload,
    model: { ...second!.payload.model!, settled: first!.payload.model!.settled } }))
  expect(() => projectAgentSession(changed)).toThrowError(expect.objectContaining({
    code: 'AGENT_STATE_INVALID', details: { reasonCode: 'model-source' },
  }))
})

it('refuses another invocation identity even when the exact settlement is in the current prefix', () => {
  const [first, second] = decisions()
  const changed = changePayload(second!.event.stored.sequence, payload => ({ ...payload,
    model: { ...second!.payload.model!, invocationId: first!.payload.model!.invocationId } }))
  expect(() => projectAgentSession(changed)).toThrowError(expect.objectContaining({
    code: 'AGENT_STATE_INVALID', details: { reasonCode: 'model-source' },
  }))
})

it('refuses an assembly belonging to a different completed step', () => {
  const [first, second] = decisions()
  const changed = changePayload(second!.event.stored.sequence, payload => ({ ...payload,
    model: { ...second!.payload.model!, assembly: first!.payload.model!.assembly } }))
  expect(() => projectAgentSession(changed)).toThrowError(expect.objectContaining({
    code: 'AGENT_STATE_INVALID', details: { reasonCode: 'model-assembly-source' },
  }))
})

for (const changedField of ['fingerprint', 'wireBody'] as const) it(`validates the durable Prepared ${changedField} before reusing its Model facts`, () => {
  const prepared = snapshot.history.at(-1)!.events.find(event => event.stored.type === modelPreparedEvent.type)!
  const changed = changePayload(prepared.stored.sequence, payload => {
    const submission = payload.submission as JsonObject
    return { ...payload, submission: changedField === 'fingerprint' ? { ...submission, fingerprint: '0'.repeat(64) }
      : { ...submission, wireBody: { ...(submission.wireBody as JsonObject), tampered: true } } }
  })
  expect(() => projectModelSession(changed)).toThrowError(expect.objectContaining({ code: 'MODEL_STATE_INVALID' }))
  expect(() => projectAgentSession(changed)).toThrowError(expect.objectContaining({ code: 'MODEL_STATE_INVALID' }))
})

for (const budget of ['maxInputBytes', 'maxNormalizedResultBytes'] as const) it(`enforces the durable ${budget} while observing an Agent decision`, () => {
  const invocation = projectModelSession(snapshot).invocations[0]!
  if (invocation.state !== 'settled') throw new Error('fixture model is not settled')
  const limit = budget === 'maxInputBytes' ? 1 : Buffer.byteLength(JSON.stringify(invocation.settled.payload.result)) - 1
  const changed = changePayload(invocation.prepared.stored.sequence, payload => ({ ...payload,
    limits: { ...(payload.limits as JsonObject), [budget]: limit } }))
  expect(() => projectModelSession(changed)).toThrowError(expect.objectContaining({ code: 'MODEL_STATE_INVALID' }))
  expect(() => projectAgentSession(changed)).toThrowError(expect.objectContaining({ code: 'MODEL_STATE_INVALID' }))
})

it('derives classification from the validated result rather than trusting the Agent decision', () => {
  const [first] = decisions()
  const changed = changePayload(first!.event.stored.sequence, payload => ({ ...payload, classification: 'actions' }))
  expect(() => projectAgentSession(changed)).toThrowError(expect.objectContaining({
    code: 'AGENT_STATE_INVALID', details: { reasonCode: 'model-decision-mismatch' },
  }))
})
