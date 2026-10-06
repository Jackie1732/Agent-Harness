import { describe, expect, it } from 'vitest'
import { SessionAgent } from '../../src/agent/session-agent.js'
import { SessionContext } from '../../src/context/session-context.js'
import { verifyExperimentContexts } from '../../src/experiment/context-verification.js'
import { experimentJsonDigest } from '../../src/experiment/parsing.js'
import type { JsonObject, JsonValue } from '../../src/foundation/json.js'
import { SessionModelRunner } from '../../src/model/runner.js'
import { createPreparedSubmission } from '../../src/model/submission.js'
import { modelPreparedEvent, modelStartedEvent } from '../../src/model/session-events.js'
import { freezeSessionSnapshot } from '../../src/session/session-handle.js'
import type { SessionSnapshot } from '../../src/session/types.js'
import { agentFixture, clock } from '../agent/fixtures.js'
import { emptyMessageCatalog, profile, repository, runnerLimits, scriptedModel, selection } from '../context/fixtures.js'

function replacePayload(snapshot: SessionSnapshot, type: string, change: (payload: JsonValue) => JsonValue): SessionSnapshot {
  return freezeSessionSnapshot(snapshot.history.map(segment => ({ ...segment, events: segment.events.map(event => {
    if (event.kind !== 'known' || event.stored.type !== type) return event
    const payload = change(event.payload)
    return { ...event, payload, stored: { ...event.stored, payload } }
  }) })))
}

async function contextSnapshot(adopt = true): Promise<SessionSnapshot> {
  const repo = repository(), provider = scriptedModel(), session = await repo.create()
  const context = new SessionContext({ session, messageCatalog: emptyMessageCatalog })
  const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
  try {
    const recorded = await context.recordProfile(profile())
    const input = await context.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'experiment-test', text: 'saved input' })
    const built = await context.assemble(selection(recorded.stored.eventId, provider.descriptor, {
      requiredInputs: [{ eventId: input.stored.eventId, selector: 'user-input' }],
    }))
    if (built.kind !== 'ready') throw new Error('expected ready assembly')
    await runner.invoke(adopt ? built.request : { ...built.request, instructions: ['independent call'] },
      adopt ? { inputPrecondition: built.inputPrecondition } : {})
    return session.snapshot()
  } finally { await runner.dispose(); await context.dispose(); await provider.dispose(); await repo.dispose() }
}

describe('experiment Context verification', () => {
  it('reconstructs original v1 adoption after all runtime resources are disposed and deduplicates references', async () => {
    const snapshot = await contextSnapshot()
    const result = verifyExperimentContexts([snapshot, snapshot])
    const events = snapshot.history.at(-1)!.events
    expect(result).toEqual({ complete: true, reasons: [], refs: [
      { address: snapshot.address, eventId: events.find(event => event.stored.type === 'context/assembly-committed')!.stored.eventId },
      { address: snapshot.address, eventId: events.find(event => event.stored.type === modelPreparedEvent.type)!.stored.eventId },
    ] })
  })

  it('rebuilds Agent v2 claims without performing another Provider preparation or execution', async () => {
    const counters = { prepare: 0, acquire: 0, start: 0 }
    const f = await agentFixture({}, scriptedModel('verified answer', counters))
    const model = new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits })
    const agent = new SessionAgent({ session: f.session, model, context: f.context, messageCatalog: emptyMessageCatalog, clock })
    let snapshot: SessionSnapshot
    try {
      await agent.submitInput({ kind: 'task', text: 'claimed scientific task', originLabel: 'experiment-test' })
      await agent.start()
      snapshot = f.session.snapshot()
    } finally { await agent.dispose(); await f.close() }
    expect(verifyExperimentContexts([snapshot])).toMatchObject({ complete: true, reasons: [] })
    expect(counters).toEqual({ prepare: 1, acquire: 1, start: 1 })

    let fingerprint = ''
    const changedPrepared = replacePayload(snapshot, modelPreparedEvent.type, value => {
      const prepared = modelPreparedEvent.decode(value)
      const submission = createPreparedSubmission({ ...prepared.submission.request, instructions: ['unrelated prepared input'] },
        prepared.submission.binding, prepared.submission.wireBody)
      fingerprint = submission.fingerprint
      return { ...prepared, submission }
    })
    const changedDispatch = replacePayload(changedPrepared, modelStartedEvent.type, value => ({ ...(value as JsonObject), fingerprint }))
    const mismatch = verifyExperimentContexts([changedDispatch])
    expect(mismatch.complete).toBe(false)
    expect(mismatch.reasons).toEqual([`context-projection-failed:AGENT_STATE_INVALID:${snapshot.address}`])
    expect(counters).toEqual({ prepare: 1, acquire: 1, start: 1 })
  })

  it('preserves an unfamiliar renderer as unsupported without guessing a compatible implementation', async () => {
    const snapshot = await contextSnapshot()
    const changed = replacePayload(snapshot, 'context/assembly-committed', value => ({ ...(value as JsonObject), rendererVersion: 'future-renderer/v8' }))
    const result = verifyExperimentContexts([changed])
    expect(result.complete).toBe(false)
    expect(result.reasons).toEqual([`context-renderer-unsupported:future-renderer/v8:${result.refs[0]!.eventId}`])
    expect(result.refs).toHaveLength(1)
  })

  it('rejects altered complete request content even when its stored digest is updated consistently', async () => {
    const snapshot = await contextSnapshot()
    const altered = replacePayload(snapshot, 'context/assembly-committed', value => {
      const payload = value as JsonObject
      const request = { ...(payload.request as JsonObject), instructions: ['tampered neutral input'] }
      return { ...payload, request, requestDigest: experimentJsonDigest(request) }
    })
    const result = verifyExperimentContexts([altered])
    expect(result.complete).toBe(false)
    expect(result.reasons).toEqual([`context-rebuild-failed:CONTEXT_STATE_INVALID:${result.refs[0]!.eventId}`])
    const alteredDigest = replacePayload(snapshot, 'context/assembly-committed', value => ({ ...(value as JsonObject), requestDigest: '0'.repeat(64) }))
    expect(verifyExperimentContexts([alteredDigest]).complete).toBe(false)
  })

  it('does not invent adoption for a legal independent Model invocation', async () => {
    const snapshot = await contextSnapshot(false)
    const result = verifyExperimentContexts([snapshot])
    expect(result).toMatchObject({ complete: true, reasons: [] })
    expect(result.refs).toEqual([{ address: snapshot.address,
      eventId: snapshot.history.at(-1)!.events.find(event => event.stored.type === 'context/assembly-committed')!.stored.eventId }])
    expect(verifyExperimentContexts([])).toEqual({ complete: true, reasons: [], refs: [] })
  })
})
