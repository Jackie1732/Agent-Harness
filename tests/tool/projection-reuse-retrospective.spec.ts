import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeAll, expect, it } from 'vitest'
import * as h from '../../src/index.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { formatSessionEventId, sessionLogPosition, sessionSequence } from '../../src/session/ids.js'
import { modelPreparedEvent } from '../../src/model/session-events.js'
import { toolRequestedEvent, toolAuthorizationEvent, toolSettledEvent } from '../../src/tool/session-events.js'
import { request, runnerLimits as modelLimits, streamLimits } from '../model/fixtures.js'

const schemaLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
const limits = { ...schemaLimits, maxRequestBytes: 65536, maxPlanBytes: 65536, maxArgumentsBytes: 4096,
  maxJsonDepth: 24, maxJsonNodes: 10000, maxResultBytes: 8192, maxJournalConflicts: 4 }
function definition(kind: string): h.ToolDefinition {
  const schema: h.JsonObject = { type: 'object', properties: { kind: { type: 'string', enum: [kind] } },
    required: ['kind'], additionalProperties: false }
  return h.createToolDefinition({ name: 'echo', version: 1, description: `Return ${kind}.`, operationClass: 'pure',
    inputSchema: schema, outputSchema: schema }, schemaLimits)
}

async function facts(kinds: readonly string[], fromModel = false): Promise<h.SessionSnapshot> {
  const capabilities = new h.CapabilityRegistry(), scope = capabilities.scope.derive('replay')
  const registry = new h.ToolRegistry(schemaLimits)
  const repository = new h.SessionRepository({ backend: new h.MemorySessionBackend({ maxRecordBytes: 262144 }),
    catalog: h.createDurableEventCatalog([...h.modelSessionEventDefinitions, ...h.toolSessionEventDefinitions]), maxLineageDepth: 0 })
  const session = await repository.create()
  const provider = new h.ScriptedToolProvider({ descriptor: { providerId: 'replay', adapterVersion: '1', resourceId: 'local',
    tools: [{ name: 'echo', version: 1 }], maxConcurrentExecutions: 1, maxArgumentsBytes: 4096, maxResultBytes: 8192 },
  acquire: plan => h.createScriptedToolExecution(() => ({ kind: 'success', value: plan.input }), () => undefined) })
  const runner = new h.SessionToolRunner({ session, registry, scope, limits,
    policy: { policyId: 'replay', version: 1, signal: new AbortController().signal, decide: () => ({ kind: 'allow', reasonCode: 'test' }) } })
  let currentKind = '', registration: h.ToolRegistration | undefined
  const modelProvider = fromModel ? new h.ScriptedModelProvider({ providerId: 'replay-model', maxConcurrentExchanges: 1, streamLimits,
    script: async function* (): AsyncGenerator<ModelFrame> {
      yield { kind: 'message-start', reportedModel: request().model, responseId: 'replay-response' }
      yield { kind: 'block-start', index: 0, block: 'tool-call', name: 'echo', callId: 'call-1' }
      yield { kind: 'arguments-delta', index: 0, text: JSON.stringify({ kind: currentKind }) }
      yield { kind: 'block-end', index: 0 }; yield { kind: 'usage', counts: { inputTokens: 0, outputTokens: 4 } }
      yield { kind: 'complete', stopReason: 'tool-calls' }
    } }) : undefined
  const model = modelProvider === undefined ? undefined : new h.SessionModelRunner({ session, provider: modelProvider, limits: modelLimits })
  try {
    for (const kind of kinds) {
      currentKind = kind
      const selected = definition(kind)
      registration = registry.register(scope, selected, provider)
      const settled = model === undefined ? await runner.invoke({ name: 'echo', input: { kind } })
        : await runner.invokeModelIntent({ invocationId: (await model.invoke({ ...request(), tools: [h.describeToolForModel(selected)] })).payload.invocationId, outputBlockIndex: 0 })
      expect(settled.payload.outcome).toBe('succeeded')
      await registration.dispose(); registration = undefined
    }
    return session.snapshot()
  } finally {
    await runner.dispose(); await registration?.dispose(); await registry.dispose(); await provider.dispose()
    await model?.dispose(); await modelProvider?.dispose(); await capabilities.dispose(); await repository.dispose()
  }
}

let direct: h.SessionSnapshot, modeled: h.SessionSnapshot
beforeAll(async () => { direct = await facts(['first', 'second']); modeled = await facts(['first'], true) })

function change(snapshot: h.SessionSnapshot, position: number, update: (payload: h.JsonObject) => h.JsonObject): h.SessionSnapshot {
  const local = snapshot.history.at(-1)!
  const events = local.events.map(event => {
    if (event.kind !== 'known' || event.stored.sequence !== position) return event
    const payload = update(event.payload as h.JsonObject)
    return { ...event, payload, stored: { ...event.stored, payload } }
  })
  return { ...snapshot, history: [...snapshot.history.slice(0, -1), { ...local, events }] }
}
const position = (snapshot: h.SessionSnapshot, type: string, last = false): number => {
  const events = snapshot.history.at(-1)!.events.filter(event => event.stored.type === type)
  return (last ? events.at(-1) : events[0])!.stored.sequence
}

it('replays two complete definitions with the same name and version independently', () => {
  const view = h.projectToolSession(direct)
  expect(view.invocations).toHaveLength(2)
  expect(view.invocations.map(item => item.state === 'settled' ? item.settled.payload.result : null)).toEqual([
    { kind: 'success', value: { kind: 'first' } }, { kind: 'success', value: { kind: 'second' } },
  ])
  expect(Object.hasOwn(h, 'createToolSourceReader')).toBe(false)
})

it('rejects a later successful result against its own output schema', () => {
  const altered = change(direct, position(direct, toolSettledEvent.type, true), payload => ({ ...payload,
    result: { kind: 'success', value: { kind: 'first' } } }))
  expect(() => h.projectToolSession(altered)).toThrowError(expect.objectContaining({ code: 'TOOL_STATE_INVALID' }))
})

it('rechecks each recorded schema budget even when an earlier definition compiled successfully', () => {
  const altered = change(direct, position(direct, toolRequestedEvent.type, true), payload => ({ ...payload,
    limits: { ...(payload.limits as h.JsonObject), maxSchemaBytes: 1 } }))
  expect(() => h.projectToolSession(altered)).toThrowError(expect.objectContaining({ code: 'TOOL_STATE_INVALID' }))
})

it('retains the full Plan fingerprint check after compiling an earlier request', () => {
  const altered = change(direct, position(direct, toolAuthorizationEvent.type, true), payload => ({ ...payload,
    plan: { ...(payload.plan as h.JsonObject), fingerprint: '0'.repeat(64) } }))
  expect(() => h.projectToolSession(altered)).toThrowError(expect.objectContaining({ code: 'TOOL_STATE_INVALID' }))
})

it('keeps direct Tool replay independent from an unrelated ignorable Model generation', () => {
  const local = direct.history.at(-1)!, sequence = sessionSequence(direct.localPosition + 1), through = sessionLogPosition(sequence)
  const opaque: h.SessionEventRecord = { kind: 'opaque', stored: { envelopeVersion: 1, sessionId: direct.header.sessionId,
    eventId: formatSessionEventId(direct.header.sessionId, sequence), sequence, recordedAt: direct.header.createdAt,
    type: modelPreparedEvent.type, payloadVersion: 2, ignorable: true, payload: {} } }
  const extended = { ...direct, localPosition: through, history: [...direct.history.slice(0, -1), { ...local, through, events: [...local.events, opaque] }] }
  expect(h.projectToolSession(extended).invocations).toEqual(h.projectToolSession(direct).invocations)
  expect(() => h.projectModelSession(extended)).toThrowError(expect.objectContaining({ code: 'MODEL_STATE_INVALID' }))
})

it('replays every Model-origin Tool prefix without adopting an unsettled intent', () => {
  const local = modeled.history.at(-1)!
  for (let through = 1; through <= modeled.localPosition; through++) {
    const cut = sessionLogPosition(through)
    expect(() => h.projectToolSession({ ...modeled, localPosition: cut,
      history: [...modeled.history.slice(0, -1), { ...local, through: cut, events: local.events.slice(0, through) }] })).not.toThrow()
  }
  expect(h.projectToolSession(modeled).invocations[0]?.state).toBe('settled')
})

it('refuses a claimed Model settlement that occurs after the Tool request', () => {
  const local = modeled.history.at(-1)!, order = [...local.events]
  const requested = order.splice(position(modeled, toolRequestedEvent.type) - 1, 1)[0]!
  order.splice(2, 0, requested)
  const references = new Map(order.map((event, index) => [event.stored.eventId, formatSessionEventId(modeled.header.sessionId, sessionSequence(index + 1))]))
  const rewrite = (value: h.JsonValue): h.JsonValue => {
    if (typeof value === 'string') return references.get(value as h.SessionEventId) ?? value
    if (Array.isArray(value)) return value.map(rewrite)
    if (value === null || typeof value !== 'object') return value
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry)]))
  }
  const events = order.map((event, index) => {
    const stored = { ...event.stored, sequence: sessionSequence(index + 1), eventId: references.get(event.stored.eventId)!, payload: rewrite(event.stored.payload) }
    return event.kind === 'known' ? { ...event, stored, payload: stored.payload } : { ...event, stored }
  })
  const altered = { ...modeled, history: [...modeled.history.slice(0, -1), { ...local, events }] }
  expect(h.projectModelSession(altered).invocations[0]?.state).toBe('settled')
  expect(() => h.projectToolSession(altered)).toThrowError(expect.objectContaining({ code: 'TOOL_STATE_INVALID' }))
})

it.each(['arguments', 'reference', 'surface'] as const)('keeps the recorded Model %s check', field => {
  const altered = change(modeled, position(modeled, toolRequestedEvent.type), payload => {
    if (field === 'arguments') return { ...payload, arguments: { kind: 'text', text: '{"kind":"second"}' } }
    if (field === 'reference') return { ...payload, source: { ...(payload.source as h.JsonObject), callId: 'another-call' } }
    const selection = payload.selection as h.JsonObject
    return { ...payload, selection: { ...selection, definition: { ...(selection.definition as h.JsonObject), description: 'Changed surface.' } } }
  })
  expect(() => h.projectToolSession(altered)).toThrowError(expect.objectContaining({ code: 'TOOL_STATE_INVALID' }))
})

it.each(['fingerprint', 'budget'] as const)('validates the Model %s again in an independent projection call', field => {
  expect(h.projectToolSession(modeled).invocations[0]?.state).toBe('settled')
  const altered = change(modeled, position(modeled, modelPreparedEvent.type), payload => field === 'fingerprint'
    ? { ...payload, submission: { ...(payload.submission as h.JsonObject), fingerprint: '0'.repeat(64) } }
    : { ...payload, limits: { ...(payload.limits as h.JsonObject), maxInputBytes: 1 } })
  expect(() => h.projectToolSession(altered)).toThrowError(expect.objectContaining({ code: 'TOOL_STATE_INVALID' }))
})

it('reads the original Model-origin Tool facts through a fresh File repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'atomic-tool-replay-')), backend = new h.FileSessionBackend({ root, maxRecordBytes: 262144 })
  try {
    await backend.create(modeled.header)
    const writer = await backend.openWriter(modeled.header.sessionId)
    try { for (const event of modeled.history.at(-1)!.events) await writer.append(sessionLogPosition(event.stored.sequence - 1), event.stored) }
    finally { await writer.dispose() }
    await backend.dispose()
    const repository = new h.SessionRepository({ backend: new h.FileSessionBackend({ root, maxRecordBytes: 262144 }),
      catalog: h.createDurableEventCatalog([...h.modelSessionEventDefinitions, ...h.toolSessionEventDefinitions]), maxLineageDepth: 0 })
    try { expect(h.projectToolSession(await repository.read(modeled.header.sessionId))).toEqual(h.projectToolSession(modeled)) }
    finally { await repository.dispose() }
  } finally { await backend.dispose(); expect(dirname(root)).toBe(tmpdir()); await rm(root, { recursive: true, force: true }) }
})
