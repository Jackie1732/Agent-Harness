import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JsonObject } from '../../src/foundation/json.js'
import type { HostRunReport } from '../../src/host/runtime-types.js'
import * as hostRuntime from '../../src/host/runtime.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import type { ModelFrame } from '../../src/model/contract.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import { planExperiment } from '../../src/experiment/definition.js'
import { runExperiment } from '../../src/experiment/runner.js'
import { collectExperimentEvidence } from '../../src/experiment/evidence.js'
import { decodeExperimentEvidence } from '../../src/experiment/evidence-codec.js'
import { verifyExperiment } from '../../src/experiment/analysis.js'
import { experimentDefinition } from './definition-fixture.js'
import { runnableWorkflowConfig } from '../workflow/host-fixture.js'

const roots: string[] = []
const fixtureSourceSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex')
async function directory() { const root = await mkdtemp(join(tmpdir(), 'experiment-driving-')); roots.push(root); return root }
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function workflowDefinition(root: string, maxDriveCalls: number): JsonObject {
  const base = experimentDefinition(root), variant = (base.variants as readonly JsonObject[])[0]!
  const recipe = runnableWorkflowConfig(`${root}/template`)
  return { ...base, repetitions: 1, comparisons: [], runPolicy: { ...(base.runPolicy as JsonObject), maxDriveCalls },
    variants: [{ ...variant, recipe: { ...recipe, scheduling: { ...recipe.scheduling, maxBatchesPerRun: 1 } },
      bindings: [{ kind: 'workflow', caseKey: 'question', inputMode: 'inline', materials: [], workflowKey: 'research',
        durationMs: 60_000, nodeTasks: [{ nodeKey: 'read', prefix: 'Research: ' }],
        output: { kind: 'workflow-artifact', nodeKey: 'write', artifactName: 'report' } }] }] }
}

function observeWorkflowRuns() {
  const observed: { readonly report: HostRunReport; readonly settled: boolean; readonly closed: boolean }[] = []
  const open = hostRuntime.openHost
  vi.spyOn(hostRuntime, 'openHost').mockImplementation(async (recipe, options) => {
    const host = await open(recipe, options), run = host.run.bind(host)
    vi.spyOn(host, 'run').mockImplementation(async options => {
      const report = await run(options), workflow = host.workflow('research').report()
      observed.push({ report, settled: workflow.settled, closed: workflow.closed })
      return report
    })
    return host
  })
  return observed
}

describe('finite experiment driving', () => {
  it('resumes actual one-batch Workflow runs until the target is settled and closed', async () => {
    const root = await directory(), plan = await planExperiment(workflowDefinition(root, 64)), observed = observeWorkflowRuns()
    const result = await runExperiment(plan)
    expect(observed.length).toBeGreaterThan(1)
    expect(observed.length).toBeLessThanOrEqual(plan.runPolicy.maxDriveCalls)
    expect(observed[0]).toMatchObject({ report: { stoppedBy: 'batch-budget', batches: 1 }, settled: false, closed: false })
    expect(observed.every(item => item.report.batches <= 1)).toBe(true)
    expect(observed.at(-1)).toMatchObject({ settled: true, closed: true })
    expect(result.units[0]!.sealed?.payload).toMatchObject({ outcome: 'completed', closure: 'confirmed' })
    const unit = plan.units[0]!
    const evidence = decodeExperimentEvidence(JSON.parse(await readFile(join(plan.storage.controlRoot, `runs/${unit.unitKey}/evidence.json`), 'utf8')), plan.evidenceLimits)
    expect(evidence.output).toMatchObject({ status: 'available', text: 'final report' })
    expect(evidence.metrics.counts['model.started'].value).toBe(2)
    expect(evidence.metrics.counts['workflow.accepted'].value).toBe(2)
    expect(evidence.metrics.counts['workflow.closed'].value).toBe(1)
    expect((await verifyExperiment(plan.storage.controlRoot)).complete).toBe(true)
  }, 30_000)

  it('exhausts the explicit drive allowance without submitting or retrying another business task', async () => {
    const root = await directory(), plan = await planExperiment(workflowDefinition(root, 1)), observed = observeWorkflowRuns()
    const result = await runExperiment(plan)
    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({ report: { stoppedBy: 'batch-budget', batches: 1 }, settled: false, closed: false })
    expect(result.units[0]!.sealed?.payload).toMatchObject({ outcome: 'failed', reason: 'drive-limit', closure: 'confirmed' })
    const unit = plan.units[0]!
    const evidence = decodeExperimentEvidence(JSON.parse(await readFile(join(plan.storage.controlRoot, `runs/${unit.unitKey}/evidence.json`), 'utf8')), plan.evidenceLimits)
    expect(evidence.output.status).toBe('unavailable')
    expect(evidence.metrics.counts['model.started'].value).toBe(0)
    expect(evidence.metrics.counts['workflow.cancelled'].value).toBe(1)
    expect(evidence.metrics.counts['workflow.closed'].value).toBe(0)
    expect((await verifyExperiment(plan.storage.controlRoot)).complete).toBe(true)
  }, 30_000)

  it('disposes an undeclared user wait by stopping its exact root without another Model call or fabricated answer', async () => {
    const root = await directory(), base = experimentDefinition(root), variant = (base.variants as readonly JsonObject[])[0]!
    const recipe = variant.recipe as JsonObject
    const plan = await planExperiment({ ...base, repetitions: 1, comparisons: [], variants: [{ ...variant,
      fixture: { kind: 'programmatic', fixtureKey: 'waiting', version: '1', sourceSha256: fixtureSourceSha256 },
      recipe: { ...recipe, members: (recipe.members as readonly JsonObject[]).map(member => ({ ...member,
        spec: { ...(member.spec as JsonObject), nativeActions: ['agent_ask_user'] },
        model: { ...(member.model as JsonObject), runnerLimits: { ...((member.model as JsonObject).runnerLimits as JsonObject), maxToolCalls: 1 } } })) } }] })
    let calls = 0, released = 0
    const result = await runExperiment(plan, { fixtureBindings: { waiting: { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      onClose: () => { released++ }, script: async function* (): AsyncGenerator<ModelFrame> {
        calls++
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'waiting-case' }
        yield { kind: 'block-start', index: 0, block: 'tool-call', callId: 'confirmation', name: 'agent_ask_user' }
        yield { kind: 'arguments-delta', index: 0, text: '{"question":"Continue?","timeoutMs":60000}' }
        yield { kind: 'block-end', index: 0 }
        yield { kind: 'complete', stopReason: 'tool-calls' }
      } }) } } })
    expect(calls).toBe(1)
    expect(released).toBe(1)
    expect(result.units[0]!.sealed?.payload).toMatchObject({ outcome: 'failed', reason: 'quiescent', closure: 'confirmed' })
    const unit = plan.units[0]!
    const collected = await collectExperimentEvidence({ recipe: unit.recipe, limits: plan.evidenceLimits, scope: 'unit-local/v1', mode: 'fixture' })
    const agent = projectAgentSession(collected.snapshots[0]!)
    expect(agent.roots).toHaveLength(1)
    expect(agent.roots[0]!.outcome).toBe('cancelled')
    expect(agent.waits).toHaveLength(1)
    expect(agent.waits[0]!.settled?.payload.outcome).toBe('cancelled')
    expect(agent.inputs.filter(input => input.reference.kind === 'user')).toHaveLength(1)
    expect(collected.evidence.metrics.counts['model.started'].value).toBe(1)
  }, 30_000)
})
