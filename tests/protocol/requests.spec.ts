import { describe, expect, it } from 'vitest'
import { decodeControlRequest, decodeParams, ProtocolError } from '../../src/protocol/index.js'
import { CONTROL_METHODS, eventId, instanceId, jsonLimits, messageId, params, request, sessionId } from './fixtures.js'

describe('control request decoding', () => {
  it.each(CONTROL_METHODS)('accepts the exact %s parameters and rejects an extra field', method => {
    expect(decodeControlRequest(request(method), jsonLimits)).toEqual(request(method))
    expect(() => decodeParams(method, { ...params[method], originLabel: 'impersonated' }, jsonLimits)).toThrow(ProtocolError)
  })
  it('rejects unknown protocol, versions, methods and outer fields before domain admission', () => {
    for (const invalid of [
      { ...request('host.status'), version: 2 }, { ...request('host.status'), protocol: 'other' },
      { ...request('host.status'), method: 'model.invoke' }, { ...request('host.status'), extra: true },
      { ...request('host.status'), requestId: '' }, { ...request('host.status'), requestId: 'a'.repeat(129) },
      { ...request('host.status'), requestId: '中文' }, { ...request('host.status'), requestId: 'one\ntwo' },
    ]) expect(() => decodeControlRequest(invalid, jsonLimits)).toThrow(ProtocolError)
    try { decodeControlRequest({ ...request('host.status'), version: 2 }, jsonLimits) }
    catch (error) { expect(error).toMatchObject({ code: 'API_VERSION_UNSUPPORTED' }) }
  })
  it('keeps message methods separate and rejects mismatched wait conditions', () => {
    expect(() => decodeParams('message.send', params['message.reply'], jsonLimits)).toThrow(ProtocolError)
    expect(() => decodeParams('message.reply', params['message.send'], jsonLimits)).toThrow(ProtocolError)
    expect(() => decodeParams('message.send', { ...params['message.send'], kind: 'reply' }, jsonLimits)).toThrow(ProtocolError)
    expect(() => decodeParams('message.wait', { agentKey: 'writer', messageId, direction: 'inbox', until: 'terminal', timeoutMs: 1 }, jsonLimits)).toThrow(ProtocolError)
  })
  it('validates action indexes, timer bounds, UTF-8 reason bytes and explicit empty Workflow reasons', () => {
    expect(() => decodeParams('input.answer', { ...params['input.answer'], wait: { eventId, index: 64 } }, jsonLimits)).toThrow(ProtocolError)
    expect(() => decodeParams('root.wait', { ...params['root.wait'], timeoutMs: 0 }, jsonLimits)).toThrow(ProtocolError)
    expect(() => decodeParams('root.wait', { ...params['root.wait'], timeoutMs: 2_147_483_648 }, jsonLimits)).toThrow(ProtocolError)
    expect(() => decodeParams('root.cancel', { ...params['root.cancel'], reason: '字'.repeat(43) }, jsonLimits)).toThrow(ProtocolError)
    expect(() => decodeParams('root.cancel', { ...params['root.cancel'], reason: '' }, jsonLimits)).toThrow(ProtocolError)
    expect(decodeParams('workflow.cancel', params['workflow.cancel'], jsonLimits)).toEqual(params['workflow.cancel'])
    expect(() => decodeParams('host.run', { expectedInstanceId: instanceId.toUpperCase().replace('910', 'A10') }, jsonLimits)).toThrow(ProtocolError)
  })
  it('enforces exclusive input lookup and fixed-cut pagination parameters', () => {
    expect(decodeParams('input.get', { agentKey: 'writer', inputEventId: eventId }, jsonLimits)).toEqual({ agentKey: 'writer', inputEventId: eventId })
    expect(() => decodeParams('input.get', { ...params['input.get'], inputEventId: eventId }, jsonLimits)).toThrow(ProtocolError)
    expect(() => decodeParams('input.get', { agentKey: 'writer' }, jsonLimits)).toThrow(ProtocolError)
    const cursor = { sessionId, through: 1, nextSequence: 1 }
    expect(decodeParams('session.events', { ...params['session.events'], cursor }, jsonLimits)).toHaveProperty('cursor', cursor)
    expect(() => decodeParams('session.events', { ...params['session.events'], cursor, after: 0 }, jsonLimits)).toThrow(ProtocolError)
    expect(() => decodeParams('session.events', { ...params['session.events'], target: { kind: 'session', sessionId } }, jsonLimits)).toThrow(ProtocolError)
  })
  it('applies configured JSON limits to the embedded payload string, and leaves task prose intact', () => {
    const limits = { ...jsonLimits, maxDepth: 4 }
    const payloadJson = JSON.stringify({ a: { b: { c: { d: { e: 1 } } } } })
    expect(() => decodeParams('message.send', { ...params['message.send'], payloadJson }, limits)).toThrow(ProtocolError)
    expect(() => decodeParams('message.send', { ...params['message.send'], payloadJson: '{broken' }, limits)).toThrow(ProtocolError)
    expect(decodeParams('input.submit', { ...params['input.submit'], text: '{broken' }, limits)).toHaveProperty('text', '{broken')
    expect(() => decodeControlRequest(request('input.submit'), { ...jsonLimits, maxBytes: 16 })).toThrow(ProtocolError)
  })
})
