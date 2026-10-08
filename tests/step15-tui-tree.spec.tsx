import { render, renderToString } from 'ink'
import { expect, it } from 'vitest'
import type { JsonValue } from '../src/foundation/json.js'
import type { ConfigOperation } from '../src/operator/config-types.js'
import { TreeEditor } from '../src/tui/tree.js'
import { DraftInput } from '../src/tui/input.js'
import { tuiStreams, sendTui } from './step15-tui-streams.js'

it('edits nested arrays and typed scalar fields through real Ink input without JSON text', async () => {
  const io = tuiStreams(), submitted: { candidate: JsonValue; operations: readonly ConfigOperation[] }[] = []
  const original = { list: [] }
  const instance = render(<TreeEditor title="完整结构" initial={original} maxTextBytes={65536}
    onSubmit={(candidate, operations) => submitted.push({ candidate, operations })} onCancel={() => undefined} />,
    { ...io, interactive: true, exitOnCtrlC: false, patchConsole: false })
  const send = (data: string) => sendTui(io.stdin, instance, data)
  try {
    await instance.waitUntilRenderFlush()
    await send('\u001b[B'); await send('i'); await send('\r')
    await send('\u001b[B'); await send('\r')
    await send('\u001b[C'); await send('\u001b[B'); await send('\r')
    await send('\u007f'); await send('42'); await send('\r')
    await send('\u0013')
    expect(submitted).toEqual([])
    expect(io.stdout.frames).toContain('候选预览')
    await send('\r')
    expect(submitted).toEqual([{ candidate: { list: [42] }, operations: [
      { op: 'insert', pointer: '/list/-', value: 0 }, { op: 'set', pointer: '/list/0', value: 42 },
    ] }])
    expect(original).toEqual({ list: [] })
  } finally { instance.unmount(); await instance.waitUntilExit(); io.destroy() }
})

it('offers owner schema branches and preserves the chosen complete structure', async () => {
  const io = tuiStreams(), values: JsonValue[] = []
  const schema = { oneOf: [
    { type: 'object', properties: { kind: { const: 'first' }, nested: { type: 'array' } }, required: ['kind', 'nested'] },
    { type: 'object', properties: { kind: { const: 'second' }, budget: { type: 'number', minimum: 7 } }, required: ['kind', 'budget'] },
  ] }
  const instance = render(<TreeEditor title="原协议参数" initial={{ kind: 'first', nested: [] }} schema={schema} maxTextBytes={65536}
    onSubmit={candidate => values.push(candidate)} onCancel={() => undefined} />, { ...io, interactive: true, exitOnCtrlC: false, patchConsole: false })
  try {
    await instance.waitUntilRenderFlush()
    for (const data of ['v', '\u001b[B', '\r', '\u0013', '\r']) await sendTui(io.stdin, instance, data)
    expect(values).toEqual([{ kind: 'second', budget: 7 }])
  } finally { instance.unmount(); await instance.waitUntilExit(); io.destroy() }
})

it('hides invocation credentials in editable drafts while confirmation retains original bytes', async () => {
  const secret = 'SENTINEL-secret-中', original = `before ${secret} after`, io = tuiStreams(), values: string[] = []
  const snapshot = renderToString(<DraftInput label="任务" initial={original} secrets={[secret]} onConfirm={() => undefined} onCancel={() => undefined} />)
  expect(snapshot).not.toContain(secret)
  const instance = render(<DraftInput label="任务" initial={original} secrets={[secret]} onConfirm={value => values.push(value)} onCancel={() => undefined} />,
    { ...io, interactive: true, exitOnCtrlC: false, patchConsole: false })
  try {
    await instance.waitUntilRenderFlush(); await sendTui(io.stdin, instance, '\r')
    expect(values).toEqual([original]); expect(io.stdout.frames).not.toContain(secret); expect(io.stderr.frames).not.toContain(secret)
  } finally { instance.unmount(); await instance.waitUntilExit(); io.destroy() }
})
