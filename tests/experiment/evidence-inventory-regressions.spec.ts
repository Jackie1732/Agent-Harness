import { appendFile, cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { hostRuntimeEventCatalog, initializeHost } from '../../src/host/initialization.js'
import { openHost } from '../../src/host/runtime.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { FileSessionBackend } from '../../src/session/file-backend.js'
import { parseSessionId, sessionLogPosition } from '../../src/session/ids.js'
import { SessionRepository } from '../../src/session/repository.js'
import { FrameScanner } from '../../src/session/frame.js'
import { collectExperimentEvidence, verifyExperimentEvidence } from '../../src/experiment/evidence.js'
import { decodeExperimentEvidence } from '../../src/experiment/evidence-codec.js'
import type { ExperimentEvidenceTarget } from '../../src/experiment/evidence-types.js'
import { hostConfig, twoMemberHostConfig } from '../host/fixtures.js'
import { subagentHostConfig } from '../host/subagent-fixture.js'
import { runnableWorkflowHost } from '../workflow/host-fixture.js'

const limits = { maxSessionCount: 20, maxEvents: 10000, maxEvidenceBytes: 8 * 1024 * 1024, maxMetricSamples: 1000 }
const clock = { now: () => Date.parse('2026-09-22T00:00:00Z') }
const roots: string[] = []
async function directory() { const root = await mkdtemp(join(tmpdir(), 'atomic-evidence-inventory-')); roots.push(root); return root }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

describe('default evidence includes declared and installed Sessions', () => {
  it('retains the readable member when a declared member is absent from a review copy', async () => {
    const root = await directory(), recipe = resolveHostConfig(decodeHostConfig(twoMemberHostConfig(join(root, 'original')), root))
    await initializeHost(recipe)
    const retained = recipe.members[1]!, copyRoot = join(root, 'partial')
    await cp(join(recipe.storage.root, 'sessions', retained.sessionId), join(copyRoot, 'sessions', retained.sessionId), { recursive: true })
    const { evidence, snapshots } = await collectExperimentEvidence({ recipe: { ...recipe, storage: { ...recipe.storage, root: copyRoot } },
      limits, scope: 'historical-local/v1', mode: 'historical' })
    expect(evidence.coverage).toMatchObject({ complete: false, observedSessions: 1 })
    expect(evidence.selectedSessionIds).toEqual(recipe.members.map(member => member.sessionId).sort())
    expect(snapshots.map(snapshot => snapshot.header.sessionId)).toEqual([retained.sessionId])
    expect(evidence.metrics.counts['session.selected']).toMatchObject({ value: null, knownSubtotal: 1, status: 'incomplete' })
    expect(decodeExperimentEvidence(JSON.parse(JSON.stringify(evidence)), limits)).toEqual(evidence)
  })

  it('requires the enabled Workflow coordinator while preserving explicit member-only selections', async () => {
    const root = await directory(), recipe = runnableWorkflowHost(join(root, 'original')), copyRoot = join(root, 'partial')
    await initializeHost(recipe)
    for (const member of recipe.members) await cp(join(recipe.storage.root, 'sessions', member.sessionId),
      join(copyRoot, 'sessions', member.sessionId), { recursive: true })
    const input = { recipe: { ...recipe, storage: { ...recipe.storage, root: copyRoot } }, limits,
      scope: 'historical-local/v1' as const, mode: 'historical' as const }
    const complete = await collectExperimentEvidence({ ...input, recipe })
    expect(complete.evidence.coverage).toMatchObject({ complete: true, observedSessions: 3 })
    const partial = await collectExperimentEvidence(input)
    expect(partial.evidence.coverage).toMatchObject({ complete: false, observedSessions: 2 })
    expect(partial.evidence.selectedSessionIds).toHaveLength(3)
    expect(partial.evidence.metrics.counts['session.selected']).toMatchObject({ value: null, knownSubtotal: 2, status: 'incomplete' })
    expect(decodeExperimentEvidence(JSON.parse(JSON.stringify(partial.evidence)), limits)).toEqual(partial.evidence)
    const selected = await collectExperimentEvidence({ ...input, selected: [{ sessionId: parseSessionId(recipe.members[0]!.sessionId) }] })
    expect(selected.evidence.coverage).toMatchObject({ complete: true, expectedSessions: 1, observedSessions: 1 })
    expect(selected.evidence.selectedSessionIds).toEqual([recipe.members[0]!.sessionId])
  })

  it('marks an absent installed Child incomplete without losing Parent costs or expanding an explicit subset', async () => {
    const root = await directory(), recipe = resolveHostConfig(decodeHostConfig(await subagentHostConfig(join(root, 'original')), root))
    await initializeHost(recipe, { clock })
    let parentCalls = 0, childCalls = 0
    const host = await openHost(recipe, { clock, bindings: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* (): AsyncGenerator<ModelFrame> {
        const parent = member.agentKey === 'writer', call = parent ? parentCalls++ : childCalls++
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'inventory-test' }
        if (parent && call === 0) {
          yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'spawn', name: 'agent_spawn_subagent' }
          yield { kind: 'arguments-delta', index: 0, text: JSON.stringify({ templateKey: 'research', templateVersion: 1,
            task: 'Check the supplied evidence', materials: [{ label: 'evidence', text: '42' }],
            requestedBudget: { models: 2, steps: 2, tools: 0, messages: 4, waits: 2, outputTokens: 512 }, workspace: { kind: 'none' } }) }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'tool-calls' }
        } else {
          yield { kind: 'block-start', index: 0, block: 'text' }
          yield { kind: 'text-delta', index: 0, text: parent ? 'Parent adopted the evidence.' : 'Child checked the evidence.' }
          yield { kind: 'block-end', index: 0 }; yield { kind: 'complete', stopReason: 'stop' }
        }
      } }) } })
    let target: ExperimentEvidenceTarget
    try {
      const receipt = await host.submitTask('writer', 'Delegate a bounded check')
      target = { kind: 'agent', sessionId: parseSessionId(recipe.members[0]!.sessionId), inputEventId: receipt.eventId,
        selector: { kind: 'root-final' }, mediaType: 'text/plain' }
      await host.run()
    } finally { await host.shutdown({ mode: 'drain' }) }
    expect({ parentCalls, childCalls }).toEqual({ parentCalls: 2, childCalls: 1 })
    const input = { recipe, limits, scope: 'historical-local/v1' as const, mode: 'historical' as const, target }
    const complete = await collectExperimentEvidence(input)
    expect(complete.evidence.coverage).toMatchObject({ complete: true, observedSessions: 2 })
    expect(complete.evidence.metrics.counts['model.started'].value).toBe(3)
    const copyRoot = join(root, 'partial'), parentId = parseSessionId(recipe.members[0]!.sessionId)
    await cp(join(recipe.storage.root, 'sessions', parentId), join(copyRoot, 'sessions', parentId), { recursive: true })
    const copiedInput = { ...input, recipe: { ...recipe, storage: { ...recipe.storage, root: copyRoot } } }
    const log = join(copyRoot, 'sessions', parentId, 'events.log'), before = await readFile(log)
    const partial = await collectExperimentEvidence(copiedInput)
    expect(partial.evidence.coverage).toMatchObject({ complete: false, observedSessions: 1 })
    expect(partial.evidence.selectedSessionIds).toEqual(complete.evidence.selectedSessionIds)
    expect(partial.evidence.metrics.counts['model.started']).toMatchObject({ value: null, knownSubtotal: 2, status: 'incomplete' })
    expect(partial.evidence.output).toMatchObject({ status: 'unavailable', reason: 'evidence-incomplete' })
    expect(partial.snapshots.map(snapshot => snapshot.header.sessionId)).toEqual([parentId])
    expect(decodeExperimentEvidence(JSON.parse(JSON.stringify(partial.evidence)), limits)).toEqual(partial.evidence)
    const selected = await collectExperimentEvidence({ ...copiedInput, selected: [{ sessionId: parentId }] })
    expect(selected.evidence.coverage).toMatchObject({ complete: true, expectedSessions: 1, observedSessions: 1 })
    expect(selected.evidence.metrics.counts['model.started']).toMatchObject({ value: 2, knownSubtotal: 2, status: 'complete' })
    expect(selected.evidence.output).toMatchObject({ status: 'available', text: 'Parent adopted the evidence.' })
    expect(await readFile(log)).toEqual(before)
    const childId = complete.evidence.selectedSessionIds.find(sessionId => sessionId !== parentId)!
    await cp(join(recipe.storage.root, 'sessions', childId), join(copyRoot, 'sessions', childId), { recursive: true })
    const childLog = join(copyRoot, 'sessions', childId, 'events.log'), childBytes = await readFile(childLog)
    const frames = new FrameScanner(recipe.storage.maxRecordBytes).push(childBytes)
    for (const through of [6, 2]) {
      const prefix = childBytes.subarray(0, frames[through - 1]!.endOffset)
      await writeFile(childLog, prefix)
      const shortened = await collectExperimentEvidence(copiedInput)
      expect(shortened.evidence.coverage).toMatchObject({ complete: false, observedSessions: 2, reasons: ['SUBAGENT_STATE_INVALID'] })
      expect(shortened.evidence.metrics.counts['model.started']).toMatchObject({ value: null, knownSubtotal: 2, status: 'incomplete' })
      expect(shortened.evidence.output).toMatchObject({ status: 'unavailable', reason: 'evidence-incomplete' })
      expect(decodeExperimentEvidence(JSON.parse(JSON.stringify(shortened.evidence)), limits)).toEqual(shortened.evidence)
      expect(await readFile(childLog)).toEqual(prefix)
      expect((await collectExperimentEvidence({ ...copiedInput, selected: [{ sessionId: parentId }] })).evidence.coverage.complete).toBe(true)
    }
  }, 30_000)

  it('reports a grown raw log exceeding the verification budget as a limit error', async () => {
    const root = await directory(), recipe = resolveHostConfig(decodeHostConfig(hostConfig(join(root, 'store')), root))
    await initializeHost(recipe)
    const { evidence } = await collectExperimentEvidence({ recipe, limits, scope: 'historical-local/v1', mode: 'historical' })
    const originalBytes = evidence.sessions.reduce((sum, session) => sum + session.header.byteLength + session.log.byteLength, 0)
    const session = evidence.sessions[0]!
    await appendFile(join(recipe.storage.root, session.log.path), 'new physical bytes')
    await expect(verifyExperimentEvidence(evidence, originalBytes)).rejects.toMatchObject({
      code: 'EXPERIMENT_LIMIT_EXCEEDED', message: 'evidence-byte-limit',
    })
    expect(await verifyExperimentEvidence(evidence, limits.maxEvidenceBytes)).toContain(`file-changed:${session.log.path}`)
  })

  it('keeps both Forks behind a failed precheck of their shared ancestor', async () => {
    const root = await directory(), recipe = resolveHostConfig(decodeHostConfig(hostConfig(join(root, 'original')), root))
    const repository = new SessionRepository({ backend: new FileSessionBackend(recipe.storage), catalog: hostRuntimeEventCatalog,
      maxLineageDepth: recipe.storage.maxLineageDepth })
    const parent = await repository.create()
    const forks = [await repository.fork(parent.header.sessionId, sessionLogPosition(0)),
      await repository.fork(parent.header.sessionId, sessionLogPosition(0))]
    await repository.dispose()
    const copyRoot = join(root, 'partial')
    for (const fork of forks) await cp(join(recipe.storage.root, 'sessions', fork.header.sessionId),
      join(copyRoot, 'sessions', fork.header.sessionId), { recursive: true })
    await cp(join(recipe.storage.root, 'sessions', parent.header.sessionId, 'header.frame'),
      join(copyRoot, 'sessions', parent.header.sessionId, 'header.frame'))
    const { evidence, snapshots } = await collectExperimentEvidence({ recipe: { ...recipe, storage: { ...recipe.storage, root: copyRoot } },
      limits, scope: 'historical-local/v1', mode: 'historical', selected: forks.map(fork => ({ sessionId: fork.header.sessionId })) })
    expect(evidence.coverage).toMatchObject({ complete: false, expectedSessions: 2, observedSessions: 0 })
    expect(snapshots).toEqual([])
    await expect(stat(join(copyRoot, 'sessions', parent.header.sessionId, 'events.log'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(decodeExperimentEvidence(JSON.parse(JSON.stringify(evidence)), limits)).toEqual(evidence)
  })
})
