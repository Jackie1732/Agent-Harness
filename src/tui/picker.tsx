/** Keyboard selection shared by field types, exact targets and explicit confirmations. */
import { useRef, useState } from 'react'
import { Box, Text, useBoxMetrics, useInput, useWindowSize } from 'ink'
import type { DOMElement } from 'ink'
import stringWidth from 'string-width'
import { plainText } from './text.js'
import { ResultPanel } from './panels.js'

export interface PickerItem<T> { readonly label: string; readonly value: T }

/**
 * Select an explicit value without interpreting user text as a command.
 * @param props Labelled values, selection callback and cancellation.
 * @returns A bounded keyboard menu.
 */
export function Picker<T>(props: { readonly title: string; readonly items: readonly PickerItem<T>[]; readonly onSelect: (value: T) => void; readonly onCancel: () => void; readonly compact?: boolean }) {
  const [selected, setSelected] = useState(0), { columns } = useWindowSize(), viewport = useRef<DOMElement | null>(null), metrics = useBoxMetrics(viewport)
  const count = Math.max(1, Math.floor(metrics.clientHeight)), first = Math.max(0, selected - count + 1)
  const selectedLabel = plainText(props.items[selected]?.label ?? ''), detail = !props.compact && (selectedLabel.includes('\n') || stringWidth(selectedLabel) > columns)
  useInput((input, key) => {
    if (key.escape) props.onCancel()
    else if (key.upArrow) setSelected(current => Math.max(0, current - 1))
    else if (key.downArrow) setSelected(current => Math.min(props.items.length - 1, current + 1))
    else if (key.return && props.items[selected] !== undefined) props.onSelect(props.items[selected]!.value)
    else if (key.ctrl && input === 'c') return
  })
  return <Box flexDirection="column" flexGrow={props.compact ? 0 : 1} flexBasis={props.compact ? undefined : 0} flexShrink={0} minHeight={3}>
    <Box flexShrink={0}><Text bold wrap="truncate">{plainText(props.title)}</Text></Box>
    <Box ref={viewport} flexDirection="column" flexGrow={props.compact ? 0 : 1} flexBasis={props.compact ? undefined : 0}
      {...(props.compact ? { height: Math.max(1, props.items.length) } : {})} minHeight={1} overflowY="hidden">
      {props.items.length === 0 && <Text>没有可选目标</Text>}
      {props.items.slice(first, first + count).map((item, index) => <Text key={first + index} inverse={first + index === selected} wrap="truncate">{plainText(item.label).replaceAll('\n', ' ')}</Text>)}
    </Box>
    {detail && <Box flexDirection="column" height={5} flexShrink={0}><ResultPanel label="所选目标全文" text={selectedLabel} maxTextBytes={65536} secrets={[]} /></Box>}
    <Box flexShrink={0}><Text dimColor wrap="truncate">{selected + 1}/{props.items.length} · ↑↓ 选择 · Enter 确认 · Esc 返回</Text></Box>
  </Box>
}
