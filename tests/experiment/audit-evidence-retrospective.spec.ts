import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { initializeHost, hostRuntimeEventCatalog } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import type { ResolvedHostSpec } from '../../src/host/config.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { SessionRepository } from '../../src/session/repository.js'
import { FrameScanner } from '../../src/session/frame.js'
import { parseSessionId } from '../../src/session/ids.js'
import type { SessionId } from '../../src/session/ids.js'
import { collectExperimentEvidence } from '../../src/experiment/evidence.js'
import { decodeExperimentEvidence } from '../../src/experiment/evidence-codec.js'
import type { JsonObject } from '../../src/foundation/json.js'
import type { ExperimentEvidenceTarget } from '../../src/experiment/evidence-types.js'
import { planExperiment } from '../../src/experiment/definition.js'
import { registerDerivedEvidence } from '../../src/experiment/analysis.js'
import { createExperimentStorage, readExperimentStorage } from '../../src/experiment/storage.js'
import { runExperimentUnit } from '../../src/experiment/runner-unit.js'
import { experimentDefinition } from './definition-fixture.js'
import { runnableWorkflowConfig, runnableWorkflowHost } from '../workflow/host-fixture.js'

const limits = { maxSessionCount: 20, maxEvents: 10000, maxEvidenceBytes: 8 * 1024 * 1024, maxMetricSamples: 1000 }
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function completedWorkflow() {
  const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-workflow-evidence-')); roots.push(root)
  const recipe = runnableWorkflowHost(join(root, 'original'))
  await initializeHost(recipe)
  const host = await openHost(recipe)
  try {
    await host.workflow('research').resume({ requestKey: 'start' })
    await host.run()
    expect(host.workflow('research').report()).toMatchObject({ state: 'completed', closed: true })
  } finally { await host.shutdown() }
  const target = { kind: 'workflow' as const, sessionId: parseSessionId('87000000-0000-4000-8000-000000000001'), mediaType: 'text/plain' as const,
    selector: { kind: 'workflow-artifact' as const, nodeKey: 'write', artifactName: 'report' } }
  const input = { recipe, limits, scope: 'historical-local/v1' as const, mode: 'historical' as const, target }
  return { root, recipe, input }
}

async function truncateCopiedSessionBeforeEvent(recipe: ResolvedHostSpec, copyRoot: string, sessionId: SessionId, beforeType: string) {
  const repository = new SessionRepository({ backend: new FileSessionBackend(recipe.storage), catalog: hostRuntimeEventCatalog, maxLineageDepth: 4 })
  let through: number
  try {
    const snapshot = await repository.read(sessionId)
    through = snapshot.history.at(-1)!.events.find(event => event.stored.type === beforeType)!.stored.sequence - 1
  } finally { await repository.dispose() }
  const path = join(copyRoot, 'sessions', sessionId, 'events.log')
  const log = await readFile(path), frames = new FrameScanner(recipe.storage.maxRecordBytes).push(log)
  const prefix = log.subarray(0, frames[through - 1]!.endOffset)
  await writeFile(path, prefix)
  return { path, log, prefix }
}

describe('complete Workflow evidence authenticates the existing cross-Session protocol', () => {
  it('retains complete metrics and accepted output from a closed Workflow', async () => {
    const { input } = await completedWorkflow()
    const { evidence } = await collectExperimentEvidence(input)
    expect(evidence.coverage).toMatchObject({ complete: true, observedSessions: 3 })
    expect(evidence.metrics.counts['workflow.accepted'].value).toBe(2)
    expect(evidence.metrics.counts['model.started'].value).toBe(2)
    expect(evidence.output).toMatchObject({ status: 'available', text: 'final report' })
    expect(decodeExperimentEvidence(JSON.parse(JSON.stringify(evidence)), limits)).toEqual(evidence)
  }, 30_000)

  it.each([
    { producer: 'writer', beforeType: 'work/proposal-recorded' },
    { producer: 'coordinator', beforeType: 'communication/outbox-attempt-started' },
  ])('marks a valid $producer prefix before $beforeType incomplete without changing it', async ({ producer, beforeType }) => {
    const { root, recipe, input } = await completedWorkflow()
    const copyRoot = join(root, 'copy')
    await cp(join(recipe.storage.root, 'sessions'), join(copyRoot, 'sessions'), { recursive: true })
    const sessionId = producer === 'writer' ? parseSessionId(recipe.members.find(member => member.agentKey === 'writer')!.sessionId) : input.target.sessionId
    const { path, log, prefix } = await truncateCopiedSessionBeforeEvent(recipe, copyRoot, sessionId, beforeType)
    const copied = { ...input, recipe: { ...recipe, storage: { ...recipe.storage, root: copyRoot } } }
    const collected = await collectExperimentEvidence(copied)
    expect(collected.evidence.coverage).toMatchObject({ complete: false, observedSessions: 3, reasons: ['WORKFLOW_HISTORY_INVALID'] })
    expect(collected.evidence.metrics.counts['model.started']).toMatchObject({ value: null, knownSubtotal: 2, status: 'incomplete' })
    expect(collected.evidence.metrics.counts['workflow.accepted']).toMatchObject({ value: null, knownSubtotal: producer === 'writer' ? 2 : 0 })
    expect(collected.evidence.metrics.tokens.inputTokens.total).toBeNull()
    expect(collected.evidence.output).toMatchObject({ status: 'unavailable', reason: 'evidence-incomplete' })
    expect(decodeExperimentEvidence(JSON.parse(JSON.stringify(collected.evidence)), limits)).toEqual(collected.evidence)
    const subset = await collectExperimentEvidence({ ...copied, selected: [{ sessionId }] })
    expect(subset.evidence.coverage).toMatchObject({ complete: true, expectedSessions: 1, observedSessions: 1 })
    expect(subset.evidence.selectedSessionIds).toEqual([sessionId])
    expect(await readFile(path)).toEqual(prefix)
    expect(await readFile(join(recipe.storage.root, 'sessions', sessionId, 'events.log'))).toEqual(log)
  }, 30_000)

  it('authenticates a complete managed Workflow copy before registering it when the interrupted original has no evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'atomic-experiment-derived-workflow-evidence-')); roots.push(root)
    const base = experimentDefinition(root), variant = (base.variants as readonly JsonObject[])[0]!
    const plan = await planExperiment({ ...base, comparisons: [], repetitions: 1, variants: [{ ...variant,
      recipe: runnableWorkflowConfig(join(root, 'template')), bindings: [{ kind: 'workflow', caseKey: 'question', inputMode: 'inline', materials: [],
        workflowKey: 'research', durationMs: 60_000, nodeTasks: [{ nodeKey: 'read', prefix: 'Research: ' }],
        output: { kind: 'workflow-artifact', nodeKey: 'write', artifactName: 'report' } }] }] })
    const planned = plan.units[0]!, storage = await createExperimentStorage(plan)
    let target: ExperimentEvidenceTarget
    let selected: readonly { sessionId: SessionId }[]
    let derivedFrom: JsonObject
    let completeEvidence: Awaited<ReturnType<typeof runExperimentUnit>>['evidence']
    try {
      const result = await runExperimentUnit(plan, planned, storage, {})
      expect(result.evidence!.coverage.complete).toBe(true)
      completeEvidence = result.evidence
      target = result.evidence!.target!
      selected = result.evidence!.selectedSessionIds.map(sessionId => ({ sessionId }))
      const disposition = await storage.journal.unresolveUnit({ unitKey: planned.unitKey, outcome: result.outcome,
        reason: 'evidence-publication-interrupted', closure: result.closure, evidence: null })
      derivedFrom = { kind: 'reviewed-copy/v1', actionKey: 'review-copy', originalDisposition: { address: plan.experimentId, eventId: disposition.stored.eventId },
        originalEvidence: null, recipeDigest: storage.journal.snapshot().units[0]!.started!.payload.recipeDigest, sourceRoot: planned.hostRoot }
    } finally { await storage.dispose() }
    await registerDerivedEvidence(plan.storage.controlRoot, { unitKey: planned.unitKey, evidenceKey: 'complete-source',
      evidence: completeEvidence, derivedFrom })
    const copyRoot = join(root, 'incomplete-copy')
    await cp(join(planned.hostRoot, 'sessions'), join(copyRoot, 'sessions'), { recursive: true })
    const writerId = parseSessionId(planned.recipe.members.find(member => member.agentKey === 'writer')!.sessionId)
    const { path, prefix, log } = await truncateCopiedSessionBeforeEvent(planned.recipe, copyRoot, writerId, 'work/proposal-recorded')
    const collected = await collectExperimentEvidence({ recipe: { ...planned.recipe, storage: { ...planned.recipe.storage, root: copyRoot } },
      scope: 'unit-local/v1', mode: 'fixture', limits: plan.evidenceLimits, target, selected })
    expect(collected.evidence.coverage.complete).toBe(true)
    const before = (await readExperimentStorage(plan.storage.controlRoot)).state!
    const journalPath = join(plan.storage.controlRoot, 'journal-store', 'sessions', plan.journalSessionId, 'events.log')
    const journalBytes = await readFile(journalPath)
    await expect(registerDerivedEvidence(plan.storage.controlRoot, { unitKey: planned.unitKey, evidenceKey: 'incomplete-source',
      evidence: collected.evidence, derivedFrom: { ...derivedFrom, actionKey: 'incomplete-review', sourceRoot: copyRoot } }))
      .rejects.toMatchObject({ code: 'WORKFLOW_HISTORY_INVALID', message: 'workflow-causal-source-missing' })
    expect((await readExperimentStorage(plan.storage.controlRoot)).state).toEqual(before)
    expect(before.evidence).toHaveLength(1)
    expect(before.units[0]!.sealed).toBeNull()
    expect(before.units[0]!.unresolved!.payload.evidence).toBeNull()
    await expect(stat(join(plan.storage.controlRoot, 'derived', 'incomplete-source'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(journalPath)).toEqual(journalBytes)
    expect(await readFile(path)).toEqual(prefix)
    expect(await readFile(join(planned.hostRoot, 'sessions', writerId, 'events.log'))).toEqual(log)
  }, 30_000)
})
