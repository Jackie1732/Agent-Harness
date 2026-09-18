import { expect, it } from 'vitest'
import { agentFixture, openStep } from './fixtures.js'
import { agentSpecRecordedEvent, agentInputAcceptedEvent, agentRunStartedEvent } from '../../src/agent/session-events.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { decodeAgentSpec } from '../../src/agent/spec-codec.js'
import { rebuildAssembly } from '../../src/context/projection.js'

it('rejects replacing an installed Spec and never consumes a second spec event', async () => {
  const f = await agentFixture()
  try {
    const before = f.session.snapshot().localPosition
    await expect(f.journal.append(agentSpecRecordedEvent, () => f.spec)).rejects.toMatchObject({ code: 'AGENT_STATE_INVALID' })
    expect(f.session.snapshot().localPosition).toBe(before)
  } finally { await f.close() }
})

it.each(['unknown', 'native-name', 'reserved-tool', 'infinite-budget', 'getter', 'cycle'] as const)('rejects invalid Spec %s before accepting it', async kind => {
  const f = await agentFixture()
  try {
    const value = structuredClone(f.spec) as unknown as Record<string, unknown>
    if (kind === 'unknown') value.secret = true
    if (kind === 'native-name') value.nativeActions = ['execute_whatever']
    if (kind === 'reserved-tool') value.toolNames = ['agent_ask_user']
    if (kind === 'infinite-budget') value.budget = { ...f.spec.budget, models: Infinity }
    if (kind === 'cycle') value.responsibility = value
    if (kind === 'getter') Object.defineProperty(value, 'label', { enumerable: true, get() { throw new Error('getter must not execute') } })
    expect(() => decodeAgentSpec(value)).toThrowError(expect.objectContaining({ code: 'AGENT_SPEC_INVALID' }))
  } finally { await f.close() }
})

it('does not advance the run cursor after a competing owner is already committed', async () => {
  const f = await agentFixture()
  try {
    await f.journal.append(agentRunStartedEvent, () => ({ spec: f.installed.stored.eventId, kind: 'drive' as const }))
    const before = f.session.snapshot().localPosition
    await expect(f.journal.append(agentRunStartedEvent, () => ({ spec: f.installed.stored.eventId, kind: 'drive' as const }))).rejects.toBeDefined()
    expect(f.session.snapshot().localPosition).toBe(before)
    expect(projectAgentSession(f.session.snapshot()).laneOrdinals).toEqual([])
  } finally { await f.close() }
})

it('detects altered model request bytes even when the stored digest is replaced too', async () => {
  const f = await agentFixture()
  try {
    const step = await openStep(f)
    const built = await f.context.assembleAgent(step.consumer)
    if (built.kind !== 'ready') throw new Error('fixture assembly')
    const snapshot = structuredClone(f.session.snapshot())
    const event = snapshot.history.at(-1)!.events.find(item => item.stored.eventId === built.committed.stored.eventId)!
    if (event.kind !== 'known') throw new Error('fixture event')
    const payload = { ...built.committed.payload, request: { ...built.request, instructions: ['injected instructions'] }, requestDigest: '0'.repeat(64) }
    Object.assign(event, { payload, stored: { ...event.stored, payload } })
    expect(() => rebuildAssembly(snapshot, event.stored.eventId)).toThrow()
  } finally { await f.close() }
})

it('bounds pending user inputs and snapshots input data before asynchronous acknowledgement', async () => {
  const f = await agentFixture()
  try {
    const input = { kind: 'task' as const, text: 'original', originLabel: 'test' }
    const accepted = f.journal.append(agentInputAcceptedEvent, () => ({ spec: f.installed.stored.eventId, input }))
    input.text = 'changed'
    expect((await accepted).payload.input.text).toBe('original')
    for (let index = 1; index < f.spec.limits.maxPendingInputs; index++) await f.journal.append(agentInputAcceptedEvent, () => ({ spec: f.installed.stored.eventId, input }))
    await expect(f.journal.append(agentInputAcceptedEvent, () => ({ spec: f.installed.stored.eventId, input }))).rejects.toMatchObject({ code: 'AGENT_STATE_INVALID' })
  } finally { await f.close() }
})
