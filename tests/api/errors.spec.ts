import { expect, it } from 'vitest'
import { apiFailure, ApiRejection } from '../../src/api/errors.js'
import { HostError } from '../../src/host/errors.js'
import { AgentError } from '../../src/agent/errors.js'
import { SubagentError } from '../../src/subagent/errors.js'

it('preserves possibly accepted cancellation and redacts private diagnostics', () => {
  expect(apiFailure(new HostError('HOST_LIMIT_EXCEEDED', 'private path secret'), 'root.cancel', true, false)).toEqual({ code: 'API_LIMIT_EXCEEDED',
    message: 'Request failed', acceptance: 'unknown', domainCode: 'HOST_LIMIT_EXCEEDED' })
  expect(apiFailure(new AgentError('AGENT_KEY_CONFLICT', 'private text'), 'input.submit', true, false)).toMatchObject({ code: 'API_KEY_CONFLICT', acceptance: 'not-accepted' })
  expect(apiFailure(new Error('credential value'), 'host.run', true, false)).toEqual({ code: 'API_INTERNAL_ERROR', message: 'Request failed', acceptance: 'unknown', domainCode: null })
  expect(apiFailure(new Error('credential value'), 'root.get', true, false)).toMatchObject({ acceptance: 'not-applicable' })
  expect(apiFailure(new ApiRejection('API_FORBIDDEN'), 'agent.get', false, false)).toMatchObject({ acceptance: 'not-applicable' })
  expect(apiFailure(new ApiRejection('API_FORBIDDEN'), undefined, false, false)).toMatchObject({ acceptance: 'not-accepted' })
  expect(apiFailure(new ApiRejection('API_FORBIDDEN'), 'input.submit', false, false)).toMatchObject({ acceptance: 'not-accepted' })
})

it('distinguishes post-mutation observation failure from original inactive rejection', () => {
  const inactive = new HostError('HOST_INACTIVE', 'host-not-ready')
  for (const method of ['root.cancel', 'delegation.spawn', 'delegation.cancel', 'workflow.pause', 'workflow.resume', 'workflow.cancel', 'workflow.retry'] as const) {
    expect(apiFailure(inactive, method, true, true)).toMatchObject({ code: 'API_INACTIVE', acceptance: 'unknown' })
    expect(apiFailure(inactive, method, true, false)).toMatchObject({ code: 'API_INACTIVE', acceptance: 'not-accepted' })
  }
  expect(apiFailure(inactive, 'input.submit', false, false)).toMatchObject({ code: 'API_INACTIVE', acceptance: 'not-accepted' })
  expect(apiFailure(new ApiRejection('API_INACTIVE'), 'agent.resume', true, false)).toMatchObject({ code: 'API_INACTIVE', acceptance: 'not-accepted' })
})

it('keeps invoked cancellation uncertain when its Agent journal becomes inactive', () => {
  const agent = new AgentError('AGENT_INACTIVE', 'journal-not-writable')
  for (const method of ['root.cancel', 'delegation.cancel', 'workflow.cancel'] as const) {
    expect(apiFailure(agent, method, true, false)).toMatchObject({ code: 'API_INACTIVE', acceptance: 'unknown' })
    expect(apiFailure(agent, method, false, false)).toMatchObject({ acceptance: 'not-accepted' })
    expect(apiFailure(new HostError('HOST_INACTIVE', 'host-not-ready'), method, true, false)).toMatchObject({ acceptance: 'not-accepted' })
    expect(apiFailure(new SubagentError('SUBAGENT_INACTIVE', 'admission-closed'), method, true, false)).toMatchObject({ acceptance: 'not-accepted' })
  }
  expect(apiFailure(agent, 'input.submit', true, false)).toMatchObject({ acceptance: 'not-accepted' })
})
