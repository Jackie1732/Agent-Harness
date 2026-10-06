import { describe, expect, it } from 'vitest'
import { evaluateExperimentOutput, decodeExperimentEvaluation } from '../../src/experiment/evaluation.js'
import type { ExperimentEvaluator, ExperimentMediaType, ExperimentRule } from '../../src/experiment/definition-types.js'
import type { ExperimentObservedOutput } from '../../src/experiment/evidence-types.js'
import { experimentBytesDigest } from '../../src/experiment/parsing.js'
import { formatSessionAddress, formatSessionEventId, parseSessionId, sessionSequence } from '../../src/session/ids.js'

const sessionId = parseSessionId('11111111-1111-4111-8111-111111111111')
const sources = [{ address: formatSessionAddress(sessionId), eventId: formatSessionEventId(sessionId, sessionSequence(3)) }]
const digest = 'a'.repeat(64)
function output(text: string, mediaType: ExperimentMediaType = 'text/plain'): ExperimentObservedOutput {
  return { status: 'available', mediaType, sourceMediaType: 'text/plain', text, byteLength: Buffer.byteLength(text),
    sha256: experimentBytesDigest(Buffer.from(text)), sources, workspaceObservation: null }
}
function evaluate(rules: readonly ExperimentRule[], observed: ExperimentObservedOutput, mediaType: ExperimentMediaType = observed.status === 'available' ? observed.mediaType : 'text/plain') {
  const evaluator: ExperimentEvaluator = { evaluatorKey: 'primary', version: '1', implementationVersion: 'rules/v1', rules }
  return evaluateExperimentOutput({ unitKey: 'unit-1', case: { output: { outputKey: 'answer', mediaType } }, evaluator,
    output: observed, evidenceDigest: digest, maxJsonBytes: 65536 })
}

describe('independent deterministic experiment quality evaluation', () => {
  it('text rules compare complete strings without implicit normalization', () => {
    const result = evaluate([{ kind: 'text-exact', ruleKey: 'exact', normalize: [], expected: 'answer' },
      { kind: 'text-includes-all', ruleKey: 'includes', normalize: [], expected: ['ans', 'wer'] }], output('answer\n'))
    expect(result.overall).toBe('fail'); expect(result.rules.map(rule => rule.status)).toEqual(['fail', 'pass'])
    expect(result.knownPassed).toBe(1); expect(result.coverage).toBe(1); expect(result.score).toBe(0.5)
    expect(result.rules[0]!.evidenceRefs).toEqual(sources)
    expect(Object.isFrozen(result.rules)).toBe(true)
    expect(decodeExperimentEvaluation(result, 65536)).toEqual(result)
  })
  it('explicit LF/trim normalization and its declared order affect only observed text', () => {
    expect(evaluate([{ kind: 'text-exact', ruleKey: 'exact', normalize: ['lf', 'trim'], expected: 'a\nb' }], output(' a\r\nb \r\n')).overall).toBe('pass')
    expect(evaluate([{ kind: 'text-exact', ruleKey: 'exact', normalize: ['trim'], expected: 'a\nb' }], output('a\r\nb')).overall).toBe('fail')
    const first = evaluate([{ kind: 'text-exact', ruleKey: 'exact', normalize: ['trim'], expected: 'a' }], output('a'))
    const changed = evaluate([{ kind: 'text-exact', ruleKey: 'exact', normalize: [], expected: 'a' }], output('a'))
    expect(first.evaluatorDigest).not.toBe(changed.evaluatorDigest)
  })
  it('JSON equality ignores object key order but retains array order and value types', () => {
    const rule: ExperimentRule = { kind: 'json-equals', ruleKey: 'json', normalize: [], expected: { a: 1, b: [true, null] } }
    expect(evaluate([rule], output('{"b":[true,null],"a":1}', 'application/json')).overall).toBe('pass')
    expect(evaluate([rule], output('{"b":[null,true],"a":1}', 'application/json')).overall).toBe('fail')
    expect(evaluate([rule], output('{"b":[true,null],"a":"1"}', 'application/json')).overall).toBe('fail')
  })
  it('JSON field paths distinguish object keys, array indexes, absent fields and present null', () => {
    const rule: ExperimentRule = { kind: 'json-fields', ruleKey: 'fields', normalize: [], fields: [
      { path: ['items', 0, 'answer'], expected: null }, { path: ['0'], expected: 42 }] }
    expect(evaluate([rule], output('{"0":42,"items":[{"answer":null}]}', 'application/json')).overall).toBe('pass')
    expect(evaluate([rule], output('{"0":42,"items":[{}]}', 'application/json')).rules[0]!.details).toEqual({ matched: 1, total: 2 })
    expect(evaluate([{ ...rule, fields: [{ path: ['items', '0', 'answer'], expected: null }] }], output('{"items":[{"answer":null}]}', 'application/json')).overall).toBe('fail')
    expect(evaluate([{ ...rule, fields: [{ path: [], expected: null }] }], output('null', 'application/json')).overall).toBe('pass')
  })
  it('authenticated invalid JSON or wrong media is quality failure, missing provenance is unavailable', () => {
    const rule: ExperimentRule = { kind: 'json-equals', ruleKey: 'json', normalize: [], expected: { answer: 42 } }
    const invalid = evaluate([rule], output('{broken', 'application/json'))
    expect(invalid.overall).toBe('fail'); expect(invalid.score).toBe(0); expect(invalid.rules[0]!.reason).toBe('invalid-json')
    expect(evaluate([rule], output('{"answer":42}'), 'application/json').rules[0]!.reason).toBe('media-type')
    const missing = evaluate([rule], { status: 'unavailable', reason: 'source-mismatch', sources })
    expect(missing.overall).toBe('unavailable'); expect(missing.score).toBeNull(); expect(missing.coverage).toBe(0)
    expect(missing.rules[0]!.details).toEqual({ sourceReason: 'source-mismatch' })
  })
  it('durable result decoding rejects forged score/coverage and event namespace changes', () => {
    const result = evaluate([{ kind: 'text-exact', ruleKey: 'exact', normalize: [], expected: 'answer' }], output('wrong'))
    expect(() => decodeExperimentEvaluation({ ...result, overall: 'pass', score: 1 }, 65536)).toThrow('evaluation-summary')
    expect(() => decodeExperimentEvaluation({ ...result, rules: [{ ...result.rules[0]!, evidenceRefs: [{ ...sources[0], address: formatSessionAddress(parseSessionId('22222222-2222-4222-8222-222222222222')) }] }] }, 65536)).toThrow('evidence-ref-identity')
  })
})
