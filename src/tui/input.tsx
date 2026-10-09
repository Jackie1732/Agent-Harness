/** Ink owns raw mode, bracketed paste and cursor restoration for all draft inputs. */
import { useEffect, useRef, useState } from 'react'
import { Box, Text, measureElement, useBoxMetrics, useCursor, useInput, usePaste, useWindowSize } from 'ink'
import type { DOMElement } from 'ink'
import { editDraft, graphemes, layoutDraft } from './draft.js'
import type { DraftEdit, TextDraft } from './draft.js'
import { plainText } from './text.js'

export interface DraftInputProps {
  readonly initial?: string
  readonly label: string
  readonly multiline?: boolean
  readonly secret?: boolean
  readonly secrets?: readonly string[]
  readonly rows?: number
  readonly onConfirm: (text: string) => void
  readonly onCancel: () => void
  readonly onChange?: (text: string) => void
  readonly onTab?: () => void
}

/**
 * Edit task text or one scalar field; paste never invokes a key action.
 * @param props Field policy and callbacks; confirmation carries the original text.
 * @returns An Ink field with a cell-positioned IME cursor.
 */
export function DraftInput(props: DraftInputProps) {
  const [draft, setDraft] = useState<TextDraft>(() => ({ text: props.initial ?? '', cursor: graphemes(props.initial ?? '').length }))
  const currentDraft = useRef(draft)
  const box = useRef<DOMElement | null>(null), metrics = useBoxMetrics(box)
  const { columns, rows } = useWindowSize(), { setCursorPosition } = useCursor()
  const visibleRows = props.rows ?? Math.max(1, Math.min(8, rows - 8))
  const layout = layoutDraft(draft, metrics.clientWidth || columns - 4, Math.min(visibleRows, Math.max(1, metrics.clientHeight || visibleRows)), props.secret, props.secrets)
  const change = (edit: DraftEdit) => {
    const next = editDraft(currentDraft.current, edit); currentDraft.current = next; setDraft(next); props.onChange?.(next.text)
  }
  usePaste(text => change({ kind: 'insert', text: text.replace(/\r\n?/g, '\n') }))
  useInput((input, key) => {
    if (key.ctrl && input === 'c') return
    if (key.escape) { props.onCancel(); return }
    if (key.tab && props.onTab !== undefined) { props.onTab(); return }
    if (key.ctrl && input === 's' || key.return && !props.multiline) { props.onConfirm(currentDraft.current.text); return }
    if (key.return) { change({ kind: 'insert', text: '\n' }); return }
    const kind = key.leftArrow ? 'left' : key.rightArrow ? 'right' : key.upArrow ? 'up' : key.downArrow ? 'down'
      : key.home ? 'home' : key.end ? 'end' : key.backspace ? 'backspace' : key.delete ? 'delete' : undefined
    if (kind !== undefined) change({ kind })
    else if (!key.ctrl && !key.meta && input.length > 0) {
      const normalized = input.replace(/\r\n?/g, '\n'), newline = normalized.indexOf('\n')
      if (!props.multiline && newline >= 0) {
        change({ kind: 'insert', text: normalized.slice(0, newline) }); props.onConfirm(currentDraft.current.text)
      } else change({ kind: 'insert', text: normalized })
    }
  })
  useEffect(() => {
    if (box.current === null) return
    const position = measureElement(box.current)
    setCursorPosition({ x: position.x + 1 + layout.cursor.x, y: position.y + 1 + layout.cursor.y })
    return () => setCursorPosition(undefined)
  }, [draft, metrics, columns, rows, layout.cursor.x, layout.cursor.y, setCursorPosition])
  return <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={6}>
    <Box flexShrink={0}><Text bold wrap="truncate">{plainText(props.label, props.secrets)}</Text></Box>
    <Box ref={box} borderStyle="single" flexDirection="column" flexGrow={1} flexBasis={0} minHeight={3} maxHeight={visibleRows + 2} overflowY="hidden">
      {layout.lines.map((line, index) => <Text key={index} wrap="truncate">{line.length === 0 ? ' ' : line}</Text>)}
    </Box>
    <Box flexDirection="column" flexShrink={0}><Text dimColor wrap="truncate">{props.secret ? '隐藏输入；取消结束启动' : `${draft.cursor}/${graphemes(draft.text).length} 字符组 · 显示行 ${layout.firstLine + 1}/${layout.totalLines}`}</Text>
      <Text dimColor wrap="truncate">{props.multiline ? 'Enter 换行 · Ctrl+S 提交' : 'Enter 确认 · Esc 返回'}</Text>
      {props.multiline && <Text dimColor wrap="truncate">Tab 切换提交方式 · Esc 放弃</Text>}</Box>
  </Box>
}
