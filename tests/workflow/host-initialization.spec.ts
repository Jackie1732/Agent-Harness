import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { parseSessionAddress } from '../../src/session/ids.js'
import { SessionRepository } from '../../src/session/repository.js'
import { decodeWorkflowDefinition } from '../../src/workflow/definition.js'
import { hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { initializeWorkflowCoordinator } from '../../src/host/workflow-initialization.js'
import { projectHostWorkflowSession } from '../../src/host/workflow-binding.js'
import { fingerprintHostRecipe, hostSessionPlannedV2Event } from '../../src/host/session-events.js'
import type { JsonObject } from '../../src/foundation/json.js'
import { workflowFixture } from './fixtures.js'
import { runnableWorkflowConfig, runnableWorkflowHost } from './host-fixture.js'
import { captureWorkflowTrace, seedWorkflowTrace } from './file-trace.js'
import { initializeHost } from '../../src/host/initialization.js'
import { inspectHost } from '../../src/host/inspection.js'
import { openHost } from '../../src/host/runtime.js'
import { recoverHost } from '../../src/host/recovery.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'

const maximum = 256 * 1024
function repository(root: string) {
  return new SessionRepository({ backend: new FileSessionBackend({ root, maxRecordBytes: maximum }),
    catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
}

describe('workflow coordinator initialization', () => {
  it('keeps planned initialization visible after configuration removal and stops an incomplete inventory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-planned-inventory-'))
    try {
      const original = join(root, 'original'), cut = join(root, 'cut')
      const trace = await captureWorkflowTrace(async () => { await initializeHost(runnableWorkflowHost(original)) })
      const position = trace.findIndex(item => item.kind === 'event' && item.event.type === 'host/session-planned'
        && (item.event.payload as JsonObject).kind === 'workflow')
      expect(position).toBeGreaterThan(0)
      await seedWorkflowTrace(cut, trace.slice(0, position + 1))
      const raw = runnableWorkflowConfig(cut), spec = runnableWorkflowHost(cut)
      const removed = resolveHostConfig(decodeHostConfig({ ...raw, workflows: { kind: 'disabled' } }, cut))
      const report = await inspectHost(removed, { protocolVersion: 3 })
      expect(report.workflows).toMatchObject({ count: 1, unclosed: 1, blocked: 1, entries: [{ state: 'planned' }] })
      expect(report.recovery.pending).toContain('workflow-initialization:87000000-0000-4000-8000-000000000001')
      await expect(openHost(removed)).rejects.toThrow('workflow-config-removed')
      await expect(recoverHost(removed, { predecessorStopped: true, maxRecoveryWrites: 64, maxJournalConflicts: 4 })).rejects.toThrow('workflow-config-removed')
      const extraRepository = repository(cut)
      const extra = await extraRepository.create({ sessionId: parseSessionAddress('ah-session:87000000-0000-4000-8000-000000000002') })
      await extra.dispose()
      await extraRepository.dispose()
      const entry = raw.workflows.definitions[0]!
      const bounded = resolveHostConfig(decodeHostConfig({ ...raw, workflows: { ...raw.workflows,
        definitions: [{ ...entry, definition: { ...entry.definition, limits: { ...entry.definition.limits, maxDiscoveryEntries: 3 } } }] } }, cut))
      await expect(inspectHost(bounded, { protocolVersion: 3 })).rejects.toThrow('host-inventory-limit')
      await initializeHost(spec, { resume: true })
      const host = await openHost(spec); await host.shutdown()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('adopts only the exact operator-confirmed empty Header', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-empty-'))
    const repo = repository(root)
    try {
      const definition = decodeWorkflowDefinition(workflowFixture())
      const session = await repo.create({ sessionId: parseSessionAddress(definition.coordinator) })
      const header = session.header
      await session.dispose()
      await expect(initializeWorkflowCoordinator(repo, 'host-a', definition, maximum, true)).rejects.toThrow('workflow-header-unbound')
      await expect(initializeWorkflowCoordinator(repo, 'host-a', definition, maximum, true,
        { predecessorStopped: true, expectedHeader: { ...header, createdAt: '2026-01-01T00:00:00.000Z' } })).rejects.toThrow('workflow-empty-header-mismatch')
      expect((await repo.read(header.sessionId)).localPosition).toBe(0)
      expect((await initializeWorkflowCoordinator(repo, 'host-a', definition, maximum, true,
        { predecessorStopped: true, expectedHeader: header })).mode).toBe('initialized')
      await expect(initializeWorkflowCoordinator(repo, 'host-a', definition, maximum, true,
        { predecessorStopped: true, expectedHeader: header })).rejects.toThrow('workflow-empty-header-mismatch')
      expect((await repo.read(header.sessionId)).localPosition).toBe(3)
    } finally { await repo.dispose(); await rm(root, { recursive: true, force: true }) }
  })

  it('writes one replayable protocol binding and reopens it without a model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-init-'))
    try {
      const definition = decodeWorkflowDefinition(workflowFixture())
      const first = repository(root)
      const result = await initializeWorkflowCoordinator(first, 'host-a', definition, maximum)
      expect(result.mode).toBe('initialized')
      await first.dispose()
      const second = repository(root)
      const session = await second.open(parseSessionAddress(definition.coordinator))
      const binding = projectHostWorkflowSession(session.snapshot())
      expect(binding.ready?.payload.definition).toBe(binding.definition?.stored.eventId)
      expect(binding.planned?.payload.recipe.definition).toEqual(definition)
      await session.dispose()
      expect((await initializeWorkflowCoordinator(second, 'host-a', definition, maximum)).mode).toBe('existing')
      await second.dispose()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('requires explicit resume for a planned prefix and rejects a changed recipe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-prefix-'))
    try {
      const definition = decodeWorkflowDefinition(workflowFixture())
      const recipe = { definition: definition as unknown as JsonObject }
      const first = repository(root)
      const session = await first.create({ sessionId: parseSessionAddress(definition.coordinator) })
      await session.append(hostSessionPlannedV2Event, { hostKey: 'host-a', kind: 'workflow',
        workflowKey: definition.workflowKey, recipe, fingerprint: fingerprintHostRecipe(recipe) })
      await session.dispose()
      await first.dispose()
      const second = repository(root)
      await expect(initializeWorkflowCoordinator(second, 'host-a', definition, maximum))
        .rejects.toThrow('workflow-initialization-prefix-requires-resume')
      await expect(initializeWorkflowCoordinator(second, 'host-b', definition, maximum, true))
        .rejects.toThrow('workflow-plan-recipe')
      expect((await initializeWorkflowCoordinator(second, 'host-a', definition, maximum, true)).mode).toBe('initialized')
      await second.dispose()
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('rejects an oversized record before creating the coordinator Header', async () => {
    const root = await mkdtemp(join(tmpdir(), 'workflow-preflight-'))
    try {
      const definition = decodeWorkflowDefinition(workflowFixture())
      const first = repository(root)
      await expect(initializeWorkflowCoordinator(first, 'host-a', definition, 512))
        .rejects.toThrow('workflow-initialization-record-too-large')
      await expect(first.open(parseSessionAddress(definition.coordinator))).rejects.toThrow()
      await first.dispose()
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
