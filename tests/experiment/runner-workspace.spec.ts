import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JsonObject } from '../../src/foundation/json.js'
import { snapshotJson } from '../../src/foundation/json.js'
import { projectAgentSession } from '../../src/agent/projection.js'
import type { ResolvedHostSpec } from '../../src/host/config.js'
import type { HostRuntimeBindings } from '../../src/host/slot.js'
import type { ModelFrame, ModelRequest } from '../../src/model/contract.js'
import { ScriptedModelProvider } from '../../src/model/providers/scripted.js'
import { projectModelSession } from '../../src/model/projection.js'
import { projectToolSession } from '../../src/tool/projection.js'
import { freezeSessionSnapshot } from '../../src/session/session-handle.js'
import { sessionLogPosition } from '../../src/session/ids.js'
import { planExperiment } from '../../src/experiment/definition.js'
import { runExperiment } from '../../src/experiment/runner.js'
import { collectExperimentEvidence } from '../../src/experiment/evidence.js'
import { experimentAgentRoot, selectExperimentOutput } from '../../src/experiment/evidence-output.js'
import type { ExperimentEvidenceTarget } from '../../src/experiment/evidence-types.js'
import { inspectExperiment, verifyExperiment } from '../../src/experiment/analysis.js'
import { decodeExperimentEvidence } from '../../src/experiment/evidence-codec.js'
import { experimentDefinition } from './definition-fixture.js'
import { runnableWorkflowConfig } from '../workflow/host-fixture.js'
import { workspaceWorkflowHost } from '../workflow/workspace-fixture.js'
import { delegatedWorkflowHost } from '../workflow/subagent-fixture.js'

const roots: string[] = []
const fixtureSourceSha256 = createHash('sha256').update(await readFile(new URL(import.meta.url))).digest('hex')
async function directory() { const root = await mkdtemp(join(tmpdir(), 'experiment-composition-')); roots.push(root); return root }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function workflowConfiguration(root: string, resolved: ResolvedHostSpec): JsonObject {
  if (resolved.schemaVersion !== 3) throw new Error('Workflow fixture requires Host v3')
  const base = runnableWorkflowConfig(root)
  return { ...base, subagents: resolved.subagents as unknown as JsonObject,
    workspaceResources: resolved.workspaceResources as unknown as readonly JsonObject[],
    workflows: resolved.workflows as unknown as JsonObject,
    communication: resolved.communication as unknown as JsonObject,
    scheduling: resolved.scheduling as unknown as JsonObject,
    members: (base.members as readonly JsonObject[]).map(member => {
      const configured = resolved.members.find(item => item.agentKey === member.agentKey)!
      if (configured.kind !== 'local' || configured.spec.protocolVersion !== 3) throw new Error('Workflow member fixture')
      return { ...member, workflowTools: configured.workflowTools as unknown as JsonObject, model: configured.model,
        spec: { ...(member.spec as JsonObject), budget: configured.spec.budget,
          nativeActions: configured.spec.nativeActions, workflow: configured.spec.workflow } }
    }) }
}

function* action(name: string, args: JsonObject): Generator<ModelFrame> {
  yield { kind: 'block-start', index: 0, block: 'tool-call', callId: name, name }
  yield { kind: 'arguments-delta', index: 0, text: JSON.stringify(args) }
  yield { kind: 'block-end', index: 0 }
  yield { kind: 'complete', stopReason: 'tool-calls' }
}
function* final(text: string): Generator<ModelFrame> {
  yield { kind: 'block-start', index: 0, block: 'text' }
  yield { kind: 'text-delta', index: 0, text }
  yield { kind: 'block-end', index: 0 }
  yield { kind: 'complete', stopReason: 'stop' }
}

describe('experiment real workspace and delegation composition', () => {
  it('copies declared materials, executes native read/write tools, and retains authenticated output after workspace edits', async () => {
    const root = await directory(), base = experimentDefinition(root)
    const variant = (base.variants as readonly JsonObject[])[0]!
    const sourcePath = 'out/attempt-1/source.txt', outputPath = 'out/attempt-1/result.txt'
    const written = 'verified 文件\n'
    const configured = workflowConfiguration(`${root}/template`, workspaceWorkflowHost(`${root}/template`, `${root}/template-workspace`))
    const tools = ['read_text', 'write_text']
    const grant = { models: 3, steps: 3, tools: 2, messages: 0, waits: 0, outputTokens: 768 }
    const workflow = configured.workflows as JsonObject
    const record = (workflow.definitions as readonly JsonObject[])[0]!
    const definition = record.definition as JsonObject
    const recipe = { ...configured,
      members: (configured.members as readonly JsonObject[]).map(member => member.agentKey !== 'writer' ? member : { ...member,
        spec: { ...(member.spec as JsonObject), budget: grant,
          workflow: { ...((member.spec as JsonObject).workflow as JsonObject), toolNames: tools } } }),
      workspaceResources: (configured.workspaceResources as readonly JsonObject[]).map(resource => ({ ...resource, readPrefixes: ['out'] })),
      workflows: { ...workflow, definitions: [{ ...record, definition: { ...definition,
        budget: { ...(definition.budget as JsonObject), models: 5, steps: 5, tools: 2, outputTokens: 1280 }, requiredOutputs: ['read', 'write'],
        roster: (definition.roster as readonly JsonObject[]).map(member => member.memberKey === 'writer' ? { ...member, budgetCeiling: grant } : member),
        nodes: (definition.nodes as readonly JsonObject[]).map(node => node.nodeKey !== 'read' ? node : { ...node,
          attempts: (node.attempts as readonly JsonObject[]).map(attempt => ({ ...attempt, workerGrant: grant, toolNames: tools,
            workspace: { ...(attempt.workspace as JsonObject), readFiles: [sourcePath] } })) }) } }] } }
    const plan = await planExperiment({ ...base, comparisons: [], repetitions: 1,
      runPolicy: { ...(base.runPolicy as JsonObject), maxWallTimeMs: 60_000 },
      evaluators: [{ evaluatorKey: 'exact', version: '1', implementationVersion: 'rules/v1',
        rules: [{ ruleKey: 'written-output', kind: 'text-exact', normalize: [], expected: written }] }],
      variants: [{ ...variant, recipe, fixture: { kind: 'programmatic', fixtureKey: 'native-files', version: '1', sourceSha256: fixtureSourceSha256 },
        bindings: [{ kind: 'workflow', caseKey: 'question', inputMode: 'workspace', workflowKey: 'research', durationMs: 60_000,
          materials: [{ logicalPath: 'notes.txt', resourceId: 'files', relativePath: sourcePath }], nodeTasks: [{ nodeKey: 'read', prefix: '' }],
          output: { kind: 'workflow-artifact', nodeKey: 'read', artifactName: 'written' } }] }] })
    let writerCalls = 0
    const bindings: HostRuntimeBindings = { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* (submission): AsyncGenerator<ModelFrame> {
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'native-files' }
        if (member.agentKey !== 'writer') { yield* final('final report'); return }
        writerCalls++
        expect(submission.request.tools.map(tool => tool.name)).toEqual(tools)
        if (writerCalls === 1) {
          expect(JSON.stringify(submission.request)).toContain(sourcePath)
          expect(JSON.stringify(submission.request)).not.toContain('The answer is 42.')
          yield* action('read_text', { path: sourcePath })
        } else if (writerCalls === 2) {
          expect(JSON.stringify(submission.request)).toContain('The answer is 42.')
          yield* action('write_text', { path: outputPath, text: written })
        } else { yield* final('{"text":"accepted upstream"}') }
      } }) }
    const result = await runExperiment(plan, { fixtureBindings: { 'native-files': bindings } })
    expect({ disposition: result.units[0]!.sealed?.payload, writerCalls }).toMatchObject({ disposition: { outcome: 'completed' }, writerCalls: 3 })
    const unit = plan.units[0]!, workspace = join(unit.workspaceRoot, 'resources/files')
    expect(await readFile(join(workspace, sourcePath), 'utf8')).toBe(plan.dataset.cases[0]!.materials[0]!.text)
    expect(await readFile(join(workspace, outputPath), 'utf8')).toBe(written)
    const evidencePath = join(plan.storage.controlRoot, `runs/${unit.unitKey}/evidence.json`)
    const sealedBytes = await readFile(evidencePath)
    const evidence = decodeExperimentEvidence(JSON.parse(sealedBytes.toString('utf8')), plan.evidenceLimits)
    expect(evidence.output).toMatchObject({ status: 'available', text: written })
    expect(evidence.metrics.counts['tool.started'].value).toBe(2)
    expect(evidence.metrics.counts['tool.executionObserved'].value).toBe(2)
    expect(evidence.metrics.counts['model.started'].value).toBe(4)
    expect(evidence.metrics.counts['workflow.accepted'].value).toBe(2)
    expect(evidence.metrics.counts['workflow.closed'].value).toBe(1)
    expect(evidence.coverage.complete).toBe(true)
    const before = await inspectExperiment(plan.storage.controlRoot)
    expect(before.state!.evaluations[0]!.payload.result.overall).toBe('pass')
    const history = await collectExperimentEvidence({ recipe: unit.recipe, limits: plan.evidenceLimits, scope: 'historical-local/v1', mode: 'historical' })
    const writer = history.snapshots.find(snapshot => projectToolSession(snapshot).invocations.some(tool => tool.requested.payload.name === 'write_text'))!
    const agent = projectAgentSession(writer), input = agent.inputs.find(input => input.work?.value.nodeKey === 'read')!
    expect(input.reference.kind).toBe('workflow')
    const workRoot = experimentAgentRoot(writer, input.reference.eventId)!
    expect(workRoot).toMatchObject({ outcome: 'completed', source: { kind: 'workflow', assignment: input.work!.assignment } })
    const target: ExperimentEvidenceTarget = { kind: 'agent', sessionId: writer.header.sessionId, inputEventId: input.reference.eventId,
      selector: { kind: 'write-text', path: outputPath }, mediaType: 'text/plain' }
    const readHistory = () => collectExperimentEvidence({ recipe: unit.recipe, limits: plan.evidenceLimits,
      scope: 'historical-local/v1', mode: 'historical', target })
    const original = (await readHistory()).evidence.output
    expect(original).toMatchObject({ status: 'available', text: written, sha256: createHash('sha256').update(written).digest('hex') })
    const observed = await selectExperimentOutput(history.snapshots, target, workspace, plan.evidenceLimits.maxEvidenceBytes)
    expect(observed).toMatchObject({ workspaceObservation: { path: outputPath, sha256: createHash('sha256').update(written).digest('hex') } })
    await writeFile(join(workspace, outputPath), 'external edit')
    expect((await readHistory()).evidence.output).toEqual(original)
    const changed = await selectExperimentOutput(history.snapshots, target, workspace, plan.evidenceLimits.maxEvidenceBytes)
    expect(changed).toMatchObject({ status: 'available', text: written,
      workspaceObservation: { path: outputPath, sha256: createHash('sha256').update('external edit').digest('hex') } })
    expect(await selectExperimentOutput(history.snapshots, { ...target, inputEventId: input.work!.assignment.eventId }, workspace, plan.evidenceLimits.maxEvidenceBytes))
      .toMatchObject({ status: 'unavailable', reason: 'root-not-completed' })
    const tool = projectToolSession(writer).invocations.find(tool => tool.requested.payload.name === 'write_text')!
    const terminal = agent.turns.filter(turn => turn.root === workRoot.id).at(-1)!.settled!
    const local = writer.history.at(-1)!, prefix = local.events.slice(0, terminal.stored.sequence)
    if (tool.state !== 'settled' || tool.settled.payload.result.kind !== 'success') throw new Error('successful native write fixture')
    expect(original.sources).toEqual([{ address: writer.address, eventId: tool.requested.stored.eventId }, { address: writer.address, eventId: tool.settled.stored.eventId }])
    for (const corrupted of [{ byteLength: Buffer.byteLength(written) + 1 }, { sha256: '0'.repeat(64) }]) {
      const payload = snapshotJson({ ...tool.settled.payload, result: { kind: 'success', value: { ...(tool.settled.payload.result.value as JsonObject), ...corrupted } } })
      const events = Object.freeze(prefix.map(event => event.stored.eventId !== tool.settled.stored.eventId ? event
        : Object.freeze({ ...tool.settled, payload, stored: Object.freeze({ ...tool.settled.stored, payload }) })))
      const altered = freezeSessionSnapshot([...writer.history.slice(0, -1), Object.freeze({ ...local, localLifecycle: 'active',
        through: sessionLogPosition(events.length), events })])
      expect(await selectExperimentOutput([altered], target, workspace, plan.evidenceLimits.maxEvidenceBytes))
        .toMatchObject({ status: 'unavailable', reason: 'source-mismatch' })
    }
    expect((await verifyExperiment(plan.storage.controlRoot)).complete).toBe(true)
    expect(await readFile(evidencePath)).toEqual(sealedBytes)
    expect((await inspectExperiment(plan.storage.controlRoot)).state!.evaluations).toEqual(before.state!.evaluations)
  }, 90_000)

  it('runs a private Child inside Workflow work and counts its execution once across the complete unit', async () => {
    const root = await directory(), base = experimentDefinition(root)
    const variant = (base.variants as readonly JsonObject[])[0]!
    const recipe = workflowConfiguration(`${root}/template`, await delegatedWorkflowHost(`${root}/template`))
    const plan = await planExperiment({ ...base, comparisons: [], repetitions: 1,
      runPolicy: { ...(base.runPolicy as JsonObject), maxWallTimeMs: 60_000 },
      evaluators: [{ evaluatorKey: 'exact', version: '1', implementationVersion: 'rules/v1',
        rules: [{ ruleKey: 'report', kind: 'text-exact', normalize: [], expected: 'final accepted report' }] }],
      variants: [{ ...variant, recipe, fixture: { kind: 'programmatic', fixtureKey: 'private-child', version: '1', sourceSha256: fixtureSourceSha256 },
        bindings: [{ kind: 'workflow', caseKey: 'question', inputMode: 'inline', materials: [], workflowKey: 'research', durationMs: 60_000,
          nodeTasks: [{ nodeKey: 'read', prefix: 'Research: ' }], output: { kind: 'workflow-artifact', nodeKey: 'write', artifactName: 'report' } }] }] })
    let parentCalls = 0, childCalls = 0, reviewerCalls = 0
    const bindings: HostRuntimeBindings = { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* (submission): AsyncGenerator<ModelFrame> {
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'private-child' }
        if (member.agentKey === 'writer') {
          parentCalls++
          if (parentCalls === 1) { yield* action('agent_spawn_subagent', { templateKey: 'research', templateVersion: 1,
            task: 'Check the supplied evidence', materials: [{ label: 'evidence', text: 'local source' }],
            requestedBudget: { models: 2, steps: 2, tools: 0, messages: 4, waits: 2, outputTokens: 512 }, workspace: { kind: 'none' } }); return }
          expect(JSON.stringify(submission.request)).toContain('private child evidence')
          yield* final('{"text":"integrated evidence"}')
        } else if (member.agentKey === 'reviewer') {
          reviewerCalls++
          expect(JSON.stringify(submission.request)).toContain('integrated evidence')
          yield* final('final accepted report')
        } else { childCalls++; yield* final('private child evidence') }
      } }) }
    const result = await runExperiment(plan, { fixtureBindings: { 'private-child': bindings } })
    expect({ disposition: result.units[0]!.sealed?.payload, parentCalls, childCalls, reviewerCalls })
      .toMatchObject({ disposition: { outcome: 'completed' }, parentCalls: 2, childCalls: 1, reviewerCalls: 1 })
    const unit = plan.units[0]!
    const evidence = decodeExperimentEvidence(JSON.parse(await readFile(join(plan.storage.controlRoot, `runs/${unit.unitKey}/evidence.json`), 'utf8')), plan.evidenceLimits)
    expect(evidence.output).toMatchObject({ status: 'available', text: 'final accepted report' })
    expect(evidence.sessions).toHaveLength(4)
    expect(evidence.metrics.counts['session.selected'].value).toBe(4)
    expect(evidence.metrics.counts['model.started'].value).toBe(4)
    expect(evidence.metrics.counts['agent.roots'].value).toBe(3)
    expect(evidence.metrics.counts['subagent.accepted'].value).toBe(1)
    expect(evidence.metrics.counts['subagent.adopted'].value).toBe(1)
    expect(evidence.metrics.counts['subagent.closed'].value).toBe(1)
    expect(evidence.metrics.counts['workflow.accepted'].value).toBe(2)
    expect(evidence.metrics.counts['workflow.closed'].value).toBe(1)
    expect(evidence.coverage.complete).toBe(true)
    expect(evidence.metrics.coverage.complete).toBe(true)
    expect((await verifyExperiment(plan.storage.controlRoot)).complete).toBe(true)
  }, 90_000)

  it('reads its own ordinary Agent workspace and answers from authenticated Tool feedback without exposing the expected answer', async () => {
    const root = await directory(), base = experimentDefinition(root), expected = 'THE ANSWER IS 42.'
    const variant = (base.variants as readonly JsonObject[])[0]!, recipe = variant.recipe as JsonObject
    const original = (recipe.members as readonly JsonObject[])[0]!
    const schemaLimits = { maxSchemaBytes: 8192, maxSchemaDepth: 24, maxSchemaNodes: 1000 }
    const tools = { kind: 'workspace-read-text', rootId: 'research-materials', rootPath: `${root}/template-workspace`, protectedRoots: [],
      maxReadBytes: 4096, maxPathBytes: 1024, maxArgumentsBytes: 4096, maxResultBytes: 8192, schemaLimits,
      invocationLimits: { ...schemaLimits, maxRequestBytes: 65536, maxPlanBytes: 65536, maxArgumentsBytes: 4096,
        maxJsonDepth: 24, maxJsonNodes: 10000, maxResultBytes: 8192, maxJournalConflicts: 4 },
      policy: { policyId: 'research-material-policy', version: 1, decision: 'allow', reasonCode: 'configured-research-read' } }
    const plan = await planExperiment({ ...base, comparisons: [], repetitions: 1,
      evaluators: [{ evaluatorKey: 'exact', version: '1', implementationVersion: 'rules/v1',
        rules: [{ ruleKey: 'uppercase-material', kind: 'text-exact', normalize: [], expected }] }],
      variants: [{ ...variant, fixture: { kind: 'programmatic', fixtureKey: 'ordinary-reader', version: '1', sourceSha256: fixtureSourceSha256 },
        recipe: { ...recipe, members: [{ ...original, tools,
          profile: { ...(original.profile as JsonObject), toolNames: ['read_text'] },
          spec: { ...(original.spec as JsonObject), toolNames: ['read_text'],
            budget: { models: 2, steps: 2, tools: 1, messages: 0, waits: 0, outputTokens: 512 } },
          model: { ...(original.model as JsonObject), runnerLimits: { ...((original.model as JsonObject).runnerLimits as JsonObject), maxToolCalls: 1 } } }] },
        bindings: [{ kind: 'agent', caseKey: 'question', agentKey: 'writer', inputMode: 'workspace',
          materials: [{ logicalPath: 'notes.txt', resourceId: null, relativePath: 'in/notes.txt' }], output: { kind: 'root-final' } }] }] })
    const requests: ModelRequest[] = []
    const bindings: HostRuntimeBindings = { createModelProvider: member => new ScriptedModelProvider({ ...member.model,
      script: async function* (submission): AsyncGenerator<ModelFrame> {
        requests.push(submission.request)
        yield { kind: 'message-start', reportedModel: member.spec.target.model, responseId: 'ordinary-reader' }
        if (requests.length === 1) { yield* action('read_text', { path: 'in/notes.txt' }); return }
        const feedback = submission.request.messages.filter(message => message.role === 'user')
          .flatMap(message => message.content).find(block => block.kind === 'tool-result')!
        if (feedback.kind !== 'tool-result') throw new Error('reader fixture requires Tool feedback')
        const result = feedback.result as JsonObject
        expect(result.status).toBe('succeeded')
        const material = (result.value as JsonObject).text as string
        yield* final(material.trim().toUpperCase())
      } }) }
    const result = await runExperiment(plan, { fixtureBindings: { 'ordinary-reader': bindings } })
    expect(result.units[0]!.sealed?.payload.outcome).toBe('completed')
    expect(requests).toHaveLength(2)
    expect(requests[0]!.tools.map(tool => tool.name)).toEqual(['read_text'])
    expect(JSON.stringify(requests[0])).toContain('notes.txt -> in/notes.txt')
    expect(JSON.stringify(requests[0])).not.toContain('The answer is 42.')
    expect(JSON.stringify(requests[1])).toContain('The answer is 42.')
    for (const request of requests) expect(JSON.stringify(request)).not.toContain(expected)
    const unit = plan.units[0]!, material = plan.dataset.cases[0]!.materials[0]!
    expect(await readFile(join(unit.workspaceRoot, 'agents/writer/in/notes.txt'), 'utf8')).toBe(material.text)
    const evidence = decodeExperimentEvidence(JSON.parse(await readFile(join(plan.storage.controlRoot, `runs/${unit.unitKey}/evidence.json`), 'utf8')), plan.evidenceLimits)
    expect(evidence.output).toMatchObject({ status: 'available', text: expected })
    expect(evidence.metrics.counts['model.started'].value).toBe(2)
    expect(evidence.metrics.counts['tool.allowed'].value).toBe(1)
    expect(evidence.metrics.counts['tool.executionObserved'].value).toBe(1)
    expect(evidence.metrics.counts['agent.rootsCompleted'].value).toBe(1)
    expect(evidence.metrics.counts['workflow.closed'].value).toBe(0)
    expect(evidence.metrics.counts['subagent.accepted'].value).toBe(0)
    const collected = await collectExperimentEvidence({ recipe: unit.recipe, limits: plan.evidenceLimits,
      scope: 'unit-local/v1', mode: 'fixture', target: evidence.target! })
    expect(collected.snapshots).toHaveLength(1)
    const snapshot = collected.snapshots[0]!, model = projectModelSession(snapshot), tool = projectToolSession(snapshot).invocations[0]!
    if (tool.state !== 'settled' || model.invocations[0]!.state !== 'settled' || model.invocations[1]!.state !== 'settled') throw new Error('settled reader fixture')
    expect(tool.requested.payload.source).toMatchObject({ kind: 'model', intent: { invocationId: model.invocations[0]!.invocationId, outputBlockIndex: 0 },
      preparedEventId: model.invocations[0]!.prepared.stored.eventId, settledEventId: model.invocations[0]!.settled.stored.eventId })
    expect(tool.authorization!.payload).toMatchObject({ requestedEventId: tool.requested.stored.eventId,
      policy: { policyId: 'research-material-policy', version: 1 }, decision: { kind: 'allow', reasonCode: 'configured-research-read' },
      plan: { target: { kind: 'workspace-file', rootId: 'research-materials', path: 'in/notes.txt' } } })
    expect(tool.started!.payload.authorizationEventId).toBe(tool.authorization!.stored.eventId)
    expect(tool.settled.payload).toMatchObject({ outcome: 'succeeded', execution: 'execution-observed',
      result: { kind: 'success', value: { text: material.text, sha256: material.sha256, byteLength: material.byteLength } } })
    expect(evidence.metrics.counts['tool.allowed'].basis.evidenceRefs).toEqual([{ address: snapshot.address, eventId: tool.authorization!.stored.eventId }])
    expect(evidence.metrics.counts['tool.executionObserved'].basis.evidenceRefs).toEqual([{ address: snapshot.address, eventId: tool.settled.stored.eventId }])
    expect(evidence.output.sources).toContainEqual({ address: snapshot.address, eventId: model.invocations[1]!.settled.stored.eventId })
    expect((await inspectExperiment(plan.storage.controlRoot)).state!.evaluations[0]!.payload.result.overall).toBe('pass')
    expect((await verifyExperiment(plan.storage.controlRoot)).complete).toBe(true)
  }, 90_000)
})
