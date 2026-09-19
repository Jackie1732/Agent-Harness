import { describe, expect, it } from 'vitest'
import { decodeHostConfig, planHostConfig, resolveHostConfig } from '../../src/index.js'
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
})
