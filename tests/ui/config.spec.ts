import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { decodeUiConfig, parseUiConfig, resolveUiConfig } from '../../src/ui/config.js'
import { uiConfig } from './fixtures.js'

it('accepts explicit deployment configuration and resolves only local TLS paths', async () => {
  const example = parseUiConfig(await readFile(new URL('../../examples/ui-config.json', import.meta.url), 'utf8'))
  expect(resolveUiConfig(example, process.cwd()).remote.caFile).toContain('tls')
  expect(example.remote.origin).toBe('https://127.0.0.1:4317')
  expect(example.passwordEnv).toBe('HARNESS_UI_PASSWORD')
})
it('rejects extra fields, invalid origin, absent budgets and oversized session information', () => {
  const config = uiConfig(1234)
  for (const invalid of [{ ...config, listenHost: '0.0.0.0' }, { ...config, remote: { ...config.remote, origin: 'http://127.0.0.1:1234' } },
    { ...config, limits: { ...config.limits, sessionTimeoutMs: 0 } }, { ...config, memberKeys: ['writer', 'writer'] },
    { ...config, passwordEnv: 'not-an-env' }, { ...config, remote: { ...config.remote, limits: { ...config.remote.limits, maxResponseBytes: 1 } } }]) {
    expect(() => decodeUiConfig(invalid)).toThrowError(expect.objectContaining({ code: 'HOST_CONFIG_INVALID' }))
  }
})
