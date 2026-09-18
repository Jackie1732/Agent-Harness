import assert from 'node:assert/strict'
import * as h from '../dist/index.js'
import { contextProfile, contextSelection, modelLimits, sessionRepository } from './context-fixture.mjs'

const backend = new h.MemorySessionBackend({ maxRecordBytes: 2 * 1024 * 1024 })
const repository = sessionRepository(backend)
const directory = h.createSessionDirectory()
const transport = h.createInProcessMessageTransport(directory)
const service = new h.CommunicationService({ directory, transport, limits: {
  maxMessageBytes: 4096, maxPendingOutbox: 8, maxPendingInbox: 8,
  maxDeliveryAttempts: 3, maxAttemptsPerRun: 8, maxSendJournalConflicts: 4,
} })
const message = h.createMessageDefinition({
  type: 'example/question', payloadVersion: 1,
  decode: value => {
    if (value === null || Array.isArray(value) || typeof value !== 'object' || typeof value.text !== 'string') throw new TypeError('text required')
    return { text: value.text }
  },
})
const messageCatalog = h.createMessageCatalog([message])
const capabilities = new h.CapabilityRegistry()
const toolScope = capabilities.scope.derive('example tool')
const toolRegistry = new h.ToolRegistry({ maxSchemaBytes: 16_384, maxSchemaDepth: 16, maxSchemaNodes: 512 })
const toolDefinition = h.createToolDefinition({
  name: 'read_text', version: 1, description: 'Read one fixture value', operationClass: 'read-only',
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
}, { maxSchemaBytes: 16_384, maxSchemaDepth: 16, maxSchemaNodes: 512 })
const toolProvider = new h.ScriptedToolProvider({
  descriptor: { providerId: 'example-read-text', adapterVersion: '1', resourceId: 'example', tools: [{ name: 'read_text', version: 1 }], maxConcurrentExecutions: 1, maxArgumentsBytes: 4096, maxResultBytes: 4096 },
  acquire: plan => h.createScriptedToolExecution(() => ({
    kind: 'success',
    value: { text: plan.input.path === 'peer-question.txt' ? 'peer question' : 'missing' },
  }), () => undefined),
})
const registration = toolRegistry.register(toolScope, toolDefinition, toolProvider)
let modelCalls = 0
const modelProvider = new h.ScriptedModelProvider({
  providerId: 'context-roundtrip', maxConcurrentExchanges: 1,
  streamLimits: { maxFrameBytes: 16_384, maxStreamBytes: 262_144, maxFrames: 1000 },
  script: async function* () {
    modelCalls += 1
    yield { kind: 'message-start', reportedModel: 'fixture-model', responseId: `response-${modelCalls}` }
    if (modelCalls === 1) {
      yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'read-1', name: 'read_text' }
      yield { kind: 'arguments-delta', index: 0, text: '{"path":"peer-question.txt"}' }
      yield { kind: 'block-end', index: 0 }
      yield { kind: 'complete', stopReason: 'tool-calls' }
    } else {
      yield { kind: 'block-start', index: 0, block: 'text' }
      yield { kind: 'text-delta', index: 0, text: 'explicit second response' }
      yield { kind: 'block-end', index: 0 }
      yield { kind: 'complete', stopReason: 'stop' }
    }
  },
})
const resources = []
try {
  const sender = await repository.create()
  const recipient = await repository.create()
  const senderMailbox = await service.attach(sender, { catalog: messageCatalog, policy: h.allowAllCommunicationPolicy })
  const recipientMailbox = await service.attach(recipient, { catalog: messageCatalog, policy: h.allowAllCommunicationPolicy })
  resources.push(senderMailbox, recipientMailbox)
  const outgoing = await senderMailbox.send(message, {
    kind: 'root', recipient: recipient.header.address,
    channelId: h.parseChannelId('70000000-0000-4000-8000-000000000101'),
  }, { text: 'peer question' })
  await service.createDispatcher(senderMailbox).dispatch()
  const pending = recipientMailbox.snapshot().inbox[0]
  assert.equal(pending.status, 'pending')

  const context = new h.SessionContext({ session: recipient, messageCatalog, toolRegistry })
  const profile = await context.recordProfile(contextProfile('generation', { toolNames: ['read_text'] }))
  const input = await context.recordInput({ kind: 'user', origin: 'host-authored', originLabel: 'example', text: 'Handle the message.' })
  const firstRequest = await context.assemble(contextSelection(profile.stored.eventId, modelProvider.descriptor, {
    requiredInputs: [{ eventId: input.stored.eventId, selector: 'user-input' }],
    inbox: [{ messageId: outgoing.messageId, action: 'include-full' }],
  }))
  assert.equal(firstRequest.kind, 'ready')
  const model = new h.SessionModelRunner({ session: recipient, provider: modelProvider, limits: modelLimits })
  const firstModel = await model.invoke(firstRequest.request, { inputPrecondition: firstRequest.inputPrecondition })
  const policyLife = new AbortController()
  const tool = new h.SessionToolRunner({
    session: recipient, registry: toolRegistry, scope: toolScope,
    limits: { maxSchemaBytes: 16_384, maxSchemaDepth: 16, maxSchemaNodes: 512, maxRequestBytes: 65_536, maxPlanBytes: 65_536, maxArgumentsBytes: 4096, maxJsonDepth: 16, maxJsonNodes: 4096, maxResultBytes: 4096, maxJournalConflicts: 4 },
    policy: { policyId: 'example', version: 1, signal: policyLife.signal, decide: () => ({ kind: 'allow', reasonCode: 'example' }) },
  })
  const toolResult = await tool.invokeModelIntent({ invocationId: firstModel.payload.invocationId, outputBlockIndex: 0 })
  assert.equal(toolResult.payload.outcome, 'succeeded')
  const secondRequest = await context.assemble(contextSelection(profile.stored.eventId, modelProvider.descriptor, {
    requiredInputs: [{ eventId: input.stored.eventId, selector: 'user-input' }],
    inbox: [{ messageId: outgoing.messageId, action: 'include-full' }],
  }))
  assert.equal(secondRequest.kind, 'ready')
  const secondModel = await model.invoke(secondRequest.request, { inputPrecondition: secondRequest.inputPrecondition })
  assert.equal(secondModel.payload.outcome, 'completed')
  assert.equal(recipientMailbox.snapshot().inbox[0].status, 'pending')
  process.stdout.write(`${JSON.stringify({ example: 'agent-roundtrip', modelCalls, inboxStatus: 'pending', domains: ['communication', 'context', 'model', 'tool', 'context', 'model'] })}\n`)
  await tool.dispose()
  await model.dispose()
  await context.dispose()
} finally {
  for (const resource of resources.reverse()) await resource.dispose().catch(() => undefined)
  await registration.dispose().catch(() => undefined)
  await toolRegistry.dispose().catch(() => undefined)
  await toolProvider.dispose().catch(() => undefined)
  await toolScope.dispose().catch(() => undefined)
  await capabilities.dispose().catch(() => undefined)
  await modelProvider.dispose().catch(() => undefined)
  await service.dispose().catch(() => undefined)
  await transport.dispose().catch(() => undefined)
  await directory.dispose().catch(() => undefined)
  await repository.dispose().catch(() => undefined)
}
