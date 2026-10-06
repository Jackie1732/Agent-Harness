import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonObject } from '../../src/foundation/json.js'
import { experimentDefinition } from './definition-fixture.js'
import { planExperiment } from '../../src/experiment/definition.js'
import { runExperiment } from '../../src/experiment/runner.js'
import { createExperimentStorage, readExperimentStorage } from '../../src/experiment/storage.js'
import { collectExperimentEvidence } from '../../src/experiment/evidence.js'
import { registerDerivedEvidence, evaluateExperiment } from '../../src/experiment/analysis.js'
import { experimentBytesDigest } from '../../src/experiment/parsing.js'
import { runExperimentUnit } from '../../src/experiment/runner-unit.js'
import { formatSessionEventId, sessionSequence } from '../../src/session/ids.js'
import { runnableWorkflowConfig } from '../workflow/host-fixture.js'
import { subagentHostConfig } from '../host/subagent-fixture.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-derived-')); roots.push(root)
  const base = experimentDefinition(root), variant = (base.variants as readonly JsonObject[])[0]!
  const plan = await planExperiment({ ...base, comparisons: [], repetitions: 1, variants: [variant] })
  await runExperiment(plan)
  const state = (await readExperimentStorage(plan.storage.controlRoot)).state!, unit = state.units[0]!, planned = plan.units[0]!
  const evidence = JSON.parse(await readFile(join(plan.storage.controlRoot, unit.sealed!.payload.evidence.path), 'utf8'))
  const derivedFrom = { kind: 'reviewed-copy/v1', actionKey: 'review-copy', originalDisposition: { address: plan.experimentId, eventId: unit.sealed!.stored.eventId },
    originalEvidence: unit.sealed!.payload.evidence, recipeDigest: unit.started!.payload.recipeDigest, sourceRoot: planned.hostRoot }
  return { root, plan, unit, planned, evidence, derivedFrom, state }
}

async function unresolvedSetup() {
  const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-derived-unresolved-')); roots.push(root)
  const base = experimentDefinition(root), variant = (base.variants as readonly JsonObject[])[0]!
  const plan = await planExperiment({ ...base, comparisons: [], repetitions: 1, variants: [variant] })
  const storage = await createExperimentStorage(plan), planned = plan.units[0]!
  try {
    const result = await runExperimentUnit(plan, planned, storage, {})
    if (result.evidence === null) throw new Error('fixture evidence missing')
    const disposition = await storage.journal.unresolveUnit({ unitKey: planned.unitKey, outcome: result.outcome,
      reason: 'evidence-publication-interrupted', closure: result.closure, evidence: null })
    const started = storage.journal.snapshot().units[0]!.started!
    const derivedFrom = { kind: 'reviewed-copy/v1', actionKey: 'restore-missing-evidence',
      originalDisposition: { address: plan.experimentId, eventId: disposition.stored.eventId }, originalEvidence: null,
      recipeDigest: started.payload.recipeDigest, sourceRoot: planned.hostRoot }
    return { root, plan, planned, evidence: result.evidence, derivedFrom, disposition }
  } finally { await storage.dispose() }
}

describe('external derived evidence provenance', () => {
  it('rejects self-consistent forged output that was never produced by the fixed source cut', async () => {
    const { plan, evidence, derivedFrom } = await setup(), text = 'forged research answer'
    const forged = { ...evidence, output: { ...evidence.output, text, byteLength: Buffer.byteLength(text), sha256: experimentBytesDigest(Buffer.from(text)) } }
    await expect(registerDerivedEvidence(plan.storage.controlRoot, { unitKey: plan.units[0]!.unitKey, evidenceKey: 'forged', evidence: forged, derivedFrom })).rejects.toThrow('derived-evidence-not-reproducible')
    expect((await readExperimentStorage(plan.storage.controlRoot)).state!.evidence).toHaveLength(0)
  }, 30_000)

  it('rejects mismatched recipe/root and arbitrary source metadata before admitting an event', async () => {
    const { plan, evidence, derivedFrom } = await setup(), unitKey = plan.units[0]!.unitKey
    for (const source of [{ bogus: true }, { ...derivedFrom, recipeDigest: 'f'.repeat(64) }, { ...derivedFrom, sourceRoot: join(plan.storage.controlRoot, 'other') }]) {
      await expect(registerDerivedEvidence(plan.storage.controlRoot, { unitKey, evidenceKey: 'invalid-source', evidence, derivedFrom: source })).rejects.toMatchObject({ code: expect.stringMatching(/^EXPERIMENT_/) })
    }
    expect((await readExperimentStorage(plan.storage.controlRoot)).state!.evidence).toHaveLength(0)
  }, 30_000)

  it('registers and evaluates a verified copy while preserving original cuts, dispositions and primary selection', async () => {
    const { root, plan, planned, derivedFrom, state } = await setup(), copyRoot = join(root, 'review-store')
    await mkdir(copyRoot)
    await cp(join(planned.hostRoot, 'sessions'), join(copyRoot, 'sessions'), { recursive: true })
    const original = state.units[0]!.sealed!, primary = state.reports[0]!.payload
    const collection = await collectExperimentEvidence({ recipe: { ...planned.recipe, storage: { ...planned.recipe.storage, root: copyRoot } },
      limits: plan.evidenceLimits, scope: 'unit-local/v1', mode: 'fixture', target: JSON.parse(await readFile(join(plan.storage.controlRoot, original.payload.evidence.path), 'utf8')).target })
    const options = { unitKey: planned.unitKey, evidenceKey: 'copy', evidence: collection.evidence, derivedFrom: { ...derivedFrom, sourceRoot: copyRoot } }
    const registered = await registerDerivedEvidence(plan.storage.controlRoot, options)
    expect((await registerDerivedEvidence(plan.storage.controlRoot, options)).stored.eventId).toBe(registered.stored.eventId)
    const evaluated = await evaluateExperiment(plan.storage.controlRoot, { unitKey: planned.unitKey, evidenceKey: 'copy' })
    expect(evaluated.overall).toBe('fail')
    const after = (await readExperimentStorage(plan.storage.controlRoot)).state!
    expect(after.units[0]!.sealed!.stored.eventId).toBe(original.stored.eventId)
    expect(after.reports[0]!.payload).toEqual(primary)
    expect(after.evidence).toHaveLength(1)
    expect(after.evaluations).toHaveLength(2)
  }, 30_000)

  it('rejects an unrelated valid store when the interrupted original has no readable evidence', async () => {
    const original = await unresolvedSetup(), unrelated = await setup()
    const foreign = { unitKey: original.planned.unitKey, evidenceKey: 'unrelated', evidence: unrelated.evidence,
      derivedFrom: { ...original.derivedFrom, sourceRoot: unrelated.planned.hostRoot } }
    await expect(registerDerivedEvidence(original.plan.storage.controlRoot, foreign)).rejects.toThrow('derived-static-sessions-missing')
    const after = (await readExperimentStorage(original.plan.storage.controlRoot)).state!
    expect(after.evidence).toHaveLength(0)
    expect(after.units[0]!.unresolved!.stored.eventId).toBe(original.disposition.stored.eventId)
  }, 30_000)

  it('binds a missing-original copy to the actual mode, storage settings and exact Agent input receipt', async () => {
    const original = await unresolvedSetup()
    const historicalMode = await collectExperimentEvidence({ recipe: original.planned.recipe, limits: original.plan.evidenceLimits,
      mode: 'historical', scope: 'unit-local/v1', target: original.evidence.target! })
    const historicalScope = await collectExperimentEvidence({ recipe: original.planned.recipe, limits: original.plan.evidenceLimits,
      mode: 'fixture', scope: 'historical-local/v1', target: original.evidence.target! })
    for (const evidence of [
      historicalMode.evidence,
      historicalScope.evidence,
      { ...original.evidence, source: { ...original.evidence.source, maxLineageDepth: original.evidence.source.maxLineageDepth + 1 } },
    ]) {
      await expect(registerDerivedEvidence(original.plan.storage.controlRoot, { unitKey: original.planned.unitKey, evidenceKey: 'invalid-settings', evidence,
        derivedFrom: original.derivedFrom })).rejects.toThrow('derived-source-settings')
    }
    const target = original.evidence.target
    if (target?.kind !== 'agent') throw new Error('expected Agent target')
    const wrongReceipt = { ...target, inputEventId: formatSessionEventId(target.sessionId, sessionSequence(1)) }
    const changed = await collectExperimentEvidence({ recipe: original.planned.recipe, limits: original.plan.evidenceLimits,
      mode: 'fixture', scope: 'unit-local/v1', target: wrongReceipt })
    await expect(registerDerivedEvidence(original.plan.storage.controlRoot, { unitKey: original.planned.unitKey, evidenceKey: 'wrong-input',
      evidence: changed.evidence, derivedFrom: original.derivedFrom })).rejects.toThrow('derived-agent-input-source')
    expect((await readExperimentStorage(original.plan.storage.controlRoot)).state!.evidence).toHaveLength(0)
  }, 30_000)

  it('accepts a verified copy after missing-original interruption without changing that disposition', async () => {
    const original = await unresolvedSetup(), copyRoot = join(original.root, 'review-store')
    await cp(join(original.planned.hostRoot, 'sessions'), join(copyRoot, 'sessions'), { recursive: true })
    const collected = await collectExperimentEvidence({ recipe: { ...original.planned.recipe, storage: { ...original.planned.recipe.storage, root: copyRoot } },
      limits: original.plan.evidenceLimits, mode: 'fixture', scope: 'unit-local/v1', target: original.evidence.target! })
    await registerDerivedEvidence(original.plan.storage.controlRoot, { unitKey: original.planned.unitKey, evidenceKey: 'reviewed', evidence: collected.evidence,
      derivedFrom: { ...original.derivedFrom, sourceRoot: copyRoot } })
    const after = (await readExperimentStorage(original.plan.storage.controlRoot)).state!
    expect(after.evidence).toHaveLength(1)
    expect(after.units[0]!.unresolved!.stored.eventId).toBe(original.disposition.stored.eventId)
    expect(after.units[0]!.sealed).toBeNull()
    expect(after.evaluations).toHaveLength(0)
  }, 30_000)

  it('authenticates the actual Workflow deadline, coordinator and accepted output selector in a reviewed copy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-derived-workflow-')); roots.push(root)
    const base = experimentDefinition(root), variant = (base.variants as readonly JsonObject[])[0]!
    const plan = await planExperiment({ ...base, comparisons: [], repetitions: 1, variants: [{ ...variant,
      recipe: runnableWorkflowConfig(join(root, 'template')), bindings: [{ kind: 'workflow', caseKey: 'question', inputMode: 'inline', materials: [],
        workflowKey: 'research', durationMs: 60_000, nodeTasks: [{ nodeKey: 'read', prefix: 'Research: ' }],
        output: { kind: 'workflow-artifact', nodeKey: 'write', artifactName: 'report' } }] }] })
    await runExperiment(plan)
    const state = (await readExperimentStorage(plan.storage.controlRoot)).state!, unit = state.units[0]!, planned = plan.units[0]!
    const sealed = unit.sealed!
    const evidence = JSON.parse(await readFile(join(plan.storage.controlRoot, sealed.payload.evidence.path), 'utf8'))
    const copyRoot = join(root, 'review-store')
    await cp(join(planned.hostRoot, 'sessions'), join(copyRoot, 'sessions'), { recursive: true })
    const collected = await collectExperimentEvidence({ recipe: { ...planned.recipe, storage: { ...planned.recipe.storage, root: copyRoot } },
      limits: plan.evidenceLimits, mode: 'fixture', scope: 'unit-local/v1', target: evidence.target })
    await registerDerivedEvidence(plan.storage.controlRoot, { unitKey: planned.unitKey, evidenceKey: 'workflow-copy', evidence: collected.evidence,
      derivedFrom: { kind: 'reviewed-copy/v1', actionKey: 'workflow-review',
        originalDisposition: { address: plan.experimentId, eventId: sealed.stored.eventId }, originalEvidence: sealed.payload.evidence,
        recipeDigest: unit.started!.payload.recipeDigest, sourceRoot: copyRoot } })
    expect((await readExperimentStorage(plan.storage.controlRoot)).state!.evidence).toHaveLength(1)
  }, 30_000)

  it('verifies a dynamic Child copy through its actual parent delegation and installation sources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-derived-child-')); roots.push(root)
    const base = experimentDefinition(root), variant = (base.variants as readonly JsonObject[])[0]!
    const plan = await planExperiment({ ...base, comparisons: [], repetitions: 1, variants: [{ ...variant,
      recipe: await subagentHostConfig(join(root, 'template')),
      fixture: { kind: 'programmatic', fixtureKey: 'delegation', version: '1', sourceSha256: 'a'.repeat(64) } }] })
    let calls = 0
    await runExperiment(plan, { fixtureBindings: { delegation: { createModelProvider: member => {
      let parentCalls = 0
      return new ScriptedModelProvider({ ...member.model, script: async function* (): AsyncGenerator<ModelFrame> {
        calls++
        const parent = member.agentKey === 'writer'
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'derived-child-fixture' }
        if (parent && parentCalls++ === 0) {
          yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'spawn', name: 'agent_spawn_subagent' }
          yield { kind: 'arguments-delta', index: 0, text: JSON.stringify({ templateKey: 'research', templateVersion: 1,
            task: 'Check supplied evidence', materials: [{ label: 'evidence', text: '42' }],
            requestedBudget: { models: 2, steps: 2, tools: 0, messages: 4, waits: 2, outputTokens: 512 }, workspace: { kind: 'none' } }) }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
        } else {
          yield { kind: 'block-start', index: 0, block: 'text' }
          yield { kind: 'text-delta', index: 0, text: parent ? 'parent answer' : 'child verified evidence' }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
        }
      } })
    } } } })
    expect(calls).toBe(3)
    const state = (await readExperimentStorage(plan.storage.controlRoot)).state!, unit = state.units[0]!, planned = plan.units[0]!
    const sealed = unit.sealed!
    const evidence = JSON.parse(await readFile(join(plan.storage.controlRoot, sealed.payload.evidence.path), 'utf8'))
    expect(evidence.selectedSessionIds).toHaveLength(2)
    const copyRoot = join(root, 'review-store')
    await cp(join(planned.hostRoot, 'sessions'), join(copyRoot, 'sessions'), { recursive: true })
    const collected = await collectExperimentEvidence({ recipe: { ...planned.recipe, storage: { ...planned.recipe.storage, root: copyRoot } },
      limits: plan.evidenceLimits, mode: 'fixture', scope: 'unit-local/v1', target: evidence.target })
    await registerDerivedEvidence(plan.storage.controlRoot, { unitKey: planned.unitKey, evidenceKey: 'child-copy', evidence: collected.evidence,
      derivedFrom: { kind: 'reviewed-copy/v1', actionKey: 'child-review', originalDisposition: { address: plan.experimentId, eventId: sealed.stored.eventId },
        originalEvidence: sealed.payload.evidence, recipeDigest: unit.started!.payload.recipeDigest, sourceRoot: copyRoot } })
    expect((await readExperimentStorage(plan.storage.controlRoot)).state!.evidence).toHaveLength(1)
    expect(calls).toBe(3)
  }, 45_000)
})
