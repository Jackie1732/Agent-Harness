import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { JsonObject } from '../../src/foundation/json.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import * as workspaceRead from '../../src/tool/providers/workspace-read.js'
import { projectToolSession } from '../../src/tool/projection.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { planExperiment } from '../../src/experiment/definition.js'
import { runExperiment } from '../../src/experiment/runner.js'
import { collectExperimentEvidence } from '../../src/experiment/evidence.js'
import { decodeExperimentEvidence } from '../../src/experiment/evidence-codec.js'
import { verifyExperiment } from '../../src/experiment/analysis.js'
import { experimentDefinition } from './definition-fixture.js'

const roots: string[] = []
const sourceSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex')
async function directory() { const root = await mkdtemp(join(tmpdir(), 'experiment-unknown-')); roots.push(root); return root }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function definition(root: string, onCaseFailure: 'continue' | 'stop'): JsonObject {
  const base = experimentDefinition(root), schemaLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
  const tools = { kind: 'workspace-read-text', rootId: 'research-materials', rootPath: `${root}/template-workspace`, protectedRoots: [],
    maxReadBytes: 4096, maxPathBytes: 1024, maxArgumentsBytes: 4096, maxResultBytes: 8192, schemaLimits,
    invocationLimits: { ...schemaLimits, maxRequestBytes: 65536, maxPlanBytes: 65536, maxArgumentsBytes: 4096,
      maxJsonDepth: 24, maxJsonNodes: 10000, maxResultBytes: 8192, maxJournalConflicts: 4 },
    policy: { policyId: 'research-material-policy', version: 1, decision: 'allow', reasonCode: 'configured-research-read' } }
  return { ...base, repetitions: 1, runPolicy: { ...(base.runPolicy as JsonObject), onCaseFailure },
    variants: (base.variants as readonly JsonObject[]).map(variant => {
      const recipe = variant.recipe as JsonObject
      return { ...variant, fixture: { kind: 'programmatic', fixtureKey: 'reader', version: '1', sourceSha256 },
        recipe: { ...recipe, members: (recipe.members as readonly JsonObject[]).map(member => ({ ...member, tools,
          profile: { ...(member.profile as JsonObject), toolNames: ['read_text'] },
          spec: { ...(member.spec as JsonObject), toolNames: ['read_text'],
            budget: { models: 2, steps: 2, tools: 1, messages: 0, waits: 0, outputTokens: 512 } },
          model: { ...(member.model as JsonObject), runnerLimits: { ...((member.model as JsonObject).runnerLimits as JsonObject), maxToolCalls: 1 } } })) },
        bindings: [{ kind: 'agent', caseKey: 'question', agentKey: 'writer', inputMode: 'workspace',
          materials: [{ logicalPath: 'notes.txt', resourceId: null, relativePath: 'in/notes.txt' }], output: { kind: 'root-final' } }] }
    }) }
}

it.each(['continue', 'stop'] as const)('seals an actually read but unacknowledged Tool result after successful resource closure, honoring %s', async onCaseFailure => {
  const root = await directory(), plan = await planExperiment(definition(root, onCaseFailure))
  let toolProviders = 0, actualReads = 0, toolCloses = 0, modelProviders = 0, modelCalls = 0, modelDisposals = 0
  const create = workspaceRead.createWorkspaceReadTextProvider
  vi.spyOn(workspaceRead, 'createWorkspaceReadTextProvider').mockImplementation(async options => {
    const provider = await create(options), ordinal = ++toolProviders
    return { descriptor: provider.descriptor, dispose: () => provider.dispose(), prepare: (selected, input, limits) => {
      const prepared = provider.prepare(selected, input, limits)
      return { plan: prepared.plan, acquire: async (committed, signal) => {
        const execution = await prepared.acquire(committed, signal)
        return { start: async () => {
          const result = await execution.start()
          expect(result.kind).toBe('success')
          if (result.kind === 'success') expect((result.value as JsonObject).text).toBe('The answer is 42.\r\n')
          actualReads++
          if (ordinal === 1) throw new Error('execution completed but result acknowledgement was lost')
          return result
        }, close: async () => { await execution.close(); toolCloses++ } }
      } }
    } }
  })
  const result = await runExperiment(plan, { fixtureBindings: { reader: { createModelProvider: member => {
    const ordinal = ++modelProviders
    if (ordinal === 2) { expect(toolCloses).toBe(1); expect(modelDisposals).toBe(1) }
    let calls = 0
    const provider = new ScriptedModelProvider({ ...member.model, script: async function* (): AsyncGenerator<ModelFrame> {
      calls++; modelCalls++
      yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'known-close' }
      if (calls === 1) {
        yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'material', name: 'read_text' }
        yield { kind: 'arguments-delta', index: 0, text: '{"path":"in/notes.txt"}' }
        yield { kind: 'block-end', index: 0 }
        yield { kind: 'complete', stopReason: 'tool-calls' }
      } else {
        yield { kind: 'block-start', index: 0, block: 'text' }
        yield { kind: 'text-delta', index: 0, text: '42' }
        yield { kind: 'block-end', index: 0 }
        yield { kind: 'complete', stopReason: 'stop' }
      }
    } })
    return { descriptor: provider.descriptor, prepare: request => provider.prepare(request), dispose: async () => { await provider.dispose(); modelDisposals++ } }
  } } } })
  expect(result.units[0]!.sealed?.payload).toMatchObject({ outcome: 'result-unknown', closure: 'confirmed', reason: 'tool-result-uncertain' })
  expect(result.units[0]!.unresolved).toBeNull()
  const first = plan.units[0]!
  const evidence = decodeExperimentEvidence(JSON.parse(await readFile(join(plan.storage.controlRoot, `runs/${first.unitKey}/evidence.json`), 'utf8')), plan.evidenceLimits)
  const collected = await collectExperimentEvidence({ recipe: first.recipe, limits: plan.evidenceLimits, scope: 'unit-local/v1', mode: 'fixture', target: evidence.target! })
  const snapshot = collected.snapshots[0]!, invocation = projectToolSession(snapshot).invocations[0]!
  expect(projectAgentSession(snapshot).roots[0]!.outcome).toBe('result-unknown')
  if (invocation.state !== 'settled') throw new Error('the actual Tool invocation must settle')
  expect(invocation.settled.payload).toMatchObject({ outcome: 'failed', execution: 'may-have-executed', cleanup: { status: 'complete', attempted: 1, failed: 0 } })
  expect(evidence.output).toMatchObject({ status: 'unavailable', reason: 'root-not-completed' })
  expect(evidence.metrics.counts['tool.started'].value).toBe(1)
  expect(evidence.metrics.counts['tool.executionObserved'].value).toBe(0)
  expect(evidence.metrics.counts['tool.cleanupFailed'].value).toBe(0)
  const expectedUnits = onCaseFailure === 'continue' ? 2 : 1
  expect(actualReads).toBe(expectedUnits)
  expect(toolCloses).toBe(expectedUnits)
  expect(modelProviders).toBe(expectedUnits)
  expect(modelDisposals).toBe(expectedUnits)
  expect(modelCalls).toBe(onCaseFailure === 'continue' ? 3 : 1)
  if (onCaseFailure === 'continue') {
    expect(result.stoppedBy).toBe('completed')
    expect(result.units[1]!.sealed?.payload).toMatchObject({ outcome: 'completed', closure: 'confirmed' })
  } else {
    expect(result.stoppedBy).toBe('policy')
    expect(result.units[1]!.notRun).toBe('skipped-by-policy')
    await expect(stat(plan.units[1]!.hostRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  }
  expect((await verifyExperiment(plan.storage.controlRoot)).complete).toBe(true)
}, 30_000)
