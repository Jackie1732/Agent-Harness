/** Structured edits record the same typed operations used by the configuration CLI. */
import { useRef, useState } from 'react'
import { Box, Text, useBoxMetrics, useInput } from 'ink'
import type { DOMElement } from 'ink'
import type { JsonObject, JsonValue } from '../foundation/json.js'
import { applyConfigTreeOperations } from '../operator/config-tree.js'
import type { ConfigOperation } from '../operator/config-types.js'
import { DraftInput } from './input.js'
import { Picker } from './picker.js'
import { VALUE_TYPES, emptyValue, isContainer, pointerSegment, rowSummary, schemaSeed, treeRows, valueType } from './tree-model.js'
import type { TreeRow, ValueType } from './tree-model.js'
import { displayValue, plainText } from './text.js'
import { ResultPanel } from './panels.js'

type FieldEdit = { readonly kind: 'scalar'; readonly row: TreeRow }
  | { readonly kind: 'insert'; readonly row: TreeRow }
  | { readonly kind: 'type'; readonly row: TreeRow; readonly insertion?: string }
  | { readonly kind: 'choices'; readonly row: TreeRow; readonly choices: readonly JsonValue[] }

const hints: Readonly<Record<string, string>> = {
  credentialRef: '环境凭据名称；只保存引用', endpoint: 'Provider 请求地址；保存后需重新接入',
  sessionId: '持久 Session 身份；config plan 分配尚缺身份', root: '相对当前配置目录解析的存储路径',
  schema: '消息/工具的 inline JSON schema；用对象/数组节点增删建立', budget: '显式资源额度；0 也有领域含义',
  expectedInstanceId: '当前已观察实例；旧值不会自动替换', submissionKey: '当前 caller 的持久输入去重键',
  requestKey: '原领域控制请求键', parentRoot: '精确父 Root 事件引用', wait: '精确 user wait 的 eventId/index',
  payloadJson: '消息内容结构；提交时编码为原 payloadJson 字符串',
}

function schemaAt(schema: JsonObject | undefined, pointer: string, candidate: JsonValue): JsonObject | undefined {
  let current = schema, node = candidate
  for (const part of pointer.split('/').slice(1)) {
    if (current === undefined) return undefined
    const variants = current.oneOf ?? current.anyOf
    if (Array.isArray(variants)) current = variants.find(variant => {
      if (variant === null || typeof variant !== 'object' || Array.isArray(variant)) return false
      const properties = variant.properties
      return isContainer(node) && properties !== null && typeof properties === 'object' && !Array.isArray(properties)
        && Object.entries(properties).every(([key, property]) => property === null || typeof property !== 'object' || Array.isArray(property)
          || !Object.hasOwn(property, 'const') || (node as JsonObject)[key] === (property as JsonObject).const)
    }) as JsonObject | undefined ?? variants[0] as JsonObject
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~')
    current = Array.isArray(node) ? current?.items as JsonObject | undefined : (current?.properties as JsonObject | undefined)?.[key] as JsonObject | undefined
    node = isContainer(node) ? (node as JsonObject)[key] ?? null : null
  }
  return current
}

export interface TreeEditorProps {
  readonly title: string
  readonly initial: JsonValue
  readonly schema?: JsonObject
  readonly maxTextBytes: number
  readonly secrets?: readonly string[]
  readonly submitLabel?: string
  readonly onSubmit: (candidate: JsonValue, operations: readonly ConfigOperation[]) => void
  readonly onCancel: () => void
}

/**
 * Edit every JSON value type, including nested arrays, without a JSON text buffer.
 * @param props Original candidate, optional owner metadata and explicit publication callback.
 * @returns A navigation tree, scalar fields, structural operations and a final preview.
 */
export function TreeEditor(props: TreeEditorProps) {
  const [candidate, setCandidate] = useState(props.initial), [operations, setOperations] = useState<readonly ConfigOperation[]>([])
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set([''])), [selected, setSelected] = useState(0)
  const [edit, setEdit] = useState<FieldEdit | null>(null), [preview, setPreview] = useState(false), [error, setError] = useState<string | null>(null)
  const viewport = useRef<DOMElement | null>(null), metrics = useBoxMetrics(viewport), rows = treeRows(candidate, expanded), row = rows[Math.min(selected, rows.length - 1)]!
  const pageRows = Math.max(1, Math.floor(metrics.clientHeight)), first = Math.max(0, Math.min(selected, rows.length - 1) - pageRows + 1)
  const append = (operation: ConfigOperation) => {
    try {
      setCandidate(applyConfigTreeOperations(candidate, [operation])); setOperations([...operations, operation]); setEdit(null); setError(null)
    } catch { setError('结构操作无效；检查指针、已有键和数组索引') }
  }
  const toggle = () => setExpanded(current => {
    const next = new Set(current); if (next.has(row.pointer)) next.delete(row.pointer); else next.add(row.pointer); return next
  })
  useInput((input, key) => {
    if (key.escape) { if (preview) setPreview(false); else props.onCancel(); return }
    if (preview) {
      if (key.return) props.onSubmit(candidate, operations)
      return
    }
    if (key.ctrl && input === 's') { setPreview(true); return }
    if (key.upArrow) setSelected(current => Math.max(0, current - 1))
    else if (key.downArrow) setSelected(current => Math.min(rows.length - 1, current + 1))
    else if (key.pageUp) setSelected(current => Math.max(0, current - pageRows))
    else if (key.pageDown) setSelected(current => Math.min(rows.length - 1, current + pageRows))
    else if (key.leftArrow) {
      if (expanded.has(row.pointer) && isContainer(row.value)) toggle()
      else setSelected(Math.max(0, rows.findIndex(item => item.pointer === row.pointer.slice(0, row.pointer.lastIndexOf('/')))))
    } else if (key.rightArrow && isContainer(row.value)) toggle()
    else if (key.return) {
      const schema = schemaAt(props.schema, row.pointer, candidate)
      if (Array.isArray(schema?.enum)) setEdit({ kind: 'choices', row, choices: schema.enum })
      else if (isContainer(row.value)) toggle()
      else if (typeof row.value === 'boolean') append({ op: 'set', pointer: row.pointer, value: !row.value })
      else if (row.value === null) setEdit({ kind: 'type', row })
      else setEdit({ kind: 'scalar', row })
    } else if (input === 'i' && isContainer(row.value)) setEdit({ kind: 'insert', row })
    else if (input === 't') setEdit({ kind: 'type', row })
    else if (input === 'd' && row.pointer !== '') append({ op: 'remove', pointer: row.pointer })
    else if (input === 'v') {
      const schema = schemaAt(props.schema, row.pointer, candidate), variants = schema?.oneOf ?? schema?.anyOf
      if (Array.isArray(variants)) setEdit({ kind: 'choices', row, choices: variants.map(value => schemaSeed(value as JsonObject)) })
      else setError('此节点无 schema 分支说明；仍可用 t/i/d 编辑完整结构')
    }
  }, { isActive: edit === null })
  if (edit?.kind === 'scalar') return <Box flexDirection="column">{error !== null && <Text color="red">{error}</Text>}<DraftInput key={edit.row.pointer} label={`${edit.row.pointer} (${valueType(edit.row.value)})`}
    initial={String(edit.row.value)} secrets={props.secrets ?? []} multiline={typeof edit.row.value === 'string' && String(edit.row.value).includes('\n')}
    onCancel={() => setEdit(null)} onConfirm={text => {
      if (typeof edit.row.value === 'number') {
        if (text.trim().length === 0 || !Number.isFinite(Number(text))) { setError('数值必须是有限数'); return }
        append({ op: 'set', pointer: edit.row.pointer, value: Number(text) })
      } else append({ op: 'set', pointer: edit.row.pointer, value: text })
    }} /></Box>
  if (edit?.kind === 'insert') return <DraftInput label={Array.isArray(edit.row.value) ? '插入索引（0..length 或 - 追加）' : '新字段名称'}
    initial={Array.isArray(edit.row.value) ? '-' : ''} secrets={props.secrets ?? []} onCancel={() => setEdit(null)}
    onConfirm={key => setEdit({ kind: 'type', row: edit.row, insertion: edit.row.pointer + '/' + pointerSegment(key) })} />
  if (edit?.kind === 'type') return <Picker title="选择值类型（对象/数组内容随后用 i 增加）" items={VALUE_TYPES.map(type => ({ label: type, value: type }))}
    onCancel={() => setEdit(null)} onSelect={(type: ValueType) => {
      const pointer = edit.insertion ?? edit.row.pointer
      append({ op: edit.insertion === undefined ? 'set' : 'insert', pointer, value: emptyValue(type) })
      if (type === 'object' || type === 'array') setExpanded(current => new Set([...current, pointer]))
    }} />
  if (edit?.kind === 'choices') return <Picker title="选择 schema 值或分支" items={edit.choices.map(value => ({ label: displayValue(value, 512, props.secrets), value }))}
    onCancel={() => setEdit(null)} onSelect={value => append({ op: 'set', pointer: edit.row.pointer, value })} />
  return <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={3}>
    <Box flexShrink={0}><Text bold wrap="truncate">{plainText(props.title, props.secrets)}</Text></Box>
    {preview ? <><Box flexDirection="column" flexShrink={0}><Text color="yellow">候选预览 · {operations.length} 项结构操作</Text>
      <Text color="yellow">Enter {props.submitLabel ?? '采用'} · Esc 继续编辑</Text></Box>
      <ResultPanel label="候选数据" result={candidate} maxTextBytes={props.maxTextBytes} secrets={props.secrets ?? []} scrollArrows /></>
      : <><Box ref={viewport} flexDirection="column" flexGrow={1} flexBasis={0} minHeight={1} overflowY="hidden">{rows.slice(first, first + pageRows).map((item, index) => <Text key={item.pointer} inverse={first + index === Math.min(selected, rows.length - 1)} wrap="truncate">
        {'  '.repeat(item.depth)}{isContainer(item.value) ? expanded.has(item.pointer) ? '▾ ' : '▸ ' : '  '}{plainText(item.label, props.secrets)}: {isContainer(item.value) ? rowSummary(item) : displayValue(item.value, props.maxTextBytes, props.secrets)}
      </Text>)}</Box><Box flexDirection="column" flexShrink={0}>
      <Text color="cyan" wrap="truncate">{plainText(row.pointer || '(根)', props.secrets)} · {hints[row.label] ?? '完整字段；保存时由原配置/协议解析器验证'}</Text>
      <Text dimColor wrap="truncate">↑↓/PgUp/PgDn 选择 · ←→ 展开 · Enter 编辑</Text><Text dimColor wrap="truncate">i 新增 · d 删除 · t 类型 · v schema分支</Text><Text dimColor wrap="truncate">Ctrl+S 预览 · Esc 放弃</Text></Box></>}
    {error !== null && <Text color="red">{error}</Text>}
  </Box>
}
