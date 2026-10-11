import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { JsonObject } from '../../src/foundation/json.js'
import { MemorySessionBackend } from '../../src/session/memory-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import { planExperiment } from '../../src/experiment/definition.js'
import { ExperimentJournal } from '../../src/experiment/journal.js'
import { experimentEventCatalog } from '../../src/experiment/journal-events.js'
import { experimentDefinition } from './definition-fixture.js'

async function setup() {
  const definition = experimentDefinition(join(tmpdir(), `experiment-journal-admission-${randomUUID()}`))
  const variant = (definition.variants as readonly JsonObject[])[0]!
  const plan = await planExperiment({ ...definition, variants: [variant], comparisons: [], repetitions: 1 })
  const repository = new SessionRepository({
    backend: new MemorySessionBackend({ maxRecordBytes: plan.storage.maxRecordBytes }),
    catalog: experimentEventCatalog,
    maxLineageDepth: 0,
  })
  const journal = new ExperimentJournal(await repository.create({ sessionId: plan.journalSessionId }))
  await journal.recordPlan(plan)
  const unit = plan.units[0]!
  return { journal, repository, unit }
}

const reference = () => ({ path: 'runs/recipe.json', sha256: 'a'.repeat(64), byteLength: 10 })

describe('Experiment Journal command admission', () => {
  it('captures nested command values while applying queued transitions against the committed predecessor', async () => {
    const { journal, repository, unit } = await setup()
    try {
      const start = { unitKey: unit.unitKey, templateDigest: unit.recipeDigest, recipeDigest: unit.recipeDigest, recipe: reference() }
      const disposition = { unitKey: unit.unitKey, outcome: 'failed' as const, reason: 'artifact-publication-failed',
        closure: 'confirmed' as 'confirmed' | 'unknown', evidence: reference() }
      const started = journal.startUnit(start)
      const unresolved = journal.unresolveUnit(disposition)
      expect(journal.snapshot().activeUnit).toBeNull()
      start.recipeDigest = 'b'.repeat(64)
      start.recipe.path = 'runs/changed-recipe.json'
      disposition.reason = 'controller-interrupted'
      disposition.closure = 'unknown'
      disposition.evidence.path = 'runs/changed-evidence.json'
      const [first, second] = await Promise.all([started, unresolved])
      expect(first.payload).toMatchObject({ recipeDigest: unit.recipeDigest, recipe: { path: 'runs/recipe.json' } })
      expect(second.payload).toMatchObject({ reason: 'artifact-publication-failed', closure: 'confirmed', evidence: { path: 'runs/recipe.json' } })
      expect(first.stored.sequence).toBe(2)
      expect(second.stored.sequence).toBe(3)
      expect(journal.snapshot().units[0]!.unresolved!.stored.eventId).toBe(second.stored.eventId)
    } finally { await repository.dispose() }
  })

  it('compares duplicate commands using their captured identity and complete content', async () => {
    const { journal, repository, unit } = await setup()
    try {
      const payload = { unitKey: unit.unitKey, templateDigest: unit.recipeDigest, recipeDigest: unit.recipeDigest, recipe: reference() }
      const original = structuredClone(payload)
      const first = journal.startUnit(payload)
      payload.recipe.path = 'runs/later.json'
      const duplicate = journal.startUnit(original)
      const [accepted, repeated] = await Promise.all([first, duplicate])
      expect(accepted.stored.eventId).toBe(repeated.stored.eventId)
      expect(journal.snapshot().position).toBe(2)
      await expect(journal.startUnit(payload)).rejects.toMatchObject({ code: 'EXPERIMENT_CONFLICT' })
      expect(journal.accepting).toBe(true)
    } finally { await repository.dispose() }
  })

  it('rejects an invalid request through its Promise without accepting a later repaired alias or faulting the Writer', async () => {
    const { journal, repository, unit } = await setup()
    try {
      const payload = { unitKey: unit.unitKey, templateDigest: unit.recipeDigest, recipeDigest: unit.recipeDigest,
        recipe: { ...reference(), sha256: 'invalid' } }
      let pending: ReturnType<ExperimentJournal['startUnit']> | undefined
      expect(() => { pending = journal.startUnit(payload) }).not.toThrow()
      payload.recipe.sha256 = 'a'.repeat(64)
      await expect(pending).rejects.toMatchObject({ code: 'EXPERIMENT_INPUT_INVALID' })
      expect(journal.snapshot().position).toBe(1)
      expect(journal.accepting).toBe(true)
      await journal.startUnit(payload)
      expect(journal.snapshot().activeUnit).toBe(unit.unitKey)
    } finally { await repository.dispose() }
  })

  it('checks live admission after queuing so disposal prevents an uncommitted captured command', async () => {
    const { journal, repository, unit } = await setup()
    try {
      const pending = journal.startUnit({ unitKey: unit.unitKey, templateDigest: unit.recipeDigest,
        recipeDigest: unit.recipeDigest, recipe: reference() })
      const disposed = journal.dispose()
      await expect(pending).rejects.toMatchObject({ code: 'EXPERIMENT_INACTIVE' })
      await disposed
      expect(journal.snapshot().position).toBe(1)
      expect(journal.accepting).toBe(false)
    } finally { await repository.dispose() }
  })
})
