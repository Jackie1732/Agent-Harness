import { describe, expect, it } from 'vitest'
import {
  createDurableEventCatalog,
  createDurableEventDefinition,
  MemorySessionBackend,
  sessionLogPosition,
  SessionError,
  SessionRepository,
} from '../../src/index.js'
import type {
  JsonObject,
  SessionBackend,
  SessionHeader,
  SessionId,
  SessionWriter,
} from '../../src/index.js'
import { deltaEvent, firstId, identities } from './fixtures.js'

describe('Session append failures', () => {
  it('does not advance the Handle after a size failure', async () => {
    const textEvent = createDurableEventDefinition<JsonObject>({
      type: 'test/large',
      payloadVersion: 1,
      ignorable: false,
      decode: value => value as JsonObject,
    })
    const repo = new SessionRepository({
      backend: new MemorySessionBackend({ maxRecordBytes: 400 }),
      catalog: createDurableEventCatalog([deltaEvent, textEvent]),
      maxLineageDepth: 1,
      identitySource: identities(firstId),
    })
    const handle = await repo.create()

    await expect(handle.append(textEvent, { text: 'x'.repeat(5_000) })).rejects.toMatchObject({
      code: 'SESSION_RECORD_TOO_LARGE',
    })
    expect(handle.status).toBe('open')
    expect(handle.snapshot().localPosition).toBe(0)
    await expect(handle.append(deltaEvent, { value: 1 })).resolves.toMatchObject({
      stored: { sequence: 1 },
    })
    await repo.dispose()
  })

  it('faults a Handle whose Backend reports an ambiguous append and keeps its old snapshot', async () => {
    class AmbiguousBackend implements SessionBackend {
      readonly inner = new MemorySessionBackend({ maxRecordBytes: 4096 })
      get maxRecordBytes(): number { return this.inner.maxRecordBytes }
      writerLive = false
      unknown = false

      create(header: SessionHeader): Promise<void> {
        return this.inner.create(header)
      }

      async openWriter(sessionId: SessionId): Promise<SessionWriter> {
        const writer = await this.inner.openWriter(sessionId)
        this.writerLive = true
        return {
          header: writer.header,
          readCommitted: () => writer.readCommitted(),
          append: async (position, event) => {
            await writer.append(position, event)
            this.unknown = true
            throw new SessionError('SESSION_APPEND_OUTCOME_UNKNOWN', 'injected ambiguous commit')
          },
          dispose: async () => {
            await writer.dispose()
            this.writerLive = false
          },
        }
      }

      readPrefix(sessionId: SessionId, through?: ReturnType<typeof sessionLogPosition>) {
        if (this.unknown && this.writerLive) {
          return Promise.reject(new SessionError('SESSION_APPEND_OUTCOME_UNKNOWN', 'commit boundary unknown'))
        }
        return this.inner.readPrefix(sessionId, through)
      }

      dispose(): Promise<void> {
        return this.inner.dispose()
      }
    }

    const backend = new AmbiguousBackend()
    const repo = new SessionRepository({
      backend,
      catalog: createDurableEventCatalog([deltaEvent]),
      maxLineageDepth: 1,
      identitySource: identities(firstId),
    })
    const handle = await repo.create()
    await expect(handle.append(deltaEvent, { value: 5 })).rejects.toMatchObject({
      code: 'SESSION_APPEND_OUTCOME_UNKNOWN',
    })
    expect(handle.status).toBe('faulted')
    expect(handle.snapshot().localPosition).toBe(0)
    await expect(repo.read(handle.header.sessionId)).rejects.toMatchObject({
      code: 'SESSION_APPEND_OUTCOME_UNKNOWN',
    })
    await handle.dispose()
    await expect(repo.read(handle.header.sessionId)).resolves.toMatchObject({ localPosition: 1 })
    await repo.dispose()
  })
})
