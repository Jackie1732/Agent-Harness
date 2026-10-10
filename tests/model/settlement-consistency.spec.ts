import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { sessionLogPosition } from '../../src/session/ids.js'
import { SessionModelRunner } from '../../src/model/runner.js'
import { projectModelSession } from '../../src/model/projection.js'
import { modelSettledEvent } from '../../src/model/session-events.js'
import { repository, request, runnerLimits, scripted, textFrames } from './fixtures.js'

describe('Model settlement consistency', () => {
  it('rejects completed with a failure before appending a Catalog fact', async () => {
    const repo = repository(), session = await repo.create(), provider = scripted()
    const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    try {
      const completed = await runner.invoke(request())
      const before = session.snapshot().localPosition
      expect(() => session.append(modelSettledEvent, { ...completed.payload,
        failure: { code: 'MODEL_PROTOCOL_INVALID', phase: 'streaming', retryable: false } }),
      ).toThrowError(expect.objectContaining({ code: 'SESSION_EVENT_INVALID' }))
      expect(session.snapshot().localPosition).toBe(before)
      expect(session.status).toBe('open')
      expect(projectModelSession(session.snapshot()).invocations[0]?.state).toBe('settled')
    } finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })

  it('rejects a contradictory persisted outcome without changing the File bytes', async () => {
    const source = repository(), session = await source.create()
    const provider = scripted({ script: async function* () {
      yield* textFrames()
      yield { kind: 'text-delta', index: 0, text: 'invalid trailing content' }
    } })
    const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    const temporaryParent = tmpdir(), root = await mkdtemp(join(temporaryParent, 'atomic-model-consistency-'))
    try {
      const failed = await runner.invoke(request())
      expect(failed.payload.outcome).toBe('failed')
      expect(failed.payload.failure?.code).toBe('MODEL_PROTOCOL_INVALID')
      const snapshot = session.snapshot(), id = snapshot.header.sessionId
      const backend = new FileSessionBackend({ root, maxRecordBytes: 65536 })
      try {
        await backend.create(snapshot.header)
        const writer = await backend.openWriter(id)
        try {
          for (const event of snapshot.history.at(-1)!.events) {
            const stored = event.stored.type === modelSettledEvent.type
              ? { ...event.stored, payload: { ...failed.payload, outcome: 'completed' } }
              : event.stored
            await writer.append(sessionLogPosition(stored.sequence - 1), stored)
          }
        } finally { await writer.dispose() }
      } finally { await backend.dispose() }
      const log = join(root, 'sessions', id, 'events.log')
      await appendFile(log, Buffer.from('123\t'))
      const before = await readFile(log)
      const reopened = repository(new FileSessionBackend({ root, maxRecordBytes: 65536 }))
      try {
        await expect(reopened.read(id)).rejects.toMatchObject({ code: 'SESSION_EVENT_INVALID' })
        expect(await readFile(log)).toEqual(before)
        await expect(reopened.open(id)).rejects.toMatchObject({ code: 'SESSION_EVENT_INVALID' })
        expect(await readFile(log)).toEqual(before)
      } finally { await reopened.dispose() }
    } finally {
      try { await runner.dispose(); await provider.dispose(); await source.dispose() }
      finally {
        expect(dirname(root)).toBe(temporaryParent)
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('keeps completed generation evidence when trailing protocol data fails', async () => {
    const repo = repository(), session = await repo.create()
    const provider = scripted({ script: async function* () {
      yield* textFrames('accepted answer')
      yield { kind: 'text-delta', index: 0, text: 'invalid trailing content' }
    } })
    const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    try {
      const committed = await runner.invoke(request())
      expect(committed.payload).toMatchObject({ outcome: 'failed', external: 'response-observed',
        failure: { code: 'MODEL_PROTOCOL_INVALID', phase: 'streaming' },
        cleanup: { status: 'complete', failedResources: 0 }, result: { protocolComplete: true,
          blocks: [{ kind: 'text', text: 'accepted answer', complete: true }] } })
      const state = projectModelSession(session.snapshot()).invocations[0]
      expect(state?.state).toBe('settled')
      if (state?.state === 'settled') expect(state.settled).toEqual(committed)
    } finally { await runner.dispose(); await provider.dispose(); await repo.dispose() }
  })

  it('keeps completed generation evidence when resource cleanup fails', async () => {
    const repo = repository(), session = await repo.create()
    const provider = scripted({ onClose: () => { throw new Error('fixture close failure') } })
    const runner = new SessionModelRunner({ session, provider, limits: runnerLimits })
    try {
      await expect(runner.invoke(request())).rejects.toMatchObject({ code: 'MODEL_CLEANUP_FAILED' })
      const state = projectModelSession(session.snapshot()).invocations[0]
      expect(state?.state).toBe('settled')
      if (state?.state === 'settled') {
        expect(state.settled.payload).toMatchObject({ outcome: 'failed', external: 'response-observed',
          failure: { code: 'MODEL_CLEANUP_FAILED', phase: 'closing' },
          cleanup: { status: 'incomplete', failedResources: 1 }, result: { protocolComplete: true,
            blocks: [{ kind: 'text', text: 'hello 世界', complete: true }] } })
      }
    } finally {
      await runner.dispose().catch(() => undefined)
      await expect(provider.dispose()).rejects.toMatchObject({ code: 'MODEL_CLEANUP_FAILED' })
      await repo.dispose()
    }
  })
})
