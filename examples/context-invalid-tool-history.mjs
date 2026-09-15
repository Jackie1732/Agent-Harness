import assert from 'node:assert/strict'
import * as h from '../dist/index.js'
import { contextProfile, contextSelection, modelLimits, sessionRepository } from './context-fixture.mjs'

const schemaLimits = { maxSchemaBytes: 16_384, maxSchemaDepth: 16, maxSchemaNodes: 512 }
const invocationLimits = {
  ...schemaLimits,
  maxRequestBytes: 65_536, maxPlanBytes: 65_536, maxArgumentsBytes: 4096,
  maxJsonDepth: 16, maxJsonNodes: 4096, maxResultBytes: 4096, maxJournalConflicts: 4,
}

/** Exercise the explicit raw-to-note choice for one closed invalid-JSON tool exchange. */
export async function demonstrateInvalidToolHistory() {
  const capabilities = new h.CapabilityRegistry()
  const scope = capabilities.scope.derive('invalid history example')
  const tools = new h.ToolRegistry(schemaLimits)
  const definition = h.createToolDefinition({
    name: 'lookup', version: 1, description: 'Look up one value', operationClass: 'read-only',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
  }, schemaLimits)
  let toolStarts = 0
  const toolProvider = new h.ScriptedToolProvider({
    descriptor: {
      providerId: 'invalid-history-tool', adapterVersion: '1', resourceId: 'example',
      tools: [{ name: definition.name, version: definition.version }], maxConcurrentExecutions: 1,
      maxArgumentsBytes: 4096, maxResultBytes: 4096,
    },
    acquire: () => h.createScriptedToolExecution(() => {
      toolStarts += 1
      return { kind: 'success', value: { text: 'must not run' } }
    }, () => undefined),
  })
  const registration = tools.register(scope, definition, toolProvider)
  const sourceModel = new h.ScriptedModelProvider({
    providerId: 'invalid-history-source', maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 16_384, maxStreamBytes: 262_144, maxFrames: 1000 },
    script: async function* () {
      yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'invalid-history' }
      yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'lookup-1', name: definition.name }
      yield { kind: 'arguments-delta', index: 0, text: '{"query":' }
      yield { kind: 'block-end', index: 0 }
      yield { kind: 'complete', stopReason: 'tool-calls' }
    },
  })
  const anthropic = h.createAnthropicModelProvider({
    providerId: 'invalid-history-target', endpoint: 'https://example.invalid/model', apiKey: 'unused-example-key',
    maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 16_384, maxStreamBytes: 262_144, maxFrames: 1000 },
  })
  const repository = sessionRepository(new h.MemorySessionBackend({ maxRecordBytes: 2 * 1024 * 1024 }))
  const policyLife = new AbortController()
  try {
    const session = await repository.create()
    const model = new h.SessionModelRunner({ session, provider: sourceModel, limits: modelLimits })
    const modelSettlement = await model.invoke({
      model: 'fixture-model', instructions: [],
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'look it up' }] }],
      tools: [h.describeToolForModel(definition)], maxOutputTokens: 256,
    })
    const tool = new h.SessionToolRunner({
      session, registry: tools, scope, limits: invocationLimits,
      policy: {
        policyId: 'invalid-history-policy', version: 1, signal: policyLife.signal,
        decide: () => ({ kind: 'allow', reasonCode: 'example' }),
      },
    })
    const toolSettlement = await tool.invokeModelIntent({
      invocationId: modelSettlement.payload.invocationId, outputBlockIndex: 0,
    })
    assert.equal(toolSettlement.payload.outcome, 'rejected')
    assert.equal(toolStarts, 0)

    const context = new h.SessionContext({ session, messageCatalog: h.createMessageCatalog() })
    const profile = await context.recordProfile(contextProfile())
    const raw = await context.assemble(contextSelection(profile.stored.eventId, anthropic.descriptor))
    assert.equal(raw.kind, 'ready')
    assert.throws(() => anthropic.prepare(raw.request), error => error.code === 'MODEL_FEATURE_UNSUPPORTED')
    const note = await context.assemble(contextSelection(profile.stored.eventId, anthropic.descriptor, {
      history: { mode: 'local-suffix', representation: 'historical-note/v1' },
    }))
    assert.equal(note.kind, 'ready')
    assert.deepEqual(anthropic.prepare(note.request).submission.request, note.request)

    await context.dispose()
    await tool.dispose()
    await model.dispose()
    return { rawAdapter: 'rejected', noteAdapter: 'accepted', toolStarts }
  } finally {
    policyLife.abort()
    await registration.dispose().catch(() => undefined)
    await tools.dispose().catch(() => undefined)
    await toolProvider.dispose().catch(() => undefined)
    await scope.dispose().catch(() => undefined)
    await capabilities.dispose().catch(() => undefined)
    await sourceModel.dispose().catch(() => undefined)
    await anthropic.dispose().catch(() => undefined)
    await repository.dispose().catch(() => undefined)
  }
}
