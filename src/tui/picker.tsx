/** Keyboard selection shared by field types, exact targets and explicit confirmations. */
import { useState } from 'react'
import { Box, Text, useInput, useWindowSize } from 'ink'
import { plainText } from './text.js'

export interface PickerItem<T> { readonly label: string; readonly value: T }

/**
 * Select an explicit value without interpreting user text as a command.
 * @param props Labelled values, selection callback and cancellation.
 * @returns A bounded keyboard menu.
 */
export function Picker<T>(props: { readonly title: string; readonly items: readonly PickerItem<T>[]; readonly onSelect: (value: T) => void; readonly onCancel: () => void }) {
  const [selected, setSelected] = useState(0), { rows } = useWindowSize()
  const count = Math.max(1, rows - 8), first = Math.max(0, selected - count + 1)
  useInput((input, key) => {
    if (key.escape) props.onCancel()
    else if (key.upArrow) setSelected(current => Math.max(0, current - 1))
    else if (key.downArrow) setSelected(current => Math.min(props.items.length - 1, current + 1))
    else if (key.return && props.items[selected] !== undefined) props.onSelect(props.items[selected]!.value)
    else if (key.ctrl && input === 'c') return
  })
  return <Box flexDirection="column">
    <Text bold>{plainText(props.title)}</Text>
    {props.items.length === 0 && <Text>没有可选目标</Text>}
    {props.items.slice(first, first + count).map((item, index) => <Text key={first + index} inverse={first + index === selected}>{plainText(item.label)}</Text>)}
    <Text dimColor>↑↓ 选择 · Enter 确认 · Esc 返回 · {selected + 1}/{props.items.length}</Text>
  </Box>
}
