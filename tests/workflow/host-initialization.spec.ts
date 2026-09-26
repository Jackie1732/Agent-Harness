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

const maximum = 256 * 1024
function repository(root: string) {
  return new SessionRepository({ backend: new FileSessionBackend({ root, maxRecordBytes: maximum }),
    catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
}

describe('workflow coordinator initialization', () => {
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
