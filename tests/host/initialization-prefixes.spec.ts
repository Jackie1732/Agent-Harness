import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FileSessionBackend, SessionRepository, decodeHostConfig, initializeHost, resolveHostConfig,
  hostRuntimeEventCatalog, parseSessionId, sessionLogPosition } from '../../src/index.js'
import { hostConfig, hostSessionId } from './fixtures.js'

it('reopens every persisted initialization prefix and resumes only the matching accepted recipe', async () => {
  const base = await mkdtemp(join(tmpdir(), 'host-init-prefixes-'))
  const original = resolveHostConfig(decodeHostConfig(hostConfig(join(base, 'original')), base))
  await initializeHost(original)
  const source = new SessionRepository({ backend: new FileSessionBackend(original.storage), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
  const snapshot = await source.read(parseSessionId(hostSessionId))
  await source.dispose()
  const records = snapshot.history.at(-1)!.events.map(event => event.stored)
  expect(records.map(event => event.type)).toEqual(['host/session-planned', 'context/profile-recorded', 'agent/spec-recorded', 'host/session-ready'])
  for (let length = 0; length <= records.length; length++) {
    const root = join(base, `prefix-${length}`)
    const spec = resolveHostConfig(decodeHostConfig(hostConfig(root), base))
    const backend = new FileSessionBackend(spec.storage)
    await backend.create(snapshot.header)
    const writer = await backend.openWriter(snapshot.header.sessionId)
    let position = sessionLogPosition(0)
    for (const record of records.slice(0, length)) position = await writer.append(position, record)
    await writer.dispose(); await backend.dispose()
    if (length === 0) {
      await expect(initializeHost(spec, { resume: true })).rejects.toMatchObject({ code: 'HOST_BOOTSTRAP_AMBIGUOUS' })
      continue
    }
    if (length < records.length) await expect(initializeHost(spec)).rejects.toMatchObject({ code: 'HOST_RECOVERY_REQUIRED' })
    await initializeHost(spec, { resume: true })
    await expect(initializeHost(spec)).resolves.toMatchObject([{ mode: 'existing' }])
    const reopened = new SessionRepository({ backend: new FileSessionBackend(spec.storage), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    try {
      const result = await reopened.read(snapshot.header.sessionId)
      expect(result.localPosition).toBe(4)
      expect(result.history.at(-1)!.events.slice(0, length).map(event => event.stored)).toEqual(records.slice(0, length))
    } finally { await reopened.dispose() }
  }
}, 30_000)
