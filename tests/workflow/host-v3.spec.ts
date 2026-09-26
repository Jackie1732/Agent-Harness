import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeHostConfig, planHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { initializeHost } from '../../src/host/initialization.js'
import { hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { exportHostConfig } from '../../src/host/config-export.js'
import { inspectHost } from '../../src/host/inspection.js'
import { parseChannelId } from '../../src/communication/ids.js'
import { parseSessionId } from '../../src/session/ids.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import type { JsonObject } from '../../src/foundation/json.js'
import { twoMemberHostConfig } from '../host/fixtures.js'
import { workflowFixture } from './fixtures.js'

function config(root: string): JsonObject {
  const host = twoMemberHostConfig(root)
  const base = workflowFixture()
  const definition = { ...base, coordinator: null, roster: [
    { ...base.roster[0], memberKey: 'writer', address: 'ah-session:70000000-0000-4000-8000-000000000101' },
    { ...base.roster[1], memberKey: 'reviewer', address: 'ah-session:70000000-0000-4000-8000-000000000102' },
  ], nodes: [
    { ...base.nodes[0], executor: 'writer' }, { ...base.nodes[1], executor: 'reviewer' },
  ], communication: { ...base.communication, ask: [{ from: 'writer', to: 'reviewer' }], disclosures: [
    { nodeKey: 'read', recipients: ['coordinator', 'reviewer'] },
    { nodeKey: 'write', recipients: ['coordinator'] },
  ] } }
  return { ...host, schemaVersion: 3, subagents: { kind: 'disabled' }, workspaceResources: [],
    workflows: { kind: 'enabled', definitions: [{ sessionId: null, definition }],
      maxBusinessConcurrency: 1, maxInventorySessions: 3 } }
}

describe('Host v3 workflow planning', () => {
  it('plans a coordinator, initializes its Session, and opens a protocol-only slot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-v3-workflow-'))
    try {
      const unplanned = decodeHostConfig(config(root), root)
      const planned = planHostConfig(unplanned, { nextSessionId: () => parseSessionId('87000000-0000-4000-8000-000000000001'),
        nextChannelId: () => parseChannelId('71000000-0000-4000-8000-000000000101') })
      expect(planned.schemaVersion).toBe(3)
      if (planned.schemaVersion !== 3 || planned.workflows.kind !== 'enabled') throw new Error('expected v3 workflow')
      expect(planned.workflows.definitions[0]?.definition.coordinator)
        .toBe('ah-session:87000000-0000-4000-8000-000000000001')
      const spec = resolveHostConfig(planned)
      expect((await initializeHost(spec)).map(item => item.mode)).toEqual(['initialized', 'initialized', 'initialized'])
      const repository = new SessionRepository({ backend: new FileSessionBackend(spec.storage),
        catalog: hostRuntimeEventCatalog, maxLineageDepth: spec.storage.maxLineageDepth })
      const member = await repository.read(parseSessionId('70000000-0000-4000-8000-000000000101'))
      expect(member.history.at(-1)?.events.filter(item => item.stored.type.startsWith('host/session-'))
        .map(item => [item.stored.payloadVersion, item.kind === 'known' && (item.payload as JsonObject).kind]))
        .toEqual([[2, 'agent'], [2, 'agent']])
      await repository.dispose()
      expect((await inspectHost(spec, { protocolVersion: 3 })).workflows).toMatchObject({
        count: 1, entries: [{ workflowKey: 'research', state: 'ready' }], truncated: false,
      })
      const host = await openHost(spec)
      expect(host.status).toBe('ready')
      await host.shutdown()
      expect((await initializeHost(spec)).map(item => item.mode)).toEqual(['existing', 'existing', 'existing'])
      expect(exportHostConfig(spec).redacted).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects a subagent-local v3 resource field and an unbound roster', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-v3-invalid-'))
    try {
      const base = config(root)
      const subagents = { kind: 'disabled', workspaceResources: [] }
      expect(() => decodeHostConfig({ ...base, subagents }, root)).toThrow()
      const workflows = base.workflows as JsonObject
      const entries = workflows.definitions as readonly JsonObject[]
      const entry = entries[0]!
      const definition = entry.definition as JsonObject
      const roster = definition.roster as readonly JsonObject[]
      expect(() => decodeHostConfig({ ...base, workflows: { ...workflows, definitions: [{ ...entry,
        definition: { ...definition, roster: [{ ...roster[0], address: 'ah-session:87000000-0000-4000-8000-000000000099' }, roster[1]] },
      }] } }, root)).toThrow('workflow-roster-member')
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('discovers a coordinator when a later config disables Workflows', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-v3-removed-'))
    try {
      const configured = planHostConfig(decodeHostConfig(config(root), root), {
        nextSessionId: () => parseSessionId('87000000-0000-4000-8000-000000000001'),
        nextChannelId: () => parseChannelId('71000000-0000-4000-8000-000000000101'),
      })
      const spec = resolveHostConfig(configured)
      await initializeHost(spec)
      const removed = resolveHostConfig(decodeHostConfig({ ...configured, workflows: { kind: 'disabled' } }, root))
      await expect(openHost(removed)).rejects.toThrow('workflow-config-removed')
      const reopened = await openHost(spec)
      await reopened.shutdown()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
