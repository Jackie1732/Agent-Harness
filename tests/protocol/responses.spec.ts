import { describe, expect, it } from 'vitest'
import { API_HTTP_STATUS, CONTROL_PROTOCOL, CONTROL_VERSION, decodeControlResponse, decodeResult, ProtocolError } from '../../src/protocol/index.js'
import { decodeStoredSessionEvent } from '../../src/session/codec.js'
import { agentFixture, openStep } from '../agent/fixtures.js'
import { projectAgentReport } from '../../src/agent/report.js'
import { CONTROL_METHODS, eventId, jsonLimits, requestId, sessionId } from './fixtures.js'
import { message, results, root } from './result-fixture.js'

function response(result: unknown) { return { protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId, kind: 'result', result } }
describe('control response decoding', () => {
  it.each(CONTROL_METHODS)('validates every %s result and rejects a missing or extra field', method => {
    const result = results[method]
    expect(decodeControlResponse(method, response(result), requestId, 200, jsonLimits)).toEqual(response(result))
    expect(() => decodeResult(method, {}, jsonLimits)).toThrow(ProtocolError)
    expect(() => decodeResult(method, { ...result, serverPath: 'not-public' }, jsonLimits)).toThrow(ProtocolError)
  })
  it('rejects status-kind-code and correlation mismatches, and restricts uncorrelated errors', () => {
    const result = response(results['input.submit'])
    for (const invalid of [{ ...result, requestId: 'different' }, { ...result, version: 2 }, { ...result, requestId: null }]) {
      expect(() => decodeControlResponse('input.submit', invalid, requestId, 200, jsonLimits)).toThrow(ProtocolError)
    }
    expect(() => decodeControlResponse('input.submit', result, requestId, 409, jsonLimits)).toThrow(ProtocolError)
    for (const [code, status] of Object.entries(API_HTTP_STATUS)) {
      const error = { protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId, kind: 'error',
        error: { code, message: 'Operation rejected', acceptance: 'unknown', domainCode: null } }
      expect(decodeControlResponse('input.submit', error, requestId, status, jsonLimits)).toEqual(error)
      expect(() => decodeControlResponse('input.submit', error, requestId, 200, jsonLimits)).toThrow(ProtocolError)
    }
    const uncorrelated = { protocol: CONTROL_PROTOCOL, version: CONTROL_VERSION, requestId: null, kind: 'error',
      error: { code: 'API_PROTOCOL_INVALID', message: 'Request rejected', acceptance: 'not-accepted', domainCode: null } }
    expect(decodeControlResponse('input.submit', uncorrelated, requestId, 400, jsonLimits)).toEqual(uncorrelated)
    expect(() => decodeControlResponse('input.submit', { ...uncorrelated, error: { ...uncorrelated.error, acceptance: 'unknown' } }, requestId, 400, jsonLimits)).toThrow(ProtocolError)
  })
  it('retains legal null outputs, empty text and omitted Root text as distinct data', () => {
    expect(decodeResult('workflow.output', results['workflow.output'], jsonLimits)).toHaveProperty('value', null)
    expect(decodeResult('root.get', root, jsonLimits)).toHaveProperty('final.text', '')
    expect(decodeResult('root.get', { ...root, final: { ...root.final, text: null, textBytes: 5000, textOmitted: true } }, jsonLimits)).toHaveProperty('final.textOmitted', true)
    expect(() => decodeResult('root.get', { ...root, final: null }, jsonLimits)).toThrow(ProtocolError)
    expect(() => decodeResult('root.get', { ...root, outcome: 'cancelled' }, jsonLimits)).toThrow(ProtocolError)
    expect(() => decodeResult('root.get', { ...root, final: { ...root.final, text: '字', textBytes: 1 } }, jsonLimits)).toThrow(ProtocolError)
    expect(() => decodeResult('workflow.artifact', { ...results['workflow.artifact'], text: 'changed' }, jsonLimits)).toThrow(ProtocolError)
  })
  it('rejects missing command receipts and preserves user JSON with protocol-like field names', () => {
    expect(() => decodeResult('message.send', { ...results['message.send'], messageId: null }, jsonLimits)).toThrow(ProtocolError)
    expect(decodeResult('message.get', message, jsonLimits)).toEqual(message)
    const value = { cuts: ['ordinary user data'], address: 'literal address', eventId: 'literal id' }
    expect(decodeResult('workflow.output', { ...results['workflow.output'], value }, jsonLimits)).toHaveProperty('value', value)
    expect(() => decodeResult('root.get', { ...root, cuts: [...root.cuts, ...root.cuts] }, jsonLimits)).toThrow(ProtocolError)
    for (const method of ['workflow.pause', 'workflow.cancel', 'workflow.retry'] as const) {
      expect(() => decodeResult(method, { ...results[method], status: 'resumed' }, jsonLimits)).toThrow(ProtocolError)
    }
  })
  it('retains unknown ignorable envelopes and validates identities and fixed-cut page continuation', () => {
    const event = decodeStoredSessionEvent(Buffer.from(JSON.stringify({ envelopeVersion: 1, sessionId, eventId, sequence: 1,
      recordedAt: '2026-10-07T00:00:00.000Z', type: 'future/fact', payloadVersion: 7, ignorable: true, payload: { value: 'preserved' } })))
    const page = { sessionId, through: 1, parent: null, events: [event], nextCursor: null, hasMore: false }
    expect(decodeResult('session.events', page, jsonLimits)).toEqual(page)
    expect(() => decodeResult('session.events', { ...page, events: [{ ...event, sequence: 2 }] }, jsonLimits)).toThrow(ProtocolError)
    expect(() => decodeResult('session.events', { ...page, hasMore: true }, jsonLimits)).toThrow(ProtocolError)
    expect(() => decodeResult('session.events', { ...page, nextCursor: { sessionId, through: 1, nextSequence: 2 }, hasMore: true }, jsonLimits)).toThrow(ProtocolError)
    expect(() => decodeResult('session.events', { ...page, events: [], nextCursor: { sessionId, through: 1, nextSequence: 1 }, hasMore: true }, jsonLimits)).toThrow(ProtocolError)
    expect(() => decodeResult('session.events', { ...page, through: 2 }, jsonLimits)).toThrow(ProtocolError)
  })
  it('accepts actual Agent report run records from the original projector', async () => {
    const fixture = await agentFixture()
    try {
      await openStep(fixture)
      const observation = { ...results['agent.get'], sessionId: fixture.session.header.sessionId, report: projectAgentReport(fixture.session.snapshot()) }
      expect(decodeResult('agent.get', observation, jsonLimits)).toEqual(observation)
      const report = observation.report
      expect(() => decodeResult('agent.get', { ...observation, report: { ...report, run: { ...report.run, started: { ...report.run!.started, payload: { spec: 'invalid', kind: 'drive' } } } } }, jsonLimits)).toThrow(ProtocolError)
    } finally { await fixture.close() }
  })
})
