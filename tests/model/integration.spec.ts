import { strict as assert } from 'node:assert'
import { describe, it } from 'vitest'
import {
  CapabilityRegistry, CommunicationService, createDurableEventCatalog, createEventName,
  createInProcessMessageTransport, createModelProviderComponent, createSessionDirectory,
  MemorySessionBackend, ModelProviderKey, modelSessionEventDefinitions,
  communicationSessionEventDefinitions, parseChannelId, SessionModelRunner, SessionRepository,
} from '../../src/index.js'
import type { ModelProvider } from '../../src/index.js'
import { communicationIdentities, limits as mailboxLimits, messageCatalog, requestMessage } from '../communication/fixtures.js'
import { deferred, request, runnerLimits, scripted, textFrames } from './fixtures.js'

// These exercise the real Capability/Scope/Communication kernel, not a replacement host.
describe('Model integration with previously archived layers', () => {
  it('S6-49: missing Model Provider leaves the consumer body unexecuted', async () => {
    const registry = new CapabilityRegistry()
    let calls = 0
    registry.mount({ label: 'model consumer', requires: [ModelProviderKey], provides: [], setup: () => { calls++ } })
    try { await registry.whenQuiescent(); assert.equal(calls, 0) }
    finally { await registry.dispose() }
  })

  it('S6-10/50: Scope cancellation settles A before client withdrawal and B activation', async () => {
    const registry = new CapabilityRegistry()
    const repo = new SessionRepository({ backend: new MemorySessionBackend({ maxRecordBytes: 65536 }), catalog: createDurableEventCatalog(modelSessionEventDefinitions), maxLineageDepth: 0 })
    const session = await repo.create()
    const entered = deferred(); const trace: string[] = []; const settled: string[] = []
    const execute = createEventName<void>('model-run')
    const providerComponent = (name: string) => createModelProviderComponent({ label: name, create: (): ModelProvider => {
      const inner = scripted({ providerId: name, script: async function* (_input, signal) {
        trace.push(`start:${name}`)
        if (name === 'A') {
          entered.resolve()
          if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
          return
        }
        yield* textFrames(name)
      }, onClose: () => { trace.push(`exchange-closed:${name}`) } })
      return {
        descriptor: inner.descriptor, prepare: input => inner.prepare(input),
        dispose: async () => { await inner.dispose(); trace.push(`provider-closed:${name}`) },
      }
    } })
    const a = registry.mount(providerComponent('A'))
    registry.mount({ label: 'consumer', requires: [ModelProviderKey], provides: [], setup: async context => {
      const provider = context.require(ModelProviderKey)
      const scope = context.scope
      const runner = await context.apply('model runner', () => new SessionModelRunner({ session, provider, limits: runnerLimits, signal: scope.signal }), active => active.dispose())
      scope.on(execute, 'model callback', async () => {
        const event = await runner.invoke(request())
        settled.push(event.payload.outcome)
        trace.push(`settled:${provider.descriptor.providerId}`)
      })
    } })
    try {
      await registry.whenQuiescent()
      const run = registry.scope.emit(execute, undefined)
      await entered.promise
      await a.dispose()
      await run
      assert.deepEqual(settled, ['cancelled'])
      assert.ok(trace.indexOf('exchange-closed:A') < trace.indexOf('settled:A'))
      assert.ok(trace.indexOf('settled:A') < trace.indexOf('provider-closed:A'))
      registry.mount(providerComponent('B'))
      await registry.whenQuiescent()
      await registry.scope.emit(execute, undefined)
      assert.deepEqual(settled, ['cancelled', 'completed'])
      assert.equal(trace.filter(item => item === 'start:A').length, 1)
      assert.equal(trace.filter(item => item === 'start:B').length, 1)
    } finally { await registry.dispose(); await repo.dispose() }
  })

  it('S6-05/53: Model and Mailbox share a Writer and settle before Session end', async () => {
    const repo = new SessionRepository({ backend: new MemorySessionBackend({ maxRecordBytes: 65536 }), catalog: createDurableEventCatalog([...modelSessionEventDefinitions, ...communicationSessionEventDefinitions]), maxLineageDepth: 0 })
    const directory = createSessionDirectory(); const transport = createInProcessMessageTransport(directory)
    const service = new CommunicationService({ directory, transport, limits: mailboxLimits, identitySource: communicationIdentities() })
    const entered = deferred(); const release = deferred(); let starts = 0
    const provider = scripted({ script: async function* () { starts++; entered.resolve(); await release.promise; yield* textFrames() } })
    const handle = await repo.create(); const recipientHandle = await repo.create()
    const runner = new SessionModelRunner({ session: handle, provider, limits: runnerLimits })
    const policy = { canSend: () => ({ kind: 'allow' as const }), canReceive: () => ({ kind: 'allow' as const }) }
    const sender = await service.attach(handle, { catalog: messageCatalog, policy })
    const recipient = await service.attach(recipientHandle, { catalog: messageCatalog, policy })
    const pending = runner.invoke(request())
    try {
      await entered.promise
      const outgoing = await sender.send(requestMessage, { kind: 'root', recipient: recipient.address, channelId: parseChannelId('11111111-1111-4111-8111-111111111111') }, { text: 'during model stream' })
      assert.equal((await service.createDispatcher(sender).dispatch()).delivered, 1)
      await recipient.markProcessed(outgoing.messageId)
      release.resolve()
      assert.equal((await pending).payload.outcome, 'completed')
      assert.equal(starts, 1)
      await runner.dispose()
      assert.equal(runner.snapshot().pendingInvocationId, null)
      await sender.endSession()
      await recipient.endSession()
      assert.equal(handle.snapshot().lifecycle, 'ended')
      assert.equal(recipientHandle.snapshot().lifecycle, 'ended')
    } finally {
      release.resolve(); await pending
      await runner.dispose(); await provider.dispose(); await service.dispose()
      await transport.dispose(); await directory.dispose(); await repo.dispose()
    }
  })
})
