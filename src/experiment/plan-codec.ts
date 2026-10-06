import { isAbsolute, join } from 'node:path'
import { boundedJson, parseBoundedJson } from '../schema/bounded-json.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonValue } from '../foundation/json.js'
import { snapshotJson } from '../foundation/json.js'
import { formatSessionAddress, parseSessionId } from '../session/ids.js'
import { decodeHostConfig, resolveHostConfig } from '../host/config.js'
import { exportHostConfig } from '../host/config-export.js'
import { decodeExperimentDefinition } from './definition.js'
import type { ExperimentPlan } from './definition-types.js'
import { experimentArray as array, experimentKeys as exact, experimentObject as object, experimentJsonDigest,
  experimentBytesDigest, experimentInteger as integer, experimentDigest as digest, experimentText as text, invalidExperiment as invalid } from './parsing.js'

/** Decode the frozen durable plan without reopening material sources or allocating identities. */
export function decodeExperimentPlan(value: unknown): ExperimentPlan {
  const data = boundedJson(value, { maxBytes: 64 * 1024 * 1024, maxDepth: 64, maxNodes: 1_000_000 })
  const item = object(data, 'plan')
  exact(item, ['version', 'experimentKey', 'dataset', 'variants', 'comparisons', 'repetitions', 'order', 'evaluators', 'runPolicy', 'storage',
    'evidenceLimits', 'provenance', 'experimentId', 'journalSessionId', 'units', 'planDigest'], 'plan')
  const journalId = parseSessionId(text(item.journalSessionId, 'journalSessionId', 36))
  if (item.experimentId !== formatSessionAddress(journalId)) invalid('plan-experimentId')
  const dataset = object(item.dataset, 'plan-dataset'); exact(dataset, ['datasetKey', 'version', 'cases', 'datasetDigest'], 'plan-dataset')
  const cases = array(dataset.cases, 'plan-cases').map(value => {
    const entry = object(value, 'frozen-case'); exact(entry, ['caseKey', 'task', 'materials', 'output', 'primaryEvaluatorKey', 'caseDigest', 'evaluatorDigest'], 'frozen-case')
    const materials = array(entry.materials, 'frozen-materials').map(value => {
      const material = object(value, 'frozen-material'); exact(material, ['logicalPath', 'mediaType', 'text', 'byteLength', 'sha256'], 'frozen-material')
      const materialText = text(material.text, 'frozen-text', 64 * 1024 * 1024, true)
      const bytes = Buffer.from(materialText)
      if (bytes.toString('utf8') !== materialText) invalid('frozen-material-utf8')
      if (bytes.byteLength !== material.byteLength || experimentBytesDigest(bytes) !== material.sha256) invalid('frozen-material-bytes')
      if (material.mediaType === 'application/json') parseBoundedJson(materialText, { maxBytes: bytes.length, maxDepth: 64, maxNodes: 200_000 })
      // External Definition validation consumes material metadata; authenticated frozen bytes remain in this Plan.
      return { logicalPath: material.logicalPath, mediaType: material.mediaType, source: { kind: 'inline', text: '' }, expectedSha256: material.sha256 }
    })
    const { caseDigest: expected, ...unsigned } = entry
    if (experimentJsonDigest(unsigned as JsonValue) !== expected) invalid('case-digest')
    return { caseKey: entry.caseKey, task: entry.task, materials, output: entry.output, primaryEvaluatorKey: entry.primaryEvaluatorKey }
  })
  const { experimentId: _id, journalSessionId: _session, units: rawUnits, planDigest: expectedDigest, ...base } = item
  const storage = object(item.storage, 'storage')
  if (!isAbsolute(text(storage.controlRoot, 'controlRoot')) || !isAbsolute(text(storage.workspaceRoot, 'workspaceRoot'))) invalid('plan-root-absolute')
  const definition = decodeExperimentDefinition({ ...base, dataset: { datasetKey: dataset.datasetKey, version: dataset.version, cases } }, text(storage.controlRoot, 'controlRoot'))
  for (const frozen of dataset.cases as readonly Record<string, JsonValue>[]) {
    const evaluator = definition.evaluators.find(entry => entry.evaluatorKey === frozen.primaryEvaluatorKey)!
    if (experimentJsonDigest(evaluator as unknown as JsonValue) !== frozen.evaluatorDigest) invalid('case-evaluator-digest')
  }
  const { datasetDigest: expectedDatasetDigest, ...datasetContent } = dataset
  if (experimentJsonDigest(datasetContent as JsonValue) !== expectedDatasetDigest) invalid('dataset-digest')
  const units = array(rawUnits, 'units', definition.evidenceLimits.maxUnits)
  if (units.length !== definition.dataset.cases.length * definition.variants.length * definition.repetitions) invalid('unit-matrix-incomplete')
  const expectedTuples = definition.dataset.cases.flatMap(item => Array.from({ length: definition.repetitions }, (_, index) => {
    const repetition = index + 1
    const variants = definition.order === 'alternating-pairs' && repetition % 2 === 0 ? [...definition.variants].reverse() : definition.variants
    return variants.map(variant => ({ caseKey: item.caseKey, variantKey: variant.variantKey, repetition }))
  }).flat())
  const sessionIds = new Set<string>([journalId])
  for (const [index, value] of units.entries()) {
    const unit = object(value, 'unit')
    exact(unit, ['unitKey', 'caseKey', 'variantKey', 'repetition', 'ordinal', 'hostRoot', 'workspaceRoot', 'config', 'recipe', 'recipeDigest', 'comparisonFingerprint', 'entry'], 'unit')
    integer(unit.repetition, 'unit-repetition'); integer(unit.ordinal, 'unit-ordinal')
    const tuple = expectedTuples[index]
    if (tuple === undefined || unit.ordinal !== index + 1 || tuple.caseKey !== unit.caseKey || tuple.variantKey !== unit.variantKey
      || tuple.repetition !== unit.repetition) invalid('unit-matrix-order')
    const unitKey = `unit-${experimentJsonDigest(tuple).slice(0, 32)}`
    if (unit.unitKey !== unitKey || unit.hostRoot !== join(definition.storage.controlRoot, 'runs', unitKey, 'host-store')
      || unit.workspaceRoot !== join(definition.storage.workspaceRoot, journalId, unitKey)) invalid('unit-allocation')
    const binding = definition.variants.find(variant => variant.variantKey === unit.variantKey)!.bindings.find(binding => binding.caseKey === unit.caseKey)!
    if (experimentJsonDigest(binding as unknown as JsonValue) !== experimentJsonDigest(unit.entry as JsonValue)) invalid('unit-binding')
    const config = decodeHostConfig(unit.config, text(unit.hostRoot, 'hostRoot'))
    const resolved = resolveHostConfig(config)
    if (experimentJsonDigest(resolved as unknown as JsonValue) !== digest(unit.recipeDigest, 'recipeDigest')
      || !Buffer.from(canonicalJsonBytes(resolved as unknown as JsonValue)).equals(Buffer.from(canonicalJsonBytes(unit.recipe as JsonValue)))) invalid('unit-recipe-digest')
    if (resolved.storage.root !== unit.hostRoot || exportHostConfig(resolved).fingerprint !== unit.comparisonFingerprint) invalid('unit-recipe-location-or-comparison')
    const identities = [...resolved.members.map(member => member.sessionId), ...(resolved.schemaVersion === 3 && resolved.workflows.kind === 'enabled'
      ? resolved.workflows.definitions.map(workflow => workflow.sessionId) : [])]
    for (const id of identities) {
      if (sessionIds.has(id)) invalid('unit-session-reused')
      sessionIds.add(id)
    }
  }
  const { planDigest: _digest, ...unsigned } = item
  if (experimentJsonDigest(unsigned as JsonValue) !== digest(expectedDigest, 'planDigest')) invalid('plan-digest')
  if (canonicalJsonBytes(data).byteLength > definition.evidenceLimits.maxPlanBytes) invalid('plan-bytes-limit')
  return snapshotJson(item) as unknown as ExperimentPlan
}
