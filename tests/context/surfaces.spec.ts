import { describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  ScriptedToolProvider,
  SessionContext,
  ToolRegistry,
  createAnthropicModelProvider,
  createDeepSeekModelProvider,
  createScriptedToolExecution,
  createToolDefinition,
} from '../../src/index.js'
import { emptyMessageCatalog, profile, repository, scriptedModel, selection } from './fixtures.js'

const schemaLimits = { maxSchemaBytes: 16_384, maxSchemaDepth: 16, maxSchemaNodes: 512 }

describe('Context runtime surface capture', () => {
  it('captures an active Tool definition and safe Provider descriptor without borrowing execution', async () => {
    const capability = new CapabilityRegistry()
    const toolScope = capability.scope.derive('Context tool')
    const tools = new ToolRegistry(schemaLimits)
    let acquisitions = 0
    const definition = createToolDefinition({
      name: 'lookup', version: 1, description: 'Look up one item', operationClass: 'read-only',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
    }, schemaLimits)
    const toolProvider = new ScriptedToolProvider({
      descriptor: {
        providerId: 'context-tool', adapterVersion: '1', resourceId: 'fixture',
        tools: [{ name: 'lookup', version: 1 }], maxConcurrentExecutions: 1,
        maxArgumentsBytes: 4096, maxResultBytes: 4096,
      },
      acquire: () => {
        acquisitions += 1
        return createScriptedToolExecution(() => ({ kind: 'success', value: { answer: 'unused' } }), () => undefined)
      },
    })
    const registration = tools.register(toolScope, definition, toolProvider)
    const model = scriptedModel()
    const repo = repository()
    try {
      const handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog, toolRegistry: tools })
      const recordedProfile = await context.recordProfile(profile('generation', { toolNames: ['lookup'] }))
      const recordedInput = await context.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'test', text: 'use no tool yet' })
      const assembled = await context.assemble(selection(recordedProfile.stored.eventId, model.descriptor, {
        requiredInputs: [{ eventId: recordedInput.stored.eventId, selector: 'user-input' }],
      }))
      expect(assembled.kind).toBe('ready')
      if (assembled.kind !== 'ready') throw new Error('expected ready assembly')
      expect(assembled.request.tools).toEqual([{ name: 'lookup', description: 'Look up one item', inputSchema: definition.inputSchema }])
      expect(assembled.committed.payload.captured.tools[0]).toMatchObject({
        definition: { name: 'lookup', version: 1 },
        provider: { providerId: 'context-tool', resourceId: 'fixture' },
      })
      expect(acquisitions).toBe(0)
    } finally {
      await registration.dispose()
      await toolScope.dispose()
      await tools.dispose()
      await toolProvider.dispose()
      await capability.dispose()
      await model.dispose()
      await repo.dispose()
    }
  })

  it('returns tool-unavailable without dropping a Profile tool', async () => {
    const model = scriptedModel()
    const repo = repository()
    try {
      const handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const recordedProfile = await context.recordProfile(profile('generation', { toolNames: ['lookup'] }))
      const recordedInput = await context.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'test', text: 'blocked' })
      const before = handle.snapshot().localPosition
      await expect(context.assemble(selection(recordedProfile.stored.eventId, model.descriptor, {
        requiredInputs: [{ eventId: recordedInput.stored.eventId, selector: 'user-input' }],
      }))).resolves.toEqual({ kind: 'blocked', reason: 'tool-unavailable', references: [] })
      expect(handle.snapshot().localPosition).toBe(before)
    } finally {
      await model.dispose()
      await repo.dispose()
    }
  })

  it('passes assembled neutral requests through both real protocol prepare paths without network I/O', async () => {
    const creates = [createDeepSeekModelProvider, createAnthropicModelProvider]
    const repo = repository()
    const providers = creates.map((create, index) => create({
      providerId: `context-adapter-${index}`,
      endpoint: 'https://example.invalid/model',
      apiKey: 'unused-test-key',
      maxConcurrentExchanges: 1,
      streamLimits: { maxFrameBytes: 16_384, maxStreamBytes: 262_144, maxFrames: 1000 },
    }))
    try {
      const handle = await repo.create()
      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const recordedProfile = await context.recordProfile(profile())
      const recordedInput = await context.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'test', text: 'adapter input' })
      for (const provider of providers) {
        const assembled = await context.assemble(selection(recordedProfile.stored.eventId, provider.descriptor, {
          requiredInputs: [{ eventId: recordedInput.stored.eventId, selector: 'user-input' }],
        }))
        expect(assembled.kind).toBe('ready')
        if (assembled.kind !== 'ready') throw new Error('expected ready assembly')
        const prepared = provider.prepare(assembled.request)
        expect(prepared.submission.request).toEqual(assembled.request)
        expect(prepared.submission.binding).toEqual(provider.descriptor)
      }
    } finally {
      await Promise.all(providers.map(provider => provider.dispose()))
      await repo.dispose()
    }
  })
})
