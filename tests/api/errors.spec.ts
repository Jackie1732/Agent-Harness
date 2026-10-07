import { expect, it } from 'vitest'
import { apiFailure } from '../../src/api/errors.js'
import { HostError } from '../../src/host/errors.js'
import { AgentError } from '../../src/agent/errors.js'

it('preserves possibly accepted cancellation and redacts private diagnostics', () => {
  expect(apiFailure(new HostError('HOST_LIMIT_EXCEEDED', 'private path secret'), 'root.cancel', true)).toEqual({ code: 'API_LIMIT_EXCEEDED',
    message: 'Request failed', acceptance: 'unknown', domainCode: 'HOST_LIMIT_EXCEEDED' })
  expect(apiFailure(new AgentError('AGENT_KEY_CONFLICT', 'private text'), 'input.submit', true)).toMatchObject({ code: 'API_KEY_CONFLICT', acceptance: 'not-accepted' })
  expect(apiFailure(new Error('credential value'), 'host.run', true)).toEqual({ code: 'API_INTERNAL_ERROR', message: 'Request failed', acceptance: 'unknown', domainCode: null })
  expect(apiFailure(new Error('credential value'), 'root.get', true)).toMatchObject({ acceptance: 'not-applicable' })
})
