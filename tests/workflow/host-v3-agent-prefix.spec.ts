import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { parseSessionId, sessionLogPosition } from '../../src/session/ids.js'
import { SessionRepository } from '../../src/session/repository.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { hostRuntimeEventCatalog, initializeHost } from '../../src/host/initialization.js'
import { hostConfig, hostSessionId } from '../host/fixtures.js'

function v3(root: string) {
  return resolveHostConfig(decodeHostConfig({ ...hostConfig(root), schemaVersion: 3,
    subagents: { kind: 'disabled' }, workspaceResources: [], workflows: { kind: 'disabled' } }, root))
}

it('resumes each v3 Agent binding prefix without changing its committed records', async () => {
  const base = await mkdtemp(join(tmpdir(), 'host-v3-agent-prefix-'))
  try {
    const original = v3(join(base, 'original'))
    await initializeHost(original)
    const source = new SessionRepository({ backend: new FileSessionBackend(original.storage),
      catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
    const snapshot = await source.read(parseSessionId(hostSessionId))
    await source.dispose()
    const records = snapshot.history.at(-1)!.events.map(event => event.stored)
    expect(records.map(record => [record.type, record.payloadVersion])).toEqual([
      ['host/session-planned', 2], ['context/profile-recorded', 2], ['agent/spec-recorded', 1], ['host/session-ready', 2],
    ])
    for (let length = 1; length <= records.length; length++) {
      const spec = v3(join(base, `prefix-${length}`))
      const backend = new FileSessionBackend(spec.storage)
      await backend.create(snapshot.header)
      const writer = await backend.openWriter(snapshot.header.sessionId)
      let position = sessionLogPosition(0)
      for (const record of records.slice(0, length)) position = await writer.append(position, record)
      await writer.dispose(); await backend.dispose()
      if (length < records.length) await expect(initializeHost(spec)).rejects.toMatchObject({ code: 'HOST_RECOVERY_REQUIRED' })
      await initializeHost(spec, { resume: true })
      const reopened = new SessionRepository({ backend: new FileSessionBackend(spec.storage),
        catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
      try {
        const saved = await reopened.read(snapshot.header.sessionId)
        expect(saved.history.at(-1)!.events.slice(0, length).map(event => event.stored)).toEqual(records.slice(0, length))
      } finally { await reopened.dispose() }
    }
  } finally { await rm(base, { recursive: true, force: true }) }
}, 30_000)
