import { afterEach, expect, it, vi } from 'vitest'
import { UiSession } from '../../src/ui/session.js'

afterEach(() => vi.restoreAllMocks())
it('replaces one operator token, rejects ambiguous cookies and preserves absolute expiry', () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1000), session = new UiSession('operator-secret', 1000)
  expect(session.login('wrong')).toBeUndefined()
  const first = session.login('operator-secret')!, cookie = first.split(';')[0]!
  expect(first).toContain('HttpOnly; SameSite=Strict; Path=/')
  expect(session.accepts(cookie)).toBe(true)
  expect(session.accepts(`${cookie}; ${cookie}`)).toBe(false)
  const second = session.login('operator-secret')!.split(';')[0]!
  expect(session.accepts(cookie)).toBe(false); expect(session.accepts(second)).toBe(true)
  now.mockReturnValue(1999); expect(session.accepts(second)).toBe(true)
  now.mockReturnValue(2000); expect(session.accepts(second)).toBe(false)
  now.mockReturnValue(1000); session.logout(); expect(session.accepts(second)).toBe(false)
})
