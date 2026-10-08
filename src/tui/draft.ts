/** Grapheme edits and terminal-cell layout for task and field drafts. */
import stringWidth from 'string-width'
import { plainText } from './text.js'

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' })

export interface TextDraft { readonly text: string; readonly cursor: number }
export type DraftEdit =
  | { readonly kind: 'insert'; readonly text: string }
  | { readonly kind: 'left' | 'right' | 'up' | 'down' | 'home' | 'end' | 'backspace' | 'delete' }

/** @param text Source text. @returns Complete graphemes, including newline graphemes. */
export function graphemes(text: string): readonly string[] {
  return [...segmenter.segment(text)].map(part => part.segment)
}

/**
 * Edit without splitting emoji, combining marks or full-width characters.
 * @param draft Current text and grapheme-index cursor.
 * @param edit One key or complete paste insertion.
 * @returns A new draft; vertical motion preserves the nearest terminal-cell column.
 */
export function editDraft(draft: TextDraft, edit: DraftEdit): TextDraft {
  const parts = [...graphemes(draft.text)], cursor = Math.min(draft.cursor, parts.length)
  let next = cursor
  const start = parts.lastIndexOf('\n', cursor - 1) + 1
  const foundEnd = parts.indexOf('\n', cursor), end = foundEnd < 0 ? parts.length : foundEnd
  switch (edit.kind) {
    case 'insert': {
      const prefix = parts.slice(0, cursor).join('') + edit.text
      return { text: prefix + parts.slice(cursor).join(''), cursor: graphemes(prefix).length }
    }
    case 'left': next = Math.max(0, cursor - 1); break
    case 'right': next = Math.min(parts.length, cursor + 1); break
    case 'home': next = start; break
    case 'end': next = end; break
    case 'backspace': if (cursor > 0) { parts.splice(cursor - 1, 1); next-- }; break
    case 'delete': parts.splice(cursor, 1); break
    case 'up':
    case 'down': {
      if (edit.kind === 'up' && start === 0 || edit.kind === 'down' && end === parts.length) break
      const desired = stringWidth(parts.slice(start, cursor).join(''))
      const targetStart = edit.kind === 'up' ? parts.lastIndexOf('\n', start - 2) + 1 : end + 1
      const targetEnd = edit.kind === 'up' ? start - 1 : (() => {
        const index = parts.indexOf('\n', targetStart); return index < 0 ? parts.length : index
      })()
      next = targetStart
      let width = 0
      while (next < targetEnd && width + stringWidth(parts[next]!) <= desired) width += stringWidth(parts[next++]!)
      break
    }
  }
  return { text: parts.join(''), cursor: next }
}

export interface DraftLayout {
  readonly lines: readonly string[]
  readonly cursor: { readonly x: number; readonly y: number }
  readonly firstLine: number
  readonly totalLines: number
}

/**
 * Wrap display graphemes by terminal cells while preserving the original draft.
 * @param draft Original draft.
 * @param columns Available content cells.
 * @param rows Available content rows.
 * @param secret Whether only mask characters may be displayed.
 * @param secrets Invocation credentials to mask wherever they occur in a draft.
 * @returns A cursor-centered display window, never a modified submission.
 */
export function layoutDraft(draft: TextDraft, columns: number, rows: number, secret = false, secrets: readonly string[] = []): DraftLayout {
  const width = Math.max(1, columns), height = Math.max(1, rows)
  const lines = ['']; let x = 0, y = 0, cursor = { x: 0, y: 0 }
  const parts = graphemes(draft.text)
  const hidden: { start: number; end: number }[] = []
  for (const value of secrets) {
    if (value.length === 0) continue
    let start = draft.text.indexOf(value)
    while (start >= 0) { hidden.push({ start, end: start + value.length }); start = draft.text.indexOf(value, start + value.length) }
  }
  let offset = 0
  for (let index = 0; index <= parts.length; index++) {
    if (index === draft.cursor) cursor = { x, y }
    if (index === parts.length) break
    const source = parts[index]!, endOffset = offset + source.length
    const masked = secret || hidden.some(range => offset < range.end && endOffset > range.start)
    const part = masked ? '*' : plainText(source)
    offset = endOffset
    if (!secret && part === '\n') { lines.push(''); y++; x = 0; continue }
    const cells = stringWidth(part)
    if (x + cells > width) { lines.push(''); y++; x = 0; if (index === draft.cursor) cursor = { x, y } }
    lines[y] += part; x += cells
    if (x >= width) { lines.push(''); y++; x = 0 }
  }
  const firstLine = Math.max(0, cursor.y - height + 1)
  return { lines: lines.slice(firstLine, firstLine + height), cursor: { x: cursor.x, y: cursor.y - firstLine }, firstLine, totalLines: lines.length }
}
