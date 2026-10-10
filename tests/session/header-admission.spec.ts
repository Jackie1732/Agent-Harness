import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileSessionBackend, MemorySessionBackend, formatSessionAddress, parseSessionId, sessionLogPosition } from '../../src/index.js'
import type { SessionHeader } from '../../src/index.js'

describe.each(['Memory', 'File'] as const)('%s Header admission', kind => {
  it('captures the immutable Header before initialization yields', async () => {
    const temporaryParent = tmpdir()
    const root = await mkdtemp(join(temporaryParent, 'atomic-header-admission-'))
    const backend = kind === 'File'
      ? new FileSessionBackend({ root, maxRecordBytes: 4096 })
      : new MemorySessionBackend({ maxRecordBytes: 4096 })
    const sessionId = parseSessionId('00000000-0000-4000-8000-000000000130')
    const parent = { sessionId: parseSessionId('00000000-0000-4000-8000-000000000131'), through: sessionLogPosition(1) }
    const header = { formatVersion: 1 as const, sessionId, address: formatSessionAddress(sessionId),
      createdAt: '2026-10-10T00:00:00.000Z', parent } satisfies SessionHeader
    try {
      const pending = backend.create(header)
      header.createdAt = '2026-10-10T01:00:00.000Z'
      parent.through = sessionLogPosition(9)
      await pending
      expect((await backend.readPrefix(sessionId)).header).toMatchObject({
        createdAt: '2026-10-10T00:00:00.000Z', parent: { through: 1 },
      })
    } finally {
      try { await backend.dispose() }
      finally {
        expect(dirname(root)).toBe(temporaryParent)
        await rm(root, { recursive: true, force: true })
      }
    }
  })
})
