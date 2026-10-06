import { parseSessionAddress, sessionLogPosition } from '../session/ids.js'
import type { ExperimentLimits } from './definition-types.js'
import type { ExperimentMetrics } from './metrics-types.js'
import { experimentCountMetricNames, modelUsageFields, experimentUnavailableMetricNames } from './metrics-types.js'
import { decodeEvidenceEventRef, decodeMetricsCoverage, evidenceBoolean } from './evidence-codec-fields.js'
import { experimentArray as array, experimentChoice as choice, experimentInteger as integer, experimentKeys as exact,
  experimentObject as object, experimentText as text, invalidExperiment as invalid } from './parsing.js'

/** Validate persisted metric fields and accounting identities without rereading raw events. */
export function decodeExperimentMetrics(value: unknown, limits: Pick<ExperimentLimits, 'maxSessionCount' | 'maxMetricSamples' | 'maxEvents'>): ExperimentMetrics {
  const input = object(value, 'metrics')
  exact(input, ['definitionVersion', 'scope', 'mode', 'coverage', 'counts', 'tokens', 'providers', 'messageCausation', 'unavailable'], 'metrics')
  if (input.definitionVersion !== 'experiment-metrics/v1') invalid('metrics-version')
  const scope = choice(input.scope, ['unit-local/v1', 'historical-local/v1'], 'metrics-scope')
  choice(input.mode, ['fixture', 'live', 'historical'], 'metrics-mode')
  decodeMetricsCoverage(input.coverage, limits)
  let samples = 0
  const basis = (value: unknown) => {
    const item = object(value, 'metric-basis'); exact(item, ['rule', 'cuts', 'evidenceRefs', 'matchedEvents', 'truncated'], 'metric-basis')
    text(item.rule, 'metric-rule', 4096)
    array(item.cuts, 'metric-cuts', limits.maxSessionCount).forEach(value => {
      const cut = object(value, 'metric-cut'); exact(cut, ['address', 'through'], 'metric-cut')
      parseSessionAddress(text(cut.address, 'metric-cut-address', 64)); sessionLogPosition(integer(cut.through, 'metric-cut-through', 0))
    })
    const refs = array(item.evidenceRefs, 'metric-refs', limits.maxMetricSamples)
    samples += refs.length
    if (samples > limits.maxMetricSamples) invalid('metric-sample-budget')
    refs.forEach(decodeEvidenceEventRef)
    const matched = integer(item.matchedEvents, 'metric-matched', 0), truncated = evidenceBoolean(item.truncated, 'metric-truncated')
    if (refs.length > matched || truncated !== (refs.length < matched)) invalid('metric-sample-accounting')
  }
  const common = (item: Record<string, unknown>, version: string) => {
    if (item.definitionVersion !== version || item.scope !== scope) invalid('metric-version-or-scope')
    const coverage = decodeMetricsCoverage(item.coverage, limits)
    basis(item.basis)
    return coverage
  }
  const counts = object(input.counts, 'metric-counts'); exact(counts, experimentCountMetricNames, 'metric-counts')
  for (const name of experimentCountMetricNames) {
    const item = object(counts[name], 'count-metric'); exact(item, ['definitionVersion', 'scope', 'value', 'knownSubtotal', 'status', 'coverage', 'basis'], 'count-metric')
    const coverage = common(item, 'event-count/v1'), subtotal = integer(item.knownSubtotal, 'count-subtotal', 0)
    const complete = item.status === 'complete'
    choice(item.status, ['complete', 'incomplete'], 'count-status')
    if (complete !== coverage.complete || item.value !== (complete ? subtotal : null)) invalid('count-completeness')
  }
  const tokens = object(input.tokens, 'metric-tokens'); exact(tokens, modelUsageFields, 'metric-tokens')
  for (const name of modelUsageFields) {
    const item = object(tokens[name], 'token-metric')
    exact(item, ['definitionVersion', 'scope', 'total', 'knownSubtotal', 'observedCount', 'knownCount', 'eligibleCount', 'ratio', 'status', 'coverage', 'basis'], 'token-metric')
    const coverage = common(item, 'provider-usage/v1'), subtotal = integer(item.knownSubtotal, 'token-subtotal', 0)
    const observed = integer(item.observedCount, 'token-observed', 0), known = integer(item.knownCount, 'token-known', 0), eligible = integer(item.eligibleCount, 'token-eligible', 0)
    const complete = coverage.complete && known === eligible
    if (known > observed || observed > eligible || item.total !== (complete ? subtotal : null) || item.status !== (complete ? 'complete' : 'incomplete')
      || item.ratio !== (coverage.complete && eligible > 0 ? known / eligible : null)) invalid('token-completeness')
  }
  const cause = object(input.messageCausation, 'causation-metric')
  exact(cause, ['definitionVersion', 'scope', 'value', 'knownSubtotal', 'status', 'uniqueMessages', 'resolvedMessages', 'reasons', 'coverage', 'basis'], 'causation-metric')
  const coverage = common(cause, 'message-causation/v1'), maximum = integer(cause.knownSubtotal, 'causation-depth', 0)
  const messages = integer(cause.uniqueMessages, 'causation-messages', 0), resolved = integer(cause.resolvedMessages, 'causation-resolved', 0), complete = coverage.complete && resolved === messages
  array(cause.reasons, 'causation-reasons', limits.maxEvents).forEach(value => text(value, 'causation-reason', 4096))
  if (resolved > messages || cause.status !== (complete ? 'complete' : 'incomplete') || cause.value !== (complete && messages > 0 ? maximum : null)) invalid('causation-completeness')
  const unavailable = array(input.unavailable, 'unavailable-metrics', experimentUnavailableMetricNames.length)
  const names = unavailable.map(value => {
    const item = object(value, 'unavailable-metric')
    exact(item, ['name', 'definitionVersion', 'scope', 'value', 'knownSubtotal', 'status', 'reason', 'coverage', 'basis'], 'unavailable-metric')
    const name = choice(item.name, experimentUnavailableMetricNames, 'unavailable-name'); text(item.reason, 'unavailable-reason', 4096)
    common(item, 'unavailable/v1')
    if (item.value !== null || item.knownSubtotal !== null || item.status !== 'unavailable') invalid('unavailable-fields')
    return name
  })
  if (names.length !== experimentUnavailableMetricNames.length || new Set(names).size !== names.length) invalid('unavailable-matrix')
  array(input.providers, 'metric-providers', limits.maxEvents).forEach(value => {
    const item = object(value, 'metric-provider'); exact(item, ['providerId', 'protocol', 'adapterVersion', 'endpoint', 'model'], 'metric-provider')
    for (const field of ['providerId', 'protocol', 'adapterVersion', 'endpoint', 'model']) text(item[field], 'metric-provider-field', 4096)
  })
  return input as unknown as ExperimentMetrics
}
