import { describe, expect, it } from 'vitest'
import { decodeHostConfig, planHostConfig, resolveHostConfig, exportHostConfig } from '../../src/index.js'
import { hostConfig } from './fixtures.js'

describe('Host configuration', () => {
  it('plans null identities through the explicit source and resolves no future Event identity', () => {
    const input = hostConfig('C:\\atomic-host-test')
    const member = (input.members as readonly Record<string, unknown>[])[0]!
    const plannedInput = { ...input, members: [{ ...member, sessionId: null }] }
    const decoded = decodeHostConfig(plannedInput, 'C:\\')
    const planned = planHostConfig(decoded, {
      nextSessionId: () => '72000000-0000-4000-8000-000000000101' as never,
      nextChannelId: () => '73000000-0000-4000-8000-000000000101' as never,
    })
    const resolved = resolveHostConfig(planned)
    expect(resolved.members[0]).toMatchObject({ sessionId: '72000000-0000-4000-8000-000000000101' })
    expect('profileEventId' in (resolved.members[0] as { spec: object }).spec).toBe(false)
  })

  it('rejects duplicate logical identifiers and programmatic accessors without invoking them', () => {
    const input = hostConfig('C:\\atomic-host-test')
    expect(() => decodeHostConfig({ ...input, members: [...input.members as readonly unknown[], ...(input.members as readonly unknown[])] }, 'C:\\'))
      .toThrowError(expect.objectContaining({ code: 'HOST_CONFIG_INVALID' }))
    let invoked = false
    const accessor = Object.defineProperty({}, 'schemaVersion', { enumerable: true, get() { invoked = true; return 1 } })
    expect(() => decodeHostConfig(accessor, 'C:\\')).toThrowError(expect.objectContaining({ code: 'HOST_CONFIG_INVALID' }))
    expect(invoked).toBe(false)
  })

  it('documents JSON duplicate-property parsing as last-value behavior', () => {
    const parsed = JSON.parse('{"value":1,"value":2}') as { value: number }
    expect(parsed.value).toBe(2)
  })

  it('rejects proxies without evaluating traps and exports no execution paths', () => {
    let invoked = false
    const proxy = new Proxy({}, { getPrototypeOf() { invoked = true; throw new Error('must not execute') } })
    expect(() => decodeHostConfig(proxy, 'C:\\')).toThrowError(expect.objectContaining({ code: 'HOST_CONFIG_INVALID' }))
    expect(invoked).toBe(false)
    const spec = resolveHostConfig(decodeHostConfig(hostConfig('C:\\private-workspace'), 'C:\\'))
    const exported = exportHostConfig(spec)
    expect(exported.redacted).toBe(true)
    expect(JSON.stringify(exported)).not.toContain('private-workspace')
    expect(exported.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('normalizes malformed nested fields and parser errors to configuration failures', () => {
    const input = hostConfig('C:\\atomic-host-test')
    const member = (input.members as readonly Record<string, unknown>[])[0]!
    expect(() => decodeHostConfig({ ...input, members: [{ ...member, spec: { ...(member.spec as object), messages: null } }] }, 'C:\\'))
      .toThrowError(expect.objectContaining({ code: 'HOST_CONFIG_INVALID' }))
    expect(() => decodeHostConfig({ ...input, routes: [{ memberKey: 'writer', ownerHost: 'test-host', origin: 'invalid-url', serverName: 'localhost' }] }, 'C:\\'))
      .toThrowError(expect.objectContaining({ code: 'HOST_CONFIG_INVALID' }))
  })
})
