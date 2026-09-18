import { MemorySessionBackend, ScriptedModelProvider, SessionAgent, SessionModelRunner } from '../../src/index.js'
import type { ModelFrame, SessionBackend, SessionAgentOptions, StoredSessionEvent } from '../../src/index.js'
import { createDeferred } from '../helpers/deferred.js'
import { runnerLimits, emptyMessageCatalog } from '../context/fixtures.js'
import { agentFixture, clock } from './fixtures.js'
export { createDeferred }
export function auditedAgent(f: Awaited<ReturnType<typeof agentFixture>>, overrides: Partial<SessionAgentOptions> = {}) {
  return new SessionAgent({ session: f.session, context: f.context, model: new SessionModelRunner({ session: f.session, provider: f.provider, limits: runnerLimits }), messageCatalog: emptyMessageCatalog, clock, ...overrides })
}
export async function* finalFrames(): AsyncGenerator<ModelFrame> {
  yield { kind: 'message-start', responseId: 'audit', reportedModel: 'fixture-model' }
  yield { kind: 'block-start', index: 0, block: 'text' }
  yield { kind: 'text-delta', index: 0, text: 'done' }
  yield { kind: 'block-end', index: 0 }
  yield { kind: 'complete', stopReason: 'stop' }
}
export function auditProvider(options: Partial<ConstructorParameters<typeof ScriptedModelProvider>[0]> = {}) {
  return new ScriptedModelProvider({ providerId: 'audit', maxConcurrentExchanges: 1,
    streamLimits: { maxFrameBytes: 16384, maxStreamBytes: 262144, maxFrames: 1000 }, script: finalFrames, ...options })
}
export function interceptedBackend(before: (event: StoredSessionEvent) => Promise<void>, after: (event: StoredSessionEvent) => Promise<void> = async () => {}): SessionBackend {
  const inner = new MemorySessionBackend({ maxRecordBytes: 2 * 1024 * 1024 })
  return { maxRecordBytes: inner.maxRecordBytes, create: header => inner.create(header), readPrefix: (id, through) => inner.readPrefix(id, through), dispose: () => inner.dispose(),
    async openWriter(id) { const writer = await inner.openWriter(id); return { header: writer.header, readCommitted: () => writer.readCommitted(), dispose: () => writer.dispose(),
      async append(position, event) { await before(event); const committed = await writer.append(position, event); await after(event); return committed } } } }
}
