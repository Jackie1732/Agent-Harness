import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import { snapshotJson } from '../foundation/json.js'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { assertNever } from '../foundation/never.js'
import { parseBoundedJson, boundedJson } from '../schema/bounded-json.js'
import { decodeEvidenceEventRef } from './evidence-codec-fields.js'
import type { ExperimentRule } from './definition-types.js'
import type { ExperimentObservedOutput } from './evidence-types.js'
import type { EvaluateExperimentOutputInput, ExperimentEvaluationResult, ExperimentEvaluationStatus, ExperimentRuleResult } from './evaluation-types.js'
import { experimentArray as array, experimentChoice as choice, experimentDigest as digest, experimentKeys as exact,
  experimentObject as object, experimentText as text, experimentUnique as unique, experimentJsonDigest, invalidExperiment as invalid } from './parsing.js'

/** Evaluate authenticated output against fixed rules; does not own Host or Journal access. */
export function evaluateExperimentOutput(input: EvaluateExperimentOutputInput): ExperimentEvaluationResult {
  const rules = input.evaluator.rules.map(rule => {
    const common = { ruleKey: rule.ruleKey, evidenceRefs: input.output.sources }
    if (input.output.status === 'unavailable') return { ...common, status: 'unavailable' as const, reason: 'output-unavailable', details: { sourceReason: input.output.reason } }
    if (input.output.mediaType !== input.case.output.mediaType) return { ...common, status: 'fail' as const, reason: 'media-type', details: {} }
    try { return { ...common, ...evaluateRule(rule, input.output, input.maxJsonBytes) } }
    catch { return { ...common, status: 'error' as const, reason: 'rule-execution-failed', details: {} } }
  })
  const summary = summarize(rules)
  return snapshotJson({ version: 1, unitKey: input.unitKey, outputKey: input.case.output.outputKey, evidenceDigest: input.evidenceDigest,
    evaluatorKey: input.evaluator.evaluatorKey, evaluatorDigest: experimentJsonDigest(input.evaluator as unknown as JsonValue),
    evaluatorVersion: input.evaluator.version, implementationVersion: input.evaluator.implementationVersion, rules, ...summary }) as unknown as ExperimentEvaluationResult
}

/** Decode persisted evaluation metadata and prove its summary agrees with the rule facts. */
export function decodeExperimentEvaluation(value: unknown, maxBytes: number): ExperimentEvaluationResult {
  const input = object(boundedJson(value, { maxBytes, maxDepth: 64, maxNodes: maxBytes }), 'evaluation')
  exact(input, ['version', 'unitKey', 'outputKey', 'evidenceDigest', 'evaluatorKey', 'evaluatorDigest', 'evaluatorVersion', 'implementationVersion',
    'overall', 'rules', 'totalRules', 'knownPassed', 'evaluatedRules', 'coverage', 'score'], 'evaluation')
  if (input.version !== 1 || input.implementationVersion !== 'rules/v1') invalid('evaluation-version')
  const rules = array(input.rules, 'evaluation-rules', 1000).map(value => {
    const item = object(value, 'evaluation-rule'); exact(item, ['ruleKey', 'status', 'reason', 'details', 'evidenceRefs'], 'evaluation-rule')
    return { ruleKey: text(item.ruleKey, 'ruleKey', 128), status: choice(item.status, ['pass', 'fail', 'unavailable', 'error'], 'rule-status'),
      reason: text(item.reason, 'rule-reason', 4096), details: object(item.details, 'rule-details') as JsonObject,
      evidenceRefs: array(item.evidenceRefs, 'rule-refs', maxBytes).map(decodeEvidenceEventRef) }
  })
  if (rules.length === 0) invalid('empty-evaluation-rules')
  unique(rules.map(rule => rule.ruleKey), 'evaluation-rule')
  const summary = summarize(rules)
  for (const field of ['overall', 'totalRules', 'knownPassed', 'evaluatedRules', 'coverage', 'score'] as const) if (input[field] !== summary[field]) invalid('evaluation-summary')
  return snapshotJson({ version: 1, unitKey: text(input.unitKey, 'unitKey', 128), outputKey: text(input.outputKey, 'outputKey', 128),
    evidenceDigest: digest(input.evidenceDigest, 'evidenceDigest'), evaluatorKey: text(input.evaluatorKey, 'evaluatorKey', 128),
    evaluatorDigest: digest(input.evaluatorDigest, 'evaluatorDigest'), evaluatorVersion: text(input.evaluatorVersion, 'evaluatorVersion', 128),
    implementationVersion: 'rules/v1', rules, ...summary }) as unknown as ExperimentEvaluationResult
}

type RuleJudgment = Pick<ExperimentRuleResult, 'status' | 'reason' | 'details'>
const judgment = (pass: boolean, success: string, failure: string, details: JsonObject = {}): RuleJudgment => ({ status: pass ? 'pass' : 'fail', reason: pass ? success : failure, details })

function evaluateRule(rule: ExperimentRule, output: Extract<ExperimentObservedOutput, { status: 'available' }>, maxJsonBytes: number): RuleJudgment {
  let content = output.text
  for (const normalization of rule.normalize) content = normalization === 'trim' ? content.trim() : content.replace(/\r\n?/g, '\n')
  if (rule.kind === 'text-exact') return judgment(content === rule.expected, 'equal', 'different-text')
  if (rule.kind === 'text-includes-all') {
    const matched = rule.expected.filter(expected => content.includes(expected)).length
    return judgment(matched === rule.expected.length, 'all-included', 'missing-includes', { matched, total: rule.expected.length })
  }
  if (output.mediaType !== 'application/json') return judgment(false, 'equal', 'media-type')
  let parsed: JsonValue
  try { parsed = parseBoundedJson(content, { maxBytes: maxJsonBytes, maxDepth: 64, maxNodes: maxJsonBytes }) }
  catch { return judgment(false, 'equal', 'invalid-json') }
  switch (rule.kind) {
    case 'json-equals': return judgment(sameJson(parsed, rule.expected), 'equal', 'different-json')
    case 'json-fields': {
      const matched = rule.fields.filter(field => {
        const found = fieldAt(parsed, field.path)
        return found.found && sameJson(found.value, field.expected)
      }).length
      return judgment(matched === rule.fields.length, 'fields-equal', 'different-json-fields', { matched, total: rule.fields.length })
    }
    default: return assertNever(rule, 'experiment evaluator rule')
  }
}
function fieldAt(value: JsonValue, path: readonly (string | number)[]): { readonly found: false } | { readonly found: true; readonly value: JsonValue } {
  let current = value
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current) || segment >= current.length) return { found: false }
      current = current[segment]!
    } else {
      if (current === null || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, segment)) return { found: false }
      current = (current as JsonObject)[segment]!
    }
  }
  return { found: true, value: current }
}
function sameJson(a: JsonValue, b: JsonValue): boolean { return Buffer.from(canonicalJsonBytes(a)).equals(Buffer.from(canonicalJsonBytes(b))) }
function summarize(rules: readonly Pick<ExperimentRuleResult, 'status'>[]) {
  const totalRules = rules.length, knownPassed = rules.filter(rule => rule.status === 'pass').length
  const evaluatedRules = rules.filter(rule => rule.status === 'pass' || rule.status === 'fail').length
  const overall: ExperimentEvaluationStatus = rules.some(rule => rule.status === 'error') ? 'error'
    : rules.some(rule => rule.status === 'unavailable') ? 'unavailable' : rules.some(rule => rule.status === 'fail') ? 'fail' : 'pass'
  return { overall, totalRules, knownPassed, evaluatedRules, coverage: evaluatedRules / totalRules, score: evaluatedRules === totalRules ? knownPassed / totalRules : null }
}
