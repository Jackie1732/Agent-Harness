import { expect, it } from 'vitest'
import { editDraft } from '../src/tui/draft.js'

it.each(['home', 'up'] as const)('keeps %s at the beginning of a multiline draft', kind => {
  const draft = { text: '中文\nＡb\n末行', cursor: 0 }
  expect(editDraft(draft, { kind })).toEqual(draft)
})

it('moves from the second line into an empty first line without changing graphemes', () => {
  const draft = { text: '\n中文👩‍🔬e\u0301\n末行', cursor: 3 }
  const moved = editDraft(draft, { kind: 'up' })
  expect(moved).toEqual({ text: draft.text, cursor: 0 })
  expect(editDraft(moved, { kind: 'down' })).toEqual({ text: draft.text, cursor: 1 })
})
