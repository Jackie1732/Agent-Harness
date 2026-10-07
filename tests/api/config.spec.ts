import { describe, expect, it } from 'vitest'
import { decodeApiConfig, resolveApiConfig } from '../../src/api/config.js'
import { decodeHostConfig, resolveHostConfig } from '../../src/host/config.js'
import { hostConfig } from '../host/fixtures.js'
import { apiConfig } from './fixtures.js'
import { runnableWorkflowHost } from '../workflow/host-fixture.js'

describe('control configuration', () => {
  it('requires every closed field and a usable basic error budget', async () => {
    const config = await apiConfig()
    expect(decodeApiConfig(config)).toEqual(config)
    expect(() => decodeApiConfig({ ...config, extra: true })).toThrow()
    expect(() => decodeApiConfig({ ...config, limits: { ...config.limits, maxObservers: undefined } })).toThrow()
    expect(() => decodeApiConfig({ ...config, limits: { ...config.limits, maxResponseBytes: 64 } })).toThrow()
    expect(() => decodeApiConfig({ ...config, limits: { ...config.limits, maxWaitMs: 2147483648 } })).toThrow()
    expect(() => decodeApiConfig({ ...config, limits: { ...config.limits, maxJsonDepth: 129 } })).toThrow()
    expect(() => decodeApiConfig({ ...config, limits: { ...config.limits, maxJsonDepth: 1 } })).toThrow()
    expect(() => decodeApiConfig({ ...config, limits: { ...config.limits, maxJsonNodes: 9 } })).toThrow()
  })
  it('rejects identity collisions and nonlocal grants before opening Host', async () => {
    const config = await apiConfig()
    expect(() => decodeApiConfig({ ...config, principals: [config.principals[0], { ...config.principals[0], principalKey: 'another' }] })).toThrow()
    expect(() => decodeApiConfig({ ...config, principals: [{ ...config.principals[0], principalKey: 'a:b' }] })).toThrow()
    expect(() => decodeApiConfig({ ...config, principals: [{ ...config.principals[0], methods: ['host.status', 'host.status'] }] })).toThrow()
    const host = resolveHostConfig(decodeHostConfig(hostConfig('C:/control-tests/store'), 'C:/control-tests'))
    expect(() => resolveApiConfig({ ...config, principals: [{ ...config.principals[0]!, agentKeys: ['remote'] }] }, host, 'C:/control-tests')).toThrow()
    const resolved = resolveApiConfig({ ...config, tls: { caFile: 'ca.pem', serverCertFile: 'cert.pem', serverKeyFile: 'key.pem' } }, host, 'C:/control-tests')
    expect(resolved.tls.caFile).toMatch(/control-tests[\\/]ca.pem$/)
  })
  it('requires every fixed-roster Workflow grant for member-wide pause/resume', async () => {
    const config = await apiConfig(), host = runnableWorkflowHost('C:/control-workflow-tests')
    expect(() => resolveApiConfig(config, host, 'C:/control-workflow-tests')).toThrow()
    expect(() => resolveApiConfig({ ...config, principals: [{ ...config.principals[0]!, workflowKeys: ['research'] }] }, host, 'C:/control-workflow-tests')).not.toThrow()
    const limited = { ...config, principals: [{ ...config.principals[0]!, methods: ['agent.get', 'input.submit'] as const }] }
    expect(() => resolveApiConfig(limited, host, 'C:/control-workflow-tests')).not.toThrow()
  })
})
