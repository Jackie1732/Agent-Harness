import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileSessionBackend, initializeHost, parseSessionId, resolveHostConfig, SessionRepository } from '../../src/index.js'
import { decodeHostConfig } from '../../src/host/config.js'
import { hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { createHostTools } from '../../src/host/tool-factory.js'
import { hostConfig } from './fixtures.js'

describe('Host tool assembly', () => {
  it('binds read_text to an explicit workspace and protects Session storage', async () => {
    const base = await mkdtemp(join(tmpdir(), 'atomic-host-tools-'))
    const storage = join(base, 'sessions')
    const workspace = join(base, 'workspace')
    await mkdir(workspace)
    await writeFile(join(workspace, 'note.txt'), 'tool result', 'utf8')
    const input = hostConfig(storage)
    const original = (input.members as readonly Record<string, unknown>[])[0]!
    const profile = original.profile as Record<string, unknown>
    const spec = original.spec as Record<string, unknown>
    const schemaLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
    const tools = {
      kind: 'workspace-read-text', rootId: 'research-workspace', rootPath: workspace, protectedRoots: [],
      maxReadBytes: 4096, maxPathBytes: 1024, maxArgumentsBytes: 4096, maxResultBytes: 8192,
      schemaLimits,
      invocationLimits: { ...schemaLimits, maxRequestBytes: 65536, maxPlanBytes: 65536,
        maxArgumentsBytes: 4096, maxJsonDepth: 24, maxJsonNodes: 10000, maxResultBytes: 8192,
        maxJournalConflicts: 4 },
      policy: { policyId: 'host-read-policy', version: 1, decision: 'allow', reasonCode: 'configured-read' },
    }
    const config = decodeHostConfig({ ...input, members: [{ ...original,
      profile: { ...profile, toolNames: ['read_text'] },
      spec: { ...spec, toolNames: ['read_text'], budget: { ...(spec.budget as object), tools: 1 } }, tools,
    }] }, base)
    const resolved = resolveHostConfig(config)
    await initializeHost(resolved)
    const backend = new FileSessionBackend({ root: storage, maxRecordBytes: config.storage.maxRecordBytes })
    const repository = new SessionRepository({ backend, catalog: hostRuntimeEventCatalog,
      maxLineageDepth: config.storage.maxLineageDepth })
    const member = resolved.members[0]!
    if (member.kind !== 'local') throw new Error('expected local member')
    const session = await repository.open(parseSessionId(member.sessionId))
    const resources = await createHostTools(session, member, storage)
    if (resources === undefined) throw new Error('expected tool resources')
    try {
      const settled = await resources.runner.invoke({ name: 'read_text', input: { path: 'note.txt' } })
      expect(settled.payload).toMatchObject({ outcome: 'succeeded', result: { kind: 'success', value: {
        path: 'note.txt', text: 'tool result', byteLength: 11,
      } } })
    } finally {
      await resources.runner.dispose()
      await resources.dispose()
      await repository.dispose()
    }
  })
})
