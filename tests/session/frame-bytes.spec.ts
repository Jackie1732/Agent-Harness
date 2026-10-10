import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createDurableEventCatalog, FileSessionBackend, parseSessionId, SessionRepository } from '../../src/index.js'
import { encodeFrame, FrameScanner } from '../../src/session/frame.js'
import { deltaEvent, firstId, identities } from './fixtures.js'

type HeaderField = 'length' | 'checksum'

function fieldOffset(frame: Buffer, field: HeaderField): number {
  return field === 'length' ? 0 : frame.indexOf(0x09) + 1
}

function corruptField(frame: Buffer, field: HeaderField): number {
  const offset = fieldOffset(frame, field)
  frame[offset] = frame[offset]! | 0x80
  return offset
}

describe('Session frame byte integrity', () => {
  it.each(['length', 'checksum'] as const)('rejects a non-ASCII %s byte in a complete frame', field => {
    const frame = Buffer.from(encodeFrame(Buffer.from('{}'), 128))
    corruptField(frame, field)
    expect(() => new FrameScanner(128).push(frame)).toThrowError(
      expect.objectContaining({ code: 'SESSION_LOG_INVALID' }),
    )
  })

  it.each(['length', 'checksum'] as const)('rejects a non-ASCII %s byte at interrupted EOF', field => {
    const frame = Buffer.from(encodeFrame(Buffer.from('{}'), 128))
    const offset = corruptField(frame, field)
    const scanner = new FrameScanner(128)
    expect(() => {
      scanner.push(frame.subarray(0, offset + 1))
      scanner.finish(true)
    }).toThrowError(expect.objectContaining({ code: 'SESSION_LOG_INVALID' }))
  })

  it('preserves UTF-8 payload bytes across one-byte chunks and valid interrupted fields', () => {
    const payload = Buffer.from('{"message":"帧"}')
    const frame = Buffer.from(encodeFrame(payload, 128))
    const scanner = new FrameScanner(128)
    const decoded = []
    for (const byte of frame) decoded.push(...scanner.push(Uint8Array.of(byte)))
    expect(decoded.map(item => Buffer.from(item.payload))).toEqual([payload])
    expect(scanner.finish(false)).toEqual({ byteLength: frame.byteLength })

    for (const cut of [1, frame.indexOf(0x09) + 5, frame.byteLength - 2, frame.byteLength - 1]) {
      const partial = new FrameScanner(128)
      partial.push(frame.subarray(0, cut))
      expect(partial.finish(true).incompleteTail).toEqual({ byteOffset: 0, byteLength: cut })
    }
  })
})

async function withFileSession(
  run: (backend: FileSessionBackend, directory: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'atomic-frame-bytes-'))
  const repository = new SessionRepository({
    backend: new FileSessionBackend({ root, maxRecordBytes: 4096 }),
    catalog: createDurableEventCatalog([deltaEvent]),
    maxLineageDepth: 2,
    identitySource: identities(firstId),
    clock: { now: () => 1_789_257_600_000 },
  })
  const backend = new FileSessionBackend({ root, maxRecordBytes: 4096 })
  try {
    const session = await repository.create()
    await session.append(deltaEvent, { value: 1 })
    await repository.dispose()
    await run(backend, join(root, 'sessions', firstId))
  } finally {
    await backend.dispose()
    await repository.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

describe('File Session corrupted frame recovery', () => {
  it.each([
    ['length', 'complete'], ['checksum', 'complete'],
    ['length', 'partial'], ['checksum', 'partial'],
  ] as const)('preserves a non-ASCII %s byte in a %s event frame', async (field, kind) => {
    await withFileSession(async (backend, directory) => {
      const path = join(directory, 'events.log')
      const original = await readFile(path)
      const corrupted = Buffer.from(original)
      const offset = corruptField(corrupted, field)
      const bytes = kind === 'complete' ? corrupted : corrupted.subarray(0, offset + 1)
      await writeFile(path, bytes)
      const sessionId = parseSessionId(firstId)

      await expect(backend.readPrefix(sessionId)).rejects.toMatchObject({ code: 'SESSION_LOG_INVALID' })
      await expect(backend.openWriter(sessionId)).rejects.toMatchObject({ code: 'SESSION_LOG_INVALID' })
      expect(await readFile(path)).toEqual(bytes)

      await writeFile(path, original)
      const writer = await backend.openWriter(sessionId)
      expect((await writer.readCommitted()).position).toBe(1)
      await writer.dispose()
    })
  })

  it.each(['length', 'checksum'] as const)('preserves a non-ASCII %s byte in an immutable Header', async field => {
    await withFileSession(async (backend, directory) => {
      const path = join(directory, 'header.frame')
      const corrupted = await readFile(path)
      corruptField(corrupted, field)
      await writeFile(path, corrupted)
      const sessionId = parseSessionId(firstId)

      await expect(backend.readPrefix(sessionId)).rejects.toMatchObject({ code: 'SESSION_LOG_INVALID' })
      await expect(backend.openWriter(sessionId)).rejects.toMatchObject({ code: 'SESSION_LOG_INVALID' })
      expect(await readFile(path)).toEqual(corrupted)
    })
  })
})
