import { isAbsolute, join } from 'node:path'
import { boundedJson, parseBoundedJson } from '../schema/bounded-json.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import type { JsonValue } from '../foundation/json.js'
import { snapshotJson } from '../foundation/json.js'
import { formatSessionAddress, parseSessionId } from '../session/ids.js'
import { parseChannelId } from '../communication/ids.js'
import { decodeHostConfig, resolveHostConfig } from '../host/config.js'
import { exportHostConfig } from '../host/config-export.js'
import { decodeExperimentDefinition } from './definition.js'
import type { ExperimentPlan, FrozenExperimentCase } from './definition-types.js'
import { relocateExperimentRecipe } from './recipe-relocation.js'
import { experimentPathsOverlap } from './materials.js'
import { experimentArray as array, experimentKeys as exact, experimentObject as object, experimentJsonDigest, experimentPlanJsonLimits,
  experimentBytesDigest, experimentInteger as integer, experimentDigest as digest, experimentText as text, invalidExperiment as invalid } from './parsing.js'

/** Decode the frozen durable plan without reopening material sources or allocating identities. */
export function decodeExperimentPlan(value: unknown): ExperimentPlan {
  const data = boundedJson(value, experimentPlanJsonLimits)
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
  if (experimentPathsOverlap(definition.storage.controlRoot, definition.storage.workspaceRoot)) invalid('experiment-roots-overlap')
  const frozenCases = dataset.cases as unknown as readonly FrozenExperimentCase[]
  const inputBytes = frozenCases.reduce((sum, entry) => sum + Buffer.byteLength(entry.task)
    + entry.materials.reduce((sum, material) => sum + material.byteLength, 0), 0)
  if (inputBytes > definition.evidenceLimits.maxInputBytes) invalid('input-bytes-limit')
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
  const channelIds = new Set<string>()
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
    const variant = definition.variants.find(variant => variant.variantKey === unit.variantKey)!
    const binding = variant.bindings.find(binding => binding.caseKey === unit.caseKey)!
    if (experimentJsonDigest(binding as unknown as JsonValue) !== experimentJsonDigest(unit.entry as JsonValue)) invalid('unit-binding')
    const config = decodeHostConfig(unit.config, text(unit.hostRoot, 'hostRoot'))
    const resolved = resolveHostConfig(config)
    if (experimentJsonDigest(resolved as unknown as JsonValue) !== digest(unit.recipeDigest, 'recipeDigest')
      || !Buffer.from(canonicalJsonBytes(resolved as unknown as JsonValue)).equals(Buffer.from(canonicalJsonBytes(unit.recipe as JsonValue)))) invalid('unit-recipe-digest')
    if (resolved.storage.root !== unit.hostRoot || exportHostConfig(resolved).fingerprint !== unit.comparisonFingerprint) invalid('unit-recipe-location-or-comparison')
    const identities = [...resolved.members.map(member => member.sessionId), ...(resolved.schemaVersion === 3 && resolved.workflows.kind === 'enabled'
      ? resolved.workflows.definitions.map(workflow => workflow.sessionId) : [])]
    let sessionIndex = 0, channelIndex = 0
    const expectedConfig = relocateExperimentRecipe(frozenCases.find(entry => entry.caseKey === unit.caseKey)!, variant,
      { hostRoot: text(unit.hostRoot, 'hostRoot'), workspaceRoot: text(unit.workspaceRoot, 'workspaceRoot'), controlRoot: definition.storage.controlRoot },
      definition.evidenceLimits, {
        nextSessionId: () => {
          const id = identities[sessionIndex++]
          if (id === undefined) invalid('unit-recipe-template')
          return parseSessionId(id)
        },
        nextChannelId: () => {
          const channel = resolved.channels[channelIndex++]
          if (channel === undefined) invalid('unit-recipe-template')
          return parseChannelId(channel.channelId)
        },
      })
    if (experimentJsonDigest(expectedConfig as unknown as JsonValue) !== experimentJsonDigest(config as unknown as JsonValue)) invalid('unit-recipe-template')
    for (const id of identities) {
      if (sessionIds.has(id)) invalid('unit-session-reused')
      sessionIds.add(id)
    }
    for (const channel of resolved.channels) {
      if (channelIds.has(channel.channelId)) invalid('unit-channel-reused')
      channelIds.add(channel.channelId)
    }
  }
  const { planDigest: _digest, ...unsigned } = item
  if (experimentJsonDigest(unsigned as JsonValue) !== digest(expectedDigest, 'planDigest')) invalid('plan-digest')
  if (canonicalJsonBytes(data).byteLength > definition.evidenceLimits.maxPlanBytes) invalid('plan-bytes-limit')
  return snapshotJson(item) as unknown as ExperimentPlan
}
