import { describe, expect, it } from 'vitest'
import {
  CapabilityRegistry,
  ScriptedModelProvider,
  ScriptedToolProvider,
  SessionContext,
  SessionModelRunner,
  SessionToolRunner,
  ToolRegistry,
  createAnthropicModelProvider,
  createScriptedToolExecution,
  createToolDefinition,
  describeToolForModel,
  toolSessionEventDefinitions,
} from '../../src/index.js'
import { emptyMessageCatalog, profile, repository, runnerLimits, selection } from './fixtures.js'

const schemaLimits = { maxSchemaBytes: 16_384, maxSchemaDepth: 16, maxSchemaNodes: 512 }
const invocationLimits = {
  ...schemaLimits,
  maxRequestBytes: 65_536,
  maxPlanBytes: 65_536,
  maxArgumentsBytes: 4096,
  maxJsonDepth: 16,
  maxJsonNodes: 4096,
  maxResultBytes: 4096,
  maxJournalConflicts: 4,
}

describe('Context history representation', () => {
  it('preserves invalid tool JSON in raw history and requires an explicit whole-exchange note for Anthropic', async () => {
    const capabilities = new CapabilityRegistry()
    const scope = capabilities.scope.derive('invalid history tool')
    const tools = new ToolRegistry(schemaLimits)
    const definition = createToolDefinition({
      name: 'lookup', version: 1, description: 'Look up a value', operationClass: 'read-only',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    }, schemaLimits)
    let toolStarts = 0
    const toolProvider = new ScriptedToolProvider({
      descriptor: {
        providerId: 'invalid-history-tool', adapterVersion: '1', resourceId: 'fixture',
        tools: [{ name: definition.name, version: definition.version }], maxConcurrentExecutions: 1,
        maxArgumentsBytes: 4096, maxResultBytes: 4096,
      },
      acquire: () => createScriptedToolExecution(() => {
        toolStarts += 1
        return { kind: 'success', value: { text: 'must not run' } }
      }, () => undefined),
    })
    const registration = tools.register(scope, definition, toolProvider)
    const modelProvider = new ScriptedModelProvider({
      providerId: 'invalid-history-model', maxConcurrentExchanges: 1,
      streamLimits: { maxFrameBytes: 16_384, maxStreamBytes: 262_144, maxFrames: 1000 },
      script: async function* () {
        yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: 'invalid-history' }
        yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'lookup-1', name: definition.name }
        yield { kind: 'arguments-delta', index: 0, text: '{"query":' }
        yield { kind: 'block-end', index: 0 }
        yield { kind: 'complete', stopReason: 'tool-calls' }
      },
    })
    const anthropic = createAnthropicModelProvider({
      providerId: 'context-anthropic-history', endpoint: 'https://example.invalid/model', apiKey: 'unused-test-key',
      maxConcurrentExchanges: 1,
      streamLimits: { maxFrameBytes: 16_384, maxStreamBytes: 262_144, maxFrames: 1000 },
    })
    const repo = repository(undefined, toolSessionEventDefinitions)
    const policyLife = new AbortController()
    try {
      const handle = await repo.create()
      const model = new SessionModelRunner({ session: handle, provider: modelProvider, limits: runnerLimits })
      const modelSettlement = await model.invoke({
        model: 'fixture-model', instructions: [], messages: [
          { role: 'user', content: [{ kind: 'text', text: 'look it up' }] },
        ],
        tools: [describeToolForModel(definition)], maxOutputTokens: 256,
      })
      const tool = new SessionToolRunner({
        session: handle, registry: tools, scope, limits: invocationLimits,
        policy: {
          policyId: 'invalid-history-policy', version: 1, signal: policyLife.signal,
          decide: () => ({ kind: 'allow', reasonCode: 'fixture' }),
        },
      })
      const toolSettlement = await tool.invokeModelIntent({
        invocationId: modelSettlement.payload.invocationId,
        outputBlockIndex: 0,
      })
      expect(toolSettlement.payload).toMatchObject({
        outcome: 'rejected',
        result: { kind: 'error', code: 'invalid-arguments' },
      })
      expect(toolStarts).toBe(0)

      const context = new SessionContext({ session: handle, messageCatalog: emptyMessageCatalog })
      const recordedProfile = await context.recordProfile(profile())
      const raw = await context.assemble(selection(recordedProfile.stored.eventId, anthropic.descriptor))
      expect(raw.kind).toBe('ready')
      if (raw.kind !== 'ready') throw new Error('expected raw history assembly')
      expect(raw.request.messages[0]).toMatchObject({
        role: 'assistant',
        content: [{ kind: 'tool-call', argumentsText: '{"query":' }],
      })
      expect(() => anthropic.prepare(raw.request)).toThrowError(expect.objectContaining({ code: 'MODEL_FEATURE_UNSUPPORTED' }))

      const note = await context.assemble(selection(recordedProfile.stored.eventId, anthropic.descriptor, {
        history: { mode: 'local-suffix', representation: 'historical-note/v1' },
      }))
      expect(note.kind).toBe('ready')
      if (note.kind !== 'ready') throw new Error('expected note history assembly')
      expect(note.request.messages).toHaveLength(1)
      expect(note.request.messages[0]).toMatchObject({ role: 'user', content: [{ kind: 'text' }] })
      expect(note.request.messages[0]!.content[0]!.kind === 'text' && note.request.messages[0]!.content[0]!.text)
        .toContain('\\\"query\\\":')
      expect(anthropic.prepare(note.request).submission.request).toEqual(note.request)

      await context.dispose()
      await tool.dispose()
      await model.dispose()
    } finally {
      policyLife.abort()
      await registration.dispose().catch(() => undefined)
      await tools.dispose().catch(() => undefined)
      await toolProvider.dispose().catch(() => undefined)
      await scope.dispose().catch(() => undefined)
      await capabilities.dispose().catch(() => undefined)
      await modelProvider.dispose().catch(() => undefined)
      await anthropic.dispose().catch(() => undefined)
      await repo.dispose().catch(() => undefined)
    }
  })
})
