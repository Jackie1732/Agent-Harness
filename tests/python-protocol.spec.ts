import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'
import { API_HTTP_STATUS, CONTROL_PROTOCOL, CONTROL_VERSION, decodeParams, decodeControlResponse } from '../src/protocol/index.js'
import type { ControlMethod } from '../src/protocol/index.js'
import { CONTROL_METHODS, jsonLimits, params, requestId } from './protocol/fixtures.js'
import { results } from './protocol/result-fixture.js'

const python = process.env.ATOMIC_HARNESS_PYTHON
interface Case { label: string; kind: 'params' | 'response'; method: ControlMethod; value: unknown; status: number; requestId: string; accepted: boolean }

it.skipIf(python === undefined)('matches all control schemas and reference checks in the explicit Python build/generate gate', async () => {
  const cases: Case[] = []
  const append = (kind: Case['kind'], method: ControlMethod, label: string, value: unknown, status = 200): void => {
    let accepted = true
    try {
      if (kind === 'params') decodeParams(method, value, jsonLimits)
      else decodeControlResponse(method, value, requestId, status, { ...jsonLimits, maxBytes: 2097152 })
    } catch { accepted = false }
    cases.push({ kind, method, label: `${method}/${label}`, value, status, requestId, accepted })
  }
  const receipt = (result: unknown, id: string = requestId) => ({ protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId: id, kind: 'result', result })
  for (const method of CONTROL_METHODS) {
    append('params', method, 'valid', params[method])
    append('params', method, 'unexpected-field', { ...params[method], unexpected: true })
    const keys = Object.keys(params[method])
    if (keys.length > 0) {
      const missing = { ...params[method] } as Record<string, unknown>; delete missing[keys[0]!]
      append('params', method, 'missing-field', missing)
      append('params', method, 'wrong-field-type', { ...params[method], [keys[0]!]: true })
    }
    append('response', method, 'valid-result', receipt(results[method]))
    append('response', method, 'unknown-result-field', receipt({ ...results[method], unexpected: true }))
    append('response', method, 'wrong-request-id', receipt(results[method], 'other-id'))
    append('response', method, 'wrong-http-status', receipt(results[method]), 403)
    const missing = { ...results[method] } as Record<string, unknown>; delete missing[Object.keys(missing)[0]!]
    append('response', method, 'missing-result-field', receipt(missing))
    const original = results[method] as unknown as Record<string, unknown>
    if (Array.isArray(original.cuts)) append('response', method, 'duplicate-cut', receipt({ ...original, cuts: [...original.cuts, ...original.cuts] }))
  }
  append('params', 'message.send', 'embedded-invalid', { ...params['message.send'], payloadJson: '{' })
  append('params', 'message.send', 'embedded-depth-limit', { ...params['message.send'], payloadJson: '['.repeat(65) + '0' + ']'.repeat(65) })
  append('params', 'input.submit', 'unicode-key-byte-limit', { ...params['input.submit'], agentKey: '中'.repeat(43) })
  const oversizedEventId = 'ah-event:91000000-0000-4000-8000-000000000002:' + '9'.repeat(5000)
  append('params', 'root.get', 'oversized-event-sequence', { ...params['root.get'], rootId: oversizedEventId })
  append('response', 'input.submit', 'oversized-event-sequence', receipt({ ...results['input.submit'], inputEventId: oversizedEventId }))
  append('response', 'input.submit', 'maximum-event-sequence', receipt({ ...results['input.submit'], inputEventId: 'ah-event:91000000-0000-4000-8000-000000000002:9007199254740991' }))
  append('params', 'root.get', 'non-safe-event-sequence', { ...params['root.get'], rootId: 'ah-event:91000000-0000-4000-8000-000000000002:9007199254740992' })
  append('response', 'root.get', 'wrong-final-byte-length', receipt({ ...results['root.get'], final: { ...results['root.get'].final, textBytes: 1 } }))
  append('response', 'root.get', 'completed-without-final', receipt({ ...results['root.get'], final: null }))
  append('response', 'input.get', 'task-with-answer-reference', receipt({ ...results['input.get'], wait: { eventId: results['input.get'].inputEventId, index: 0 } }))
  append('response', 'workflow.artifact', 'wrong-artifact-hash', receipt({ ...results['workflow.artifact'], sha256: '0'.repeat(64) }))
  append('response', 'workflow.output', 'foreign-reference-session', receipt({ ...results['workflow.output'], decisionRef: {
    address: 'ah-session:91000000-0000-4000-8000-000000000099', eventId: results['workflow.artifact'].decisionRef.eventId } }))
  for (const [code, status] of Object.entries(API_HTTP_STATUS)) {
    const value = { protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId, kind: 'error',
      error: { code, message: 'Control request rejected', acceptance: 'not-accepted', domainCode: null } }
    append('response', 'input.submit', code, value, status)
    append('response', 'input.submit', code + '-wrong-http', value, 200)
    append('response', 'input.submit', code + '-null-pre-admission-id', { ...value, requestId: null }, status)
    append('response', 'input.submit', code + '-null-unknown-id', { ...value, requestId: null, error: { ...value.error, acceptance: 'unknown' } }, status)
  }
  const child = spawn(python!, [resolve('python/tests/cross_protocol.py')], { env: { ...process.env, PYTHONPATH: resolve('python/src'), PYTHONUTF8: '1' }, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) }); child.stderr.on('data', chunk => { stderr += String(chunk) })
  const exit = new Promise<number | null>((done, reject) => { child.once('error', reject); child.once('exit', done) })
  child.stdin.end(JSON.stringify(cases))
  expect(await exit, stderr).toBe(0)
  expect(JSON.parse(stdout)).toEqual(cases.map(({ label, accepted }) => ({ label, accepted })))
  expect(cases.filter(item => item.kind === 'params' && item.accepted)).toHaveLength(CONTROL_METHODS.length)
}, 30000)
