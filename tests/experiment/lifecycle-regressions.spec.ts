import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonObject } from '../../src/foundation/json.js'
import { planExperiment } from '../../src/experiment/definition.js'
import { runExperiment } from '../../src/experiment/runner.js'
import { readExperimentStorage } from '../../src/experiment/storage.js'
import { verifyExperiment } from '../../src/experiment/analysis.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import * as initialization from '../../src/host/initialization.js'
import { experimentDefinition } from './definition-fixture.js'
import { runnableWorkflowConfig } from '../workflow/host-fixture.js'
import { textFrames } from '../model/fixtures.js'

const roots: string[] = []
async function directory() { const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-regression-')); roots.push(root); return root }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('experiment admission and acquisition failures', () => {
  it('continues an unstarted Workflow with a fresh deadline while preserving its unreferenced recipe', async () => {
    const root = await directory(), base = experimentDefinition(root), variant = (base.variants as readonly JsonObject[])[0]!
    const plan = await planExperiment({ ...base, repetitions: 1, comparisons: [], variants: [{ ...variant,
      recipe: runnableWorkflowConfig(`${root}/template`), bindings: [{ kind: 'workflow', caseKey: 'question', inputMode: 'inline', materials: [],
        workflowKey: 'research', durationMs: 60_000, nodeTasks: [{ nodeKey: 'read', prefix: 'Research: ' }],
        output: { kind: 'workflow-artifact', nodeKey: 'write', artifactName: 'report' } }] }] })
    const original = FileSessionBackend.prototype.openWriter
    const fault = vi.spyOn(FileSessionBackend.prototype, 'openWriter').mockImplementation(async function (this: FileSessionBackend, id) {
      const writer = await original.call(this, id)
      return { ...writer, append: async (position, event) => {
        if (event.type === 'experiment/unit-started') throw new Error('append rejected before committing')
        return writer.append(position, event)
      } }
    })
    const initialize = vi.spyOn(initialization, 'initializeHost')
    const firstNow = Date.now(), now = vi.spyOn(Date, 'now').mockReturnValue(firstNow)
    await expect(runExperiment(plan)).rejects.toMatchObject({ code: 'EXPERIMENT_COMMIT_UNKNOWN' })
    expect(initialize).not.toHaveBeenCalled()
    fault.mockRestore()
    const unit = plan.units[0]!, runRoot = join(plan.storage.controlRoot, 'runs', unit.unitKey)
    const orphan = (await readdir(runRoot)).find(path => path.startsWith('recipe'))!
    const orphanBytes = await readFile(join(runRoot, orphan))
    const before = (await readExperimentStorage(plan.storage.controlRoot)).state!
    expect(before.activeUnit).toBeNull()
    expect(before.units[0]!.started).toBeNull()
    const resumedNow = firstNow + 24 * 60 * 60 * 1000
    now.mockReturnValue(resumedNow)
    const result = await runExperiment(plan, { continueUnstarted: true })
    const started = result.units[0]!.started!
    const actual = JSON.parse(await readFile(join(plan.storage.controlRoot, started.payload.recipe.path), 'utf8'))
    expect(started.payload.recipe.path).toBe(`runs/${unit.unitKey}/recipe-${started.payload.recipeDigest}.json`)
    expect(actual.workflows.definitions[0].definition.deadline).toBe(new Date(resumedNow + 60_000).toISOString())
    expect(await readFile(join(runRoot, orphan))).toEqual(orphanBytes)
    expect(started.payload.recipe.path).not.toBe(`runs/${unit.unitKey}/${orphan}`)
    expect(initialize).toHaveBeenCalledTimes(1)
    expect(result.units[0]!.sealed?.payload).toMatchObject({ outcome: 'completed', closure: 'confirmed' })
    const evidence = JSON.parse(await readFile(join(plan.storage.controlRoot, result.units[0]!.sealed!.payload.evidence.path), 'utf8'))
    expect(evidence.metrics.counts['model.started'].value).toBe(2)
    expect((await verifyExperiment(plan.storage.controlRoot)).complete).toBe(true)
  }, 30_000)

  it('keeps Host acquisition rollback unconfirmed when Provider disposal fails', async () => {
    const root = await directory(), base = experimentDefinition(root)
    const plan = await planExperiment({ ...base, repetitions: 1, variants: (base.variants as readonly JsonObject[]).map(variant => ({ ...variant,
      fixture: { kind: 'programmatic', fixtureKey: 'mismatch', version: '1', sourceSha256: 'a'.repeat(64) } })) })
    let providers = 0, disposed = 0, calls = 0
    const result = await runExperiment(plan, { fixtureBindings: { mismatch: { createModelProvider: member => {
      providers++
      const provider = new ScriptedModelProvider({ ...member.model, providerId: 'mismatch', script: () => { calls++; return textFrames('42') } })
      return { descriptor: provider.descriptor, prepare: request => provider.prepare(request), dispose: async () => {
        disposed++; await provider.dispose(); throw new Error('provider disposal failed')
      } }
    } } } })
    expect(providers).toBe(1)
    expect(disposed).toBe(1)
    expect(calls).toBe(0)
    expect(result.stoppedBy).toBe('unresolved')
    expect(result.units[0]!.unresolved?.payload).toMatchObject({ outcome: 'failed', reason: 'HOST_CLEANUP_FAILED', closure: 'unknown' })
    expect(result.units[0]!.sealed).toBeNull()
    expect(result.units[0]!.unresolved!.payload.evidence).not.toBeNull()
    const marker = JSON.parse(await readFile(join(plan.units[0]!.hostRoot, '.atomic-harness.lock'), 'utf8'))
    expect(marker.token).toBeTypeOf('string')
    expect(result.units[1]!.started).toBeNull()
    await expect(stat(plan.units[1]!.hostRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await verifyExperiment(plan.storage.controlRoot)).complete).toBe(false)
  }, 30_000)
})
