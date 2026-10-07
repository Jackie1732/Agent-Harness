import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { boundedJson, inspectBoundedJson, JsonBoundaryError, parseBoundedJson } from '../schema/bounded-json.js'
import { snapshotJson } from '../foundation/json.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import { formatSessionAddress, parseSessionId } from '../session/ids.js'
import type { SessionId } from '../session/ids.js'
import { decodeHostConfig } from '../host/config.js'
import type { ExperimentBinding, ExperimentCase, ExperimentDefinition, ExperimentEvaluator, ExperimentLimits, ExperimentMaterial,
  ExperimentPlan, ExperimentRule, ExperimentVariant, FrozenExperimentCase } from './definition-types.js'
import { experimentArray as array, experimentChoice as choice, experimentDigest as digest, experimentInteger as integer,
  experimentKey as key, experimentKeys as exact, experimentObject as object, experimentRelativePath as path,
  experimentText as text, experimentUnique as unique, experimentFilePaths, experimentJsonDigest, experimentPlanJsonLimits, invalidExperiment as invalid } from './parsing.js'
import { freezeExperimentMaterials, canonicalExperimentPath, experimentPathsOverlap } from './materials.js'
import { planExperimentUnit } from './recipe.js'
import { preflightExperimentRecordBudget } from './journal-events.js'
import { ExperimentError } from './errors.js'

const inputLimits = { maxBytes: 16 * 1024 * 1024, maxDepth: 64, maxNodes: 200_000 }
const limitFields = ['maxCases', 'maxVariants', 'maxUnits', 'maxInputBytes', 'maxPlanBytes', 'maxRecipeBytes', 'maxSessionCount',
  'maxEvents', 'maxEvidenceBytes', 'maxMetricSamples', 'maxReportBytes', 'maxFixtureEntries', 'maxFixtureBytes'] as const

/** Decode the closed external definition; relative file references use its owning directory. */
export function decodeExperimentDefinition(value: unknown, baseDirectory: string): ExperimentDefinition {
  const input = object(boundedJson(value, inputLimits), 'definition')
  exact(input, ['version', 'experimentKey', 'dataset', 'variants', 'comparisons', 'repetitions', 'order', 'evaluators', 'runPolicy', 'storage', 'evidenceLimits', 'provenance'], 'definition')
  if (input.version !== 1) invalid('definition-version')
  const rawLimits = object(input.evidenceLimits, 'limits'); exact(rawLimits, limitFields, 'limits')
  const limits = Object.fromEntries(limitFields.map(field => [field, integer(rawLimits[field], field)])) as unknown as ExperimentLimits
  const dataset = object(input.dataset, 'dataset'); exact(dataset, ['datasetKey', 'version', 'cases'], 'dataset')
  const cases = array(dataset.cases, 'cases', limits.maxCases).map(value => decodeCase(value, baseDirectory))
  const variants = array(input.variants, 'variants', limits.maxVariants).map(value => decodeVariant(value, baseDirectory))
  const evaluators = array(input.evaluators, 'evaluators', limits.maxCases * 16).map(decodeEvaluator)
  if (cases.length === 0 || variants.length === 0 || evaluators.length === 0) invalid('empty-experiment')
  unique(cases.map(item => item.caseKey.toLowerCase()), 'case'); unique(variants.map(item => item.variantKey), 'variant'); unique(evaluators.map(item => item.evaluatorKey), 'evaluator')
  for (const item of cases) if (!evaluators.some(evaluator => evaluator.evaluatorKey === item.primaryEvaluatorKey)) invalid('primary-evaluator-reference')
  for (const variant of variants) {
    unique(variant.bindings.map(binding => binding.caseKey), 'binding-case')
    if (variant.bindings.length !== cases.length || variant.bindings.some(binding => !cases.some(item => item.caseKey === binding.caseKey))) invalid('binding-matrix')
    for (const binding of variant.bindings) validateBinding(binding, cases.find(item => item.caseKey === binding.caseKey)!, variant)
  }
  const comparisons = array(input.comparisons, 'comparisons', limits.maxVariants * limits.maxVariants).map(value => {
    const item = object(value, 'comparison'); exact(item, ['comparisonKey', 'variantA', 'variantB'], 'comparison')
    const result = { comparisonKey: key(item.comparisonKey, 'comparisonKey'), variantA: key(item.variantA, 'variantA'), variantB: key(item.variantB, 'variantB') }
    if (result.variantA === result.variantB || [result.variantA, result.variantB].some(value => !variants.some(variant => variant.variantKey === value))) invalid('comparison-reference')
    return result
  })
  unique(comparisons.map(item => item.comparisonKey), 'comparison')
  const policy = object(input.runPolicy, 'runPolicy'); exact(policy, ['mode', 'maxDriveCalls', 'maxWallTimeMs', 'onCaseFailure'], 'runPolicy')
  const runPolicy = { mode: choice(policy.mode, ['fixture', 'live'], 'mode'), maxDriveCalls: integer(policy.maxDriveCalls, 'maxDriveCalls'),
    maxWallTimeMs: integer(policy.maxWallTimeMs, 'maxWallTimeMs', 1, 2_147_483_647), onCaseFailure: choice(policy.onCaseFailure, ['continue', 'stop'], 'onCaseFailure') }
  if (runPolicy.mode === 'fixture' && variants.some(variant => variant.recipe.members.some(member => member.kind === 'remote'
    || member.kind === 'local' && member.model.kind !== 'scripted-fixed') || variant.recipe.routes.some(route => route.origin !== null)
    || variant.recipe.schemaVersion !== 1 && variant.recipe.subagents.kind === 'enabled'
      && variant.recipe.subagents.templates.some(template => template.model.kind !== 'scripted-fixed'))) invalid('fixture-network-provider')
  const storage = object(input.storage, 'storage'); exact(storage, ['controlRoot', 'workspaceRoot', 'maxRecordBytes'], 'storage')
  const repetitions = integer(input.repetitions, 'repetitions')
  if (cases.length * variants.length * repetitions > limits.maxUnits) invalid('unit-matrix-limit')
  const provenance = object(input.provenance, 'provenance') as JsonObject
  return snapshotJson({ version: 1, experimentKey: key(input.experimentKey, 'experimentKey'), dataset: { datasetKey: key(dataset.datasetKey, 'datasetKey'),
    version: text(dataset.version, 'dataset-version', 128), cases }, variants, comparisons, repetitions,
    order: choice(input.order, ['declared', 'alternating-pairs'], 'order'), evaluators, runPolicy,
    storage: { controlRoot: resolve(baseDirectory, text(storage.controlRoot, 'controlRoot')), workspaceRoot: resolve(baseDirectory, text(storage.workspaceRoot, 'workspaceRoot')),
      maxRecordBytes: integer(storage.maxRecordBytes, 'maxRecordBytes', 4096) }, evidenceLimits: limits, provenance }) as unknown as ExperimentDefinition
}

/** Parse finite JSON without creating a directory or opening a Host. */
export function parseExperimentDefinition(source: string, baseDirectory: string): ExperimentDefinition {
  return decodeExperimentDefinition(parseBoundedJson(source, inputLimits), baseDirectory)
}

function decodeCase(value: unknown, baseDirectory: string): ExperimentCase {
  const item = object(value, 'case'); exact(item, ['caseKey', 'task', 'materials', 'output', 'primaryEvaluatorKey'], 'case')
  const output = object(item.output, 'output'); exact(output, ['outputKey', 'mediaType'], 'output')
  const materials = array(item.materials, 'materials').map(value => {
    const material = object(value, 'material'); exact(material, ['logicalPath', 'mediaType', 'source', 'expectedSha256'], 'material')
    const source = object(material.source, 'source')
    const kind = choice(source.kind, ['file', 'inline'], 'source-kind'); exact(source, ['kind', kind === 'file' ? 'path' : 'text'], 'source')
    return { logicalPath: path(material.logicalPath, 'logicalPath'), mediaType: choice(material.mediaType, ['text/plain', 'application/json'], 'mediaType'),
      source: kind === 'file' ? { kind, path: resolve(baseDirectory, text(source.path, 'source-path')) } : { kind, text: text(source.text, 'source-text', inputLimits.maxBytes, true) },
      expectedSha256: material.expectedSha256 === null ? null : digest(material.expectedSha256, 'material-digest') } satisfies ExperimentMaterial
  })
  experimentFilePaths(materials.map(item => item.logicalPath), 'material-path')
  const caseKey = key(item.caseKey, 'caseKey')
  path(caseKey, 'case-directory')
  return { caseKey, task: text(item.task, 'task', inputLimits.maxBytes), materials,
    output: { outputKey: key(output.outputKey, 'outputKey'), mediaType: choice(output.mediaType, ['text/plain', 'application/json'], 'output-mediaType') },
    primaryEvaluatorKey: key(item.primaryEvaluatorKey, 'primaryEvaluatorKey') }
}
function decodeEvaluator(value: unknown): ExperimentEvaluator {
  const item = object(value, 'evaluator'); exact(item, ['evaluatorKey', 'version', 'implementationVersion', 'rules'], 'evaluator')
  if (item.implementationVersion !== 'rules/v1') invalid('evaluator-implementation')
  const rules = array(item.rules, 'rules', 1000).map(value => {
    const rule = object(value, 'rule'); const kind = choice(rule.kind, ['text-exact', 'text-includes-all', 'json-equals', 'json-fields'], 'rule-kind')
    exact(rule, ['ruleKey', 'kind', 'normalize', kind === 'json-fields' ? 'fields' : 'expected'], 'rule')
    const normalize = array(rule.normalize, 'normalize', 2).map(value => choice(value, ['trim', 'lf'], 'normalize'))
    unique(normalize, 'normalize')
    const common = { ruleKey: key(rule.ruleKey, 'ruleKey'), normalize }
    if (kind === 'json-fields') {
      const fields = array(rule.fields, 'fields', 1000).map(value => {
        const field = object(value, 'field'); exact(field, ['path', 'expected'], 'field')
        return { path: array(field.path, 'field-path', 64).map(value => typeof value === 'number' ? integer(value, 'field-index', 0) : text(value, 'field-name', 1024)), expected: snapshotJson(field.expected) }
      })
      if (fields.length === 0) invalid('empty-fields')
      return { ...common, kind, fields } satisfies ExperimentRule
    }
    if (kind === 'text-includes-all') {
      const expected = array(rule.expected, 'expected', 1000).map(value => text(value, 'expected-text', inputLimits.maxBytes))
      if (expected.length === 0) invalid('empty-text-includes')
      return { ...common, kind, expected } satisfies ExperimentRule
    }
    return { ...common, kind, expected: kind === 'text-exact' ? text(rule.expected, 'expected-text', inputLimits.maxBytes, true) : snapshotJson(rule.expected) } as ExperimentRule
  })
  if (rules.length === 0) invalid('empty-rules')
  unique(rules.map(item => item.ruleKey), 'rule')
  return { evaluatorKey: key(item.evaluatorKey, 'evaluatorKey'), version: text(item.version, 'evaluator-version', 128), implementationVersion: 'rules/v1', rules }
}
function decodeVariant(value: unknown, baseDirectory: string): ExperimentVariant {
  const item = object(value, 'variant'); exact(item, ['variantKey', 'recipe', 'bindings', 'factors', 'fixture'], 'variant')
  const recipe = decodeHostConfig(item.recipe, baseDirectory)
  if (recipe.members.some(member => member.kind === 'remote' || member.mode !== 'create') || recipe.https.kind !== 'disabled') invalid('new-local-host-required')
  const fixture = object(item.fixture, 'fixture'); const kind = choice(fixture.kind, ['builtin', 'programmatic'], 'fixture-kind')
  exact(fixture, kind === 'builtin' ? ['kind'] : ['kind', 'fixtureKey', 'version', 'sourceSha256'], 'fixture')
  return { variantKey: key(item.variantKey, 'variantKey'), recipe, bindings: array(item.bindings, 'bindings').map(decodeBinding),
    factors: object(snapshotJson(item.factors), 'factors') as JsonObject,
    fixture: kind === 'builtin' ? { kind } : { kind, fixtureKey: key(fixture.fixtureKey, 'fixtureKey'), version: text(fixture.version, 'fixture-version', 128), sourceSha256: digest(fixture.sourceSha256, 'fixture-source') } }
}
function decodeBinding(value: unknown): ExperimentBinding {
  const item = object(value, 'binding'); const kind = choice(item.kind, ['agent', 'workflow'], 'binding-kind')
  exact(item, ['caseKey', 'kind', 'inputMode', 'materials', 'output', ...(kind === 'agent' ? ['agentKey'] : ['workflowKey', 'durationMs', 'nodeTasks'])], 'binding')
  const materials = array(item.materials, 'binding-materials').map(value => {
    const material = object(value, 'binding-material'); exact(material, ['logicalPath', 'relativePath', 'resourceId'], 'binding-material')
    return { logicalPath: path(material.logicalPath, 'binding-logicalPath'), relativePath: path(material.relativePath, 'binding-relativePath'),
      resourceId: material.resourceId === null ? null : key(material.resourceId, 'binding-resourceId') }
  })
  experimentFilePaths(materials.map(item => `${item.resourceId ?? ''}:${item.relativePath}`), 'binding-path')
  unique(materials.map(item => item.logicalPath), 'binding-logicalPath')
  const common = { caseKey: key(item.caseKey, 'binding-caseKey'), inputMode: choice(item.inputMode, ['inline', 'workspace'], 'binding-inputMode'), materials }
  const output = object(item.output, 'selector')
  if (kind === 'agent') {
    // Ordinary Host Agents expose read_text; write_text belongs to granted Workflow work.
    if (output.kind === 'write-text') invalid('agent-write-text-provider-unavailable')
    const selector = choice(output.kind, ['root-final'], 'agent-selector')
    exact(output, ['kind'], 'selector')
    return { ...common, kind, agentKey: key(item.agentKey, 'agentKey'), output: { kind: selector } }
  }
  if (output.kind !== 'workflow-artifact') invalid('workflow-selector')
  exact(output, ['kind', 'nodeKey', 'artifactName'], 'selector')
  const nodeTasks = array(item.nodeTasks, 'nodeTasks', 256).map(value => {
    const slot = object(value, 'node-task'); exact(slot, ['nodeKey', 'prefix'], 'node-task')
    return { nodeKey: key(slot.nodeKey, 'nodeKey'), prefix: text(slot.prefix, 'task-prefix', inputLimits.maxBytes, true) }
  })
  if (nodeTasks.length === 0) invalid('workflow-task-slots-empty')
  unique(nodeTasks.map(item => item.nodeKey), 'node-task')
  return { ...common, kind, workflowKey: key(item.workflowKey, 'workflowKey'), durationMs: integer(item.durationMs, 'workflow-durationMs', 1, 2_147_483_647), nodeTasks,
    output: { kind: 'workflow-artifact', nodeKey: key(output.nodeKey, 'output-nodeKey'), artifactName: key(output.artifactName, 'artifactName') } }
}
function validateBinding(binding: ExperimentBinding, item: ExperimentCase, variant: ExperimentVariant): void {
  if (binding.materials.some(material => !item.materials.some(input => input.logicalPath === material.logicalPath))) invalid('binding-material-reference')
  if (binding.inputMode === 'inline' ? binding.materials.length !== 0 : binding.materials.length !== item.materials.length) invalid('binding-input-materials')
  const resources = variant.recipe.schemaVersion === 3 ? variant.recipe.workspaceResources : variant.recipe.schemaVersion === 2 && variant.recipe.subagents.kind === 'enabled' ? variant.recipe.subagents.workspaceResources : []
  if (binding.materials.some(material => material.resourceId !== null && !resources.some(resource => resource.resourceId === material.resourceId))) invalid('binding-resource-reference')
  if (binding.kind === 'agent') {
    const member = variant.recipe.members.find(member => member.kind === 'local' && member.agentKey === binding.agentKey && member.enabled)
    if (member?.kind !== 'local') invalid('binding-agent-reference')
    if (binding.materials.some(material => material.resourceId !== null) || binding.materials.length > 0 && (member.tools.kind !== 'workspace-read-text'
      || !member.spec.toolNames.includes('read_text'))) invalid('binding-agent-material-reader')
    return
  }
  if (binding.materials.some(material => material.resourceId === null)) invalid('workflow-material-resource-required')
  const definition = variant.recipe.schemaVersion === 3 && variant.recipe.workflows.kind === 'enabled'
    ? variant.recipe.workflows.definitions.find(entry => entry.definition.workflowKey === binding.workflowKey)?.definition : undefined
  if (definition === undefined) invalid('binding-workflow-reference')
  const nodes = definition.nodes as readonly JsonObject[]
  if (binding.nodeTasks.some(slot => !nodes.some(node => node.nodeKey === slot.nodeKey))
    || !(definition.requiredOutputs as readonly string[]).includes(binding.output.nodeKey)) invalid('binding-workflow-output')
  const selected = object(nodes.find(node => node.nodeKey === binding.output.nodeKey)!.output, 'workflow-selected-output')
  if (selected.kind === 'text' ? selected.name !== binding.output.artifactName
    : !(selected.artifacts as readonly JsonObject[]).some(artifact => artifact.name === binding.output.artifactName)) invalid('binding-workflow-artifact')
  for (const slot of binding.nodeTasks) {
    const node = nodes.find(node => node.nodeKey === slot.nodeKey)!
    const member = variant.recipe.members.find(member => member.kind === 'local' && member.agentKey === node.executor)
    if (member?.kind !== 'local' || !member.enabled) invalid('binding-workflow-executor')
    for (const material of binding.materials) {
      const resource = resources.find(resource => resource.resourceId === material.resourceId)!
      if (!resource.readPrefixes.some(prefix => material.relativePath === prefix || material.relativePath.startsWith(prefix + '/'))
        || member.workflowTools?.kind !== 'workspace' || !member.workflowTools.read || !member.workflowTools.resourceIds.includes(resource.resourceId)
        || member.spec.protocolVersion !== 3 || member.spec.workflow.kind !== 'participant' || !member.spec.workflow.toolNames.includes('read_text')
        || !member.spec.workflow.resourceIds.includes(resource.resourceId)
        || !(node.attempts as readonly JsonObject[]).every(attempt => {
          const workspace = attempt.workspace as JsonObject
          return (attempt.toolNames as readonly string[]).includes('read_text') && workspace.kind !== 'none'
            && workspace.resourceId === resource.resourceId && (workspace.readFiles as readonly string[]).includes(material.relativePath)
        })) invalid('binding-workflow-material-reader')
    }
  }
}

/** Freeze inputs and reserve a complete observation matrix; performs no Host or Provider operation. */
export async function planExperiment(value: unknown, options: { readonly baseDirectory?: string; readonly sessionId?: SessionId } = {}): Promise<ExperimentPlan> {
  const definition = decodeExperimentDefinition(value, options.baseDirectory ?? process.cwd())
  const controlRoot = await canonicalExperimentPath(definition.storage.controlRoot)
  const workspaceRoot = await canonicalExperimentPath(definition.storage.workspaceRoot)
  if (experimentPathsOverlap(controlRoot, workspaceRoot)) invalid('experiment-roots-overlap')
  const storage = { ...definition.storage, controlRoot, workspaceRoot }
  const journalSessionId = options.sessionId === undefined ? parseSessionId(randomUUID()) : parseSessionId(options.sessionId)
  const cases: FrozenExperimentCase[] = []
  let totalInputBytes = 0
  for (const item of definition.dataset.cases) {
    totalInputBytes += Buffer.byteLength(item.task)
    if (totalInputBytes > definition.evidenceLimits.maxInputBytes) throw new ExperimentError('EXPERIMENT_LIMIT_EXCEEDED', 'input-bytes-limit')
    const materials = await freezeExperimentMaterials(item.materials, definition.evidenceLimits.maxInputBytes - totalInputBytes)
    totalInputBytes += materials.reduce((total, material) => total + material.byteLength, 0)
    const evaluator = definition.evaluators.find(entry => entry.evaluatorKey === item.primaryEvaluatorKey)!
    const evaluatorDigest = experimentJsonDigest(evaluator as unknown as JsonValue)
    const content = { ...item, materials, evaluatorDigest }
    const caseDigest = experimentJsonDigest(content as unknown as JsonValue)
    cases.push({ ...content, caseDigest })
  }
  const datasetContent = { datasetKey: definition.dataset.datasetKey, version: definition.dataset.version, cases }
  const dataset = { ...datasetContent, datasetDigest: experimentJsonDigest(datasetContent as unknown as JsonValue) }
  const units = []
  for (const item of cases) for (let repetition = 1; repetition <= definition.repetitions; repetition++) {
    const variants = definition.order === 'alternating-pairs' && repetition % 2 === 0 ? [...definition.variants].reverse() : definition.variants
    for (const variant of variants) units.push(await planExperimentUnit(item, variant, repetition, units.length + 1, journalSessionId, storage, definition.evidenceLimits))
  }
  const unsigned = { ...definition, storage, dataset, journalSessionId, experimentId: formatSessionAddress(journalSessionId), units }
  const plan = snapshotJson({ ...unsigned, planDigest: experimentJsonDigest(unsigned as unknown as JsonValue) }) as unknown as ExperimentPlan
  if (canonicalJsonBytes(plan as unknown as JsonValue).byteLength > definition.evidenceLimits.maxPlanBytes) invalid('plan-bytes-limit')
  try { inspectBoundedJson(plan, experimentPlanJsonLimits) }
  catch (cause) {
    if (!(cause instanceof JsonBoundaryError) || cause.reason === 'invalid') throw cause
    throw new ExperimentError('EXPERIMENT_LIMIT_EXCEEDED', `plan-json-${cause.reason}-limit`)
  }
  preflightExperimentRecordBudget(plan)
  return plan
}
