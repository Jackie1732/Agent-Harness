import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeExperimentDefinition, planExperiment } from '../../src/experiment/definition.js'
import { decodeExperimentPlan } from '../../src/experiment/plan-codec.js'
import { experimentDefinition } from './definition-fixture.js'
import type { JsonObject } from '../../src/foundation/json.js'
import { experimentBytesDigest, experimentJsonDigest } from '../../src/experiment/parsing.js'
import { twoMemberHostConfig } from '../host/fixtures.js'
import { runnableWorkflowConfig } from '../workflow/host-fixture.js'
import { workflowMemberFingerprints } from '../../src/host/workflow-authority.js'
import { renderExperimentTask } from '../../src/experiment/input.js'
import type { JsonValue } from '../../src/foundation/json.js'
import { subagentHostConfig } from '../host/subagent-fixture.js'
import { decodeHostConfig } from '../../src/host/config.js'
import { deepSeekModelDescriptor } from '../../src/model/providers/deepseek.js'

const roots: string[] = []
async function root() { const path = await mkdtemp(join(tmpdir(), 'atomic-experiment-definition-')); roots.push(path); return path }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('frozen experiment planning', () => {
  it('freezes the complete alternating matrix and fresh identities without creating output storage', async () => {
    const path = await root()
    const plan = await planExperiment(experimentDefinition(path), { baseDirectory: path })
    expect(plan.units.map(unit => [unit.variantKey, unit.repetition])).toEqual([['a', 1], ['b', 1], ['b', 2], ['a', 2]])
    expect(new Set(plan.units.flatMap(unit => unit.recipe.members.map(member => member.sessionId))).size).toBe(4)
    expect(new Set(plan.units.map(unit => unit.workspaceRoot)).size).toBe(4)
    expect(plan.units.every(unit => unit.recipe.storage.root === unit.hostRoot)).toBe(true)
    expect(plan.dataset.cases[0]!.materials[0]!.text).toBe('The answer is 42.\r\n')
    expect(Object.isFrozen(plan.dataset.cases[0]!.materials)).toBe(true)
    expect(decodeExperimentPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan)
    await expect(stat(plan.storage.controlRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('input byte changes do not change an already frozen plan and expected hashes are checked', async () => {
    const path = await root()
    const file = join(path, 'input.json'); await writeFile(file, '{"fact":42}\n')
    const base = experimentDefinition(path)
    const dataset = base.dataset as JsonObject
    const first = (dataset.cases as readonly JsonObject[])[0]!
    const expectedSha256 = experimentBytesDigest(await readFile(file))
    const definition = { ...base, dataset: { ...dataset, cases: [{ ...first, materials: [{ logicalPath: 'input.json', mediaType: 'application/json', source: { kind: 'file', path: file }, expectedSha256 }] }] } }
    const plan = await planExperiment(definition)
    await writeFile(file, '{"fact":99}\n')
    expect(plan.dataset.cases[0]!.materials[0]!.text).toBe('{"fact":42}\n')
    await expect(planExperiment(definition)).rejects.toMatchObject({ code: 'EXPERIMENT_CONFLICT' })
  })
  it('rejects closed input violations, unknown evaluator code, ambiguous bindings and unit/byte budgets', async () => {
    const path = await root()
    const base = experimentDefinition(path)
    expect(() => decodeExperimentDefinition({ ...base, extra: true }, path)).toThrow('definition-fields')
    expect(() => decodeExperimentDefinition({ ...base, version: 2 }, path)).toThrow('definition-version')
    expect(() => decodeExperimentDefinition({ ...base, repetitions: 0 }, path)).toThrow('repetitions-integer')
    expect(() => decodeExperimentDefinition({ ...base, repetitions: 100 }, path)).toThrow('unit-matrix-limit')
    expect(() => decodeExperimentDefinition({ ...base, runPolicy: { ...(base.runPolicy as JsonObject), maxWallTimeMs: 2_147_483_648 } }, path)).toThrow('maxWallTimeMs-integer')
    const dataset = base.dataset as JsonObject, item = (dataset.cases as readonly JsonObject[])[0]!
    expect(() => decodeExperimentDefinition({ ...base, dataset: { ...dataset, cases: [{ ...item, caseKey: 'CON' }] } }, path)).toThrow('case-directory-relative-path')
    const variant = (base.variants as readonly JsonObject[])[0]!
    expect(() => decodeExperimentDefinition({ ...base, variants: [{ ...variant, bindings: [] }] }, path)).toThrow('binding-matrix')
    const binding = (variant.bindings as readonly JsonObject[])[0]!
    expect(() => decodeExperimentDefinition({ ...base, comparisons: [], variants: [{ ...variant, bindings: [{ ...binding,
      output: { kind: 'write-text', path: 'answer.txt' } }] }] }, path)).toThrow('agent-write-text-provider-unavailable')
    await expect(planExperiment({ ...base, evidenceLimits: { ...(base.evidenceLimits as JsonObject), maxInputBytes: 1 } })).rejects.toMatchObject({ code: 'EXPERIMENT_LIMIT_EXCEEDED' })
    await expect(planExperiment({ ...base, storage: { ...(base.storage as JsonObject), workspaceRoot: `${path}/control/nested` } })).rejects.toThrow('experiment-roots-overlap')
    await expect(planExperiment({ ...base, storage: { ...(base.storage as JsonObject), maxRecordBytes: 4096 } })).rejects.toThrow('journal-record-budget')
    const evaluator = (base.evaluators as readonly JsonObject[])[0]!
    expect(() => decodeExperimentDefinition({ ...base, evaluators: [{ ...evaluator, implementationVersion: 'arbitrary-code' }] }, path)).toThrow('evaluator-implementation')
  })
  it('rejects invalid UTF-8/JSON and altered frozen-plan contents', async () => {
    const path = await root()
    const file = join(path, 'invalid'); await writeFile(file, Uint8Array.from([0xff]))
    const base = experimentDefinition(path)
    const dataset = base.dataset as JsonObject, item = (dataset.cases as readonly JsonObject[])[0]!
    const input = { ...base, dataset: { ...dataset, cases: [{ ...item, materials: [{ logicalPath: 'input.txt', mediaType: 'text/plain', source: { kind: 'file', path: file }, expectedSha256: null }] }] } }
    await expect(planExperiment(input)).rejects.toThrow('material-utf8')
    await writeFile(file, '{broken')
    await expect(planExperiment({ ...input, dataset: { ...dataset, cases: [{ ...item, materials: [{ logicalPath: 'input.json', mediaType: 'application/json', source: { kind: 'file', path: file }, expectedSha256: null }] }] } })).rejects.toThrow()
    const plan = await planExperiment(base)
    expect(() => decodeExperimentPlan({ ...plan, experimentKey: 'changed' })).toThrow('plan-digest')
  })
  it('reallocates channels and resolved peer addresses while preserving opaque prompt text', async () => {
    const path = await root()
    const base = experimentDefinition(path)
    const variant = (base.variants as readonly JsonObject[])[0]!
    const definition = { ...base, comparisons: [], variants: [{ ...variant, recipe: twoMemberHostConfig(`${path}/template`) }] }
    const plan = await planExperiment(definition)
    const first = plan.units[0]!, second = plan.units[1]!
    expect(first.recipe.channels[0]!.channelId).not.toBe(second.recipe.channels[0]!.channelId)
    const writer = first.recipe.members[0]!
    expect(writer.kind === 'local' && writer.spec.peers[0]!.address).toBe(`ah-session:${first.recipe.members[1]!.sessionId}`)
    expect(plan.dataset.cases[0]!.caseDigest).toBe((await planExperiment({ ...definition, variants: [{ ...variant, variantKey: 'another', recipe: twoMemberHostConfig(`${path}/template`) }] })).dataset.cases[0]!.caseDigest)
  })
  it('requires an explicit input strategy and validates actual input bytes before admission', async () => {
    const path = await root(), base = experimentDefinition(path)
    const variant = (base.variants as readonly JsonObject[])[0]!, binding = (variant.bindings as readonly JsonObject[])[0]!
    const workspace = { ...binding, inputMode: 'workspace', materials: [{ logicalPath: 'notes.txt', relativePath: 'notes.txt', resourceId: null }] }
    expect(() => decodeExperimentDefinition({ ...base, comparisons: [], variants: [{ ...variant, bindings: [{ ...binding, inputMode: 'workspace' }] }] }, path)).toThrow('binding-input-materials')
    expect(() => decodeExperimentDefinition({ ...base, comparisons: [], variants: [{ ...variant, bindings: [workspace] }] }, path)).toThrow('binding-agent-material-reader')
    expect(() => decodeExperimentDefinition({ ...base, comparisons: [], variants: [{ ...variant, bindings: [{ ...workspace, inputMode: 'inline' }] }] }, path)).toThrow('binding-input-materials')
    const recipe = variant.recipe as JsonObject, member = (recipe.members as readonly JsonObject[])[0]!, spec = member.spec as JsonObject
    await expect(planExperiment({ ...base, comparisons: [], variants: [{ ...variant, recipe: { ...recipe, members: [{ ...member,
      spec: { ...spec, limits: { ...(spec.limits as JsonObject), maxInputBytes: 25 } } }] } }] })).rejects.toThrow('rendered-agent-input-limit')
    const plan = await planExperiment(base)
    expect(renderExperimentTask(plan.dataset.cases[0]!, plan.units[0]!.entry)).toContain('Material: notes.txt\nThe answer is 42.\r\n')
  })
  it('binds one common case to a fresh Workflow template with relocated roster and explicit task injection', async () => {
    const path = await root(), base = experimentDefinition(path), variant = (base.variants as readonly JsonObject[])[0]!
    const workflow = { ...variant, variantKey: 'workflow', recipe: runnableWorkflowConfig(`${path}/template`), bindings: [{ caseKey: 'question',
      kind: 'workflow', inputMode: 'inline', workflowKey: 'research', durationMs: 60_000, materials: [], nodeTasks: [{ nodeKey: 'read', prefix: 'Research: ' }],
      output: { kind: 'workflow-artifact', nodeKey: 'write', artifactName: 'report' } }] }
    const plan = await planExperiment({ ...base, variants: [variant, workflow], comparisons: [] })
    const unit = plan.units[1]!
    expect(unit.entry.kind === 'workflow' && unit.entry.durationMs).toBe(60_000)
    if (unit.recipe.schemaVersion !== 3 || unit.recipe.workflows.kind !== 'enabled') throw new Error('Workflow fixture')
    const definition = unit.recipe.workflows.definitions[0]!.definition
    expect(definition.nodes[0]!.task).toBe(`Research: ${renderExperimentTask(plan.dataset.cases[0]!, unit.entry)}`)
    expect(definition.nodes[1]!.task).toBe('Summarize the accepted passage')
    expect(definition.deadline).toBe('2030-01-01T00:00:00.000Z')
    expect(definition.coordinator).toBe(`ah-session:${unit.recipe.workflows.definitions[0]!.sessionId}`)
    for (const peer of definition.roster) {
      const member = unit.recipe.members.find(member => member.kind === 'local' && member.agentKey === peer.memberKey)!
      if (member.kind !== 'local') throw new Error('Local fixture')
      expect(peer.address).toBe(`ah-session:${member.sessionId}`)
      expect(peer).toMatchObject(workflowMemberFingerprints(member))
    }
    expect(decodeExperimentPlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan)
    const binding = workflow.bindings[0]!
    expect(() => decodeExperimentDefinition({ ...base, comparisons: [], variants: [{ ...workflow, bindings: [{ ...binding,
      output: { ...binding.output, artifactName: 'missing' } }] }] }, path)).toThrow('binding-workflow-artifact')
    const tooLarge = { ...workflow, bindings: [{ ...binding, nodeTasks: [{ nodeKey: 'read', prefix: 'x'.repeat(16 * 1024) }] }] }
    await expect(planExperiment({ ...base, comparisons: [], variants: [tooLarge] })).rejects.toThrow()
  })
  it('rejects durable plans whose valid outer digest conceals changed order, input binding or evaluator identity', async () => {
    const path = await root(), plan = await planExperiment(experimentDefinition(path))
    const sign = (value: JsonObject): JsonObject => {
      const { planDigest: _old, ...unsigned } = value
      return { ...unsigned, planDigest: experimentJsonDigest(unsigned) }
    }
    const raw = JSON.parse(JSON.stringify(plan)) as JsonObject, units = raw.units as readonly JsonObject[]
    expect(() => decodeExperimentPlan(sign({ ...raw, units: [units[1]!, units[0]!, ...units.slice(2)].map((unit, index) => ({ ...unit, ordinal: index + 1 })) }))).toThrow('unit-matrix-order')
    expect(() => decodeExperimentPlan(sign({ ...raw, units: [{ ...units[0]!, entry: { ...(units[0]!.entry as JsonObject), inputMode: 'workspace' } }, ...units.slice(1)] }))).toThrow('unit-binding')
    const dataset = raw.dataset as JsonObject, item = (dataset.cases as readonly JsonObject[])[0]!, { caseDigest: _old, ...unsigned } = item
    const changedCase = { ...unsigned, evaluatorDigest: 'f'.repeat(64) }
    const datasetContent = { datasetKey: dataset.datasetKey!, version: dataset.version!, cases: [{ ...changedCase, caseDigest: experimentJsonDigest(changedCase) }] }
    expect(() => decodeExperimentPlan(sign({ ...raw, dataset: { ...datasetContent, datasetDigest: experimentJsonDigest(datasetContent as JsonValue) } }))).toThrow('case-evaluator-digest')
  })
  it('reserves escaped closure reasons in the journal budget before starting any Host', async () => {
    const path = await root(), base = experimentDefinition(path), variant = (base.variants as readonly JsonObject[])[0]!
    await expect(planExperiment({ ...base, repetitions: 1, variants: [variant], comparisons: [],
      storage: { ...(base.storage as JsonObject), maxRecordBytes: 20_000 } })).rejects.toThrow('journal-record-budget')
    await expect(stat(join(path, 'control'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects a cloud child template in fixture mode while allowing the same explicit live recipe', async () => {
    const path = await root(), base = experimentDefinition(path), variant = (base.variants as readonly JsonObject[])[0]!
    const recipe = decodeHostConfig(await subagentHostConfig(join(path, 'template')), path)
    if (recipe.schemaVersion !== 2 || recipe.subagents.kind !== 'enabled') throw new Error('Subagent fixture')
    const template = recipe.subagents.templates[0]!
    if (template.model.kind !== 'scripted-fixed') throw new Error('Scripted fixture')
    const { kind: _kind, text: _text, ...common } = template.model
    const cloud = { ...common, kind: 'deepseek' as const, endpoint: 'https://example.invalid/v1/chat/completions', credentialRef: 'test-key' }
    const configured = { ...base, comparisons: [], variants: [{ ...variant, recipe: { ...recipe, subagents: { ...recipe.subagents, templates: [{ ...template,
      model: cloud, spec: { ...template.spec, target: { ...template.spec.target, provider: deepSeekModelDescriptor(cloud) } } }] } } }] }
    expect(() => decodeExperimentDefinition(configured, path)).toThrow('fixture-network-provider')
    expect(decodeExperimentDefinition({ ...configured, runPolicy: { ...(base.runPolicy as JsonObject), mode: 'live' } }, path).runPolicy.mode).toBe('live')
    await expect(stat(join(path, 'control'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('decodes a file-backed Plan under its own byte budget when frozen bytes exceed external Definition JSON', async () => {
    const path = await root(), base = experimentDefinition(path), source = join(path, 'material.txt')
    await writeFile(source, 'x'.repeat(512 * 1024))
    const dataset = base.dataset as JsonObject, original = (dataset.cases as readonly JsonObject[])[0]!
    const cases = Array.from({ length: 33 }, (_, index) => ({ ...original, caseKey: `case${index}`, materials: [{ logicalPath: 'material.txt',
      mediaType: 'text/plain', source: { kind: 'file', path: source }, expectedSha256: null }] }))
    const variant = (base.variants as readonly JsonObject[])[0]!, binding = (variant.bindings as readonly JsonObject[])[0]!, recipe = variant.recipe as JsonObject
    const member = (recipe.members as readonly JsonObject[])[0]!, spec = member.spec as JsonObject
    const configured = { ...base, dataset: { ...dataset, cases }, variants: [{ ...variant, bindings: cases.map(item => ({ ...binding, caseKey: item.caseKey })),
      recipe: { ...recipe, members: [{ ...member, spec: { ...spec, limits: { ...(spec.limits as JsonObject), maxInputBytes: 600 * 1024 } } }] } }], comparisons: [], repetitions: 1,
    storage: { ...(base.storage as JsonObject), maxRecordBytes: 24 * 1024 * 1024 }, evidenceLimits: { ...(base.evidenceLimits as JsonObject),
      maxCases: 40, maxInputBytes: 20 * 1024 * 1024, maxPlanBytes: 24 * 1024 * 1024 } }
    const plan = await planExperiment(configured)
    expect(plan.dataset.cases.reduce((sum, item) => sum + item.materials[0]!.byteLength, 0)).toBe(33 * 512 * 1024)
    expect(decodeExperimentPlan(JSON.parse(JSON.stringify(plan))).planDigest).toBe(plan.planDigest)
    await expect(stat(plan.storage.controlRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  }, 20_000)
})
