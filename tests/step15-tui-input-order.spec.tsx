import { rm } from 'node:fs/promises'
import { Box, render } from 'ink'
import { expect, it } from 'vitest'
import { EffectOwner } from '../src/effect/owner.js'
import type { JsonObject } from '../src/foundation/json.js'
import { openOperatorSession } from '../src/operator/session.js'
import { TuiApp } from '../src/tui/app.js'
import { Picker } from '../src/tui/picker.js'
import { TreeEditor } from '../src/tui/tree.js'
import { hostConfig } from './host/fixtures.js'
import { localFixture } from './step15-operator-fixture.js'
import { sendTui, tuiStreams } from './step15-tui-streams.js'

function menu(initial: readonly string[]) {
  const io = tuiStreams(), chosen: string[] = []
  const view = (items: readonly string[]) => <Box height={24} width={80} flexDirection="column"><Picker title="精确目标"
    items={items.map(value => ({ label: value, value }))} onSelect={value => chosen.push(value)} onCancel={() => undefined} /></Box>
  const instance = render(view(initial), { ...io, interactive: true, debug: true, exitOnCtrlC: false, patchConsole: false })
  return { chosen, send: (data: string) => sendTui(io.stdin, instance, data), replace: async (items: readonly string[]) => {
    instance.rerender(view(items)); await instance.waitUntilRenderFlush()
  }, ready: () => instance.waitUntilRenderFlush(), dispose: async () => { instance.unmount(); await instance.waitUntilExit(); io.destroy() } }
}

it('confirms the target reached by every direction key in the same input chunk', async () => {
  const f = menu(['first', 'second', 'third'])
  try {
    await f.ready(); await f.send('\u001b[B\u001b[B\r')
    expect(f.chosen).toEqual(['third'])
    await f.send('\u001b[A\u001b[A\u001b[A\r')
    expect(f.chosen).toEqual(['third', 'first'])
  } finally { await f.dispose() }
})

it('confirms only a present Picker target after an empty or shortened list', async () => {
  const f = menu([])
  try {
    await f.ready(); await f.send('\u001b[B\r'); expect(f.chosen).toEqual([])
    await f.replace(['first', 'second', 'third']); await f.send('\u001b[B\u001b[B\r')
    expect(f.chosen).toEqual(['third'])
    await f.replace(['remaining']); await f.send('\u001b[B\r')
    expect(f.chosen).toEqual(['third', 'remaining'])
    await f.replace(['remaining', 'new']); await f.send('\r')
    expect(f.chosen).toEqual(['third', 'remaining', 'remaining'])
  } finally { await f.dispose() }
})

function threeMembers(root: string): JsonObject {
  const config = hostConfig(root), member = (config.members as readonly JsonObject[])[0]!, keys = ['writer', 'reviewer', 'observer']
  return { ...config, members: keys.map((agentKey, index) => ({ ...member, agentKey,
    sessionId: `71000000-0000-4000-8000-${String(index + 101).padStart(12, '0')}`,
    profile: { ...(member.profile as JsonObject), profileKey: `${agentKey}-input-order` },
    model: { ...(member.model as JsonObject), providerId: `${agentKey}-provider` },
  })), routes: keys.map(memberKey => ({ memberKey, ownerHost: config.hostKey!, origin: null, serverName: null })) }
}

async function desk() {
  const f = await localFixture(threeMembers), session = await openOperatorSession(f.profilePath, { lifetime: 'session' })
  const io = tuiStreams(), owner = new EffectOwner('input-order-desk'), abort = new AbortController()
  const instance = render(<TuiApp session={session} owner={owner} signal={abort.signal} secrets={[]} environment={{}}
    onClose={() => undefined} onConfigurationWork={() => undefined} />,
  { ...io, interactive: true, debug: true, exitOnCtrlC: false, patchConsole: false })
  const frame = () => io.stdout.frames.split('Atomic Harness').at(-1)!
  await expect.poll(frame).toContain('选中成员 writer')
  return { session, frame, send: (data: string) => sendTui(io.stdin, instance, data), dispose: async () => {
    abort.abort(); instance.unmount(); await instance.waitUntilExit(); await owner.dispose(); io.destroy()
    await session.close(); await rm(f.directory, { recursive: true, force: true })
  } }
}

it.each(['overview', 'tasks'] as const)('binds a same-chunk new task to the navigated member on %s', async page => {
  const f = await desk()
  try {
    if (page === 'tasks') await f.send('2')
    await f.send('\u001b[B\u001b[Bn'); expect(f.frame()).toContain('新任务 · observer')
    await f.send('当前成员任务'); await f.send('\u0013')
    await expect.poll(() => f.session.intents().find(intent => intent.method === 'input.submit')?.params).toMatchObject({ agentKey: 'observer', text: '当前成员任务' })
    expect(f.session.intents().some(intent => intent.method === 'host.run')).toBe(false)
    await f.send('\u001b[A\u001b[A\u001b[An'); expect(f.frame()).toContain('新任务 · writer')
  } finally { await f.dispose() }
})

it('opens parameters for the collaboration method reached within the same chunk', async () => {
  const f = await desk()
  try {
    await f.send('3'); await f.send('\u001b[B\u001b[B\r')
    expect(f.frame()).toContain('message.get · 原协议完整参数')
    expect(f.session.intents()).toEqual([])
  } finally { await f.dispose() }
})

it('edits and publishes only the scalar reached before same-chunk Enter', async () => {
  const io = tuiStreams(), submitted: unknown[] = [], initial = { first: 'one', second: 'two', third: 'three' }
  const instance = render(<TreeEditor title="输入顺序" initial={initial} maxTextBytes={65536}
    onSubmit={(candidate, operations) => submitted.push({ candidate, operations })} onCancel={() => undefined} />,
  { ...io, interactive: true, debug: true, exitOnCtrlC: false, patchConsole: false })
  const send = (data: string) => sendTui(io.stdin, instance, data)
  try {
    await instance.waitUntilRenderFlush(); await send('\u001b[B'); await send('\u001b[B\u001b[B\u001b[B\r')
    expect(io.stdout.frames).toContain('/third (string)')
    await send('\u007f'.repeat(5)); await send('updated'); await send('\r'); await send('\u0013'); await send('\r')
    expect(submitted).toEqual([{ candidate: { first: 'one', second: 'two', third: 'updated' }, operations: [{ op: 'set', pointer: '/third', value: 'updated' }] }])
    expect(initial).toEqual({ first: 'one', second: 'two', third: 'three' })
  } finally { instance.unmount(); await instance.waitUntilExit(); io.destroy() }
})

it('navigates newly expanded child rows before same-chunk Enter', async () => {
  const io = tuiStreams()
  const instance = render(<TreeEditor title="展开顺序" initial={{ group: { field: 'nested' }, other: 'outside' }} maxTextBytes={65536}
    onSubmit={() => undefined} onCancel={() => undefined} />,
  { ...io, interactive: true, debug: true, exitOnCtrlC: false, patchConsole: false })
  try {
    await instance.waitUntilRenderFlush(); await sendTui(io.stdin, instance, '\u001b[B')
    await sendTui(io.stdin, instance, '\u001b[C\u001b[B\r')
    expect(io.stdout.frames).toContain('/group/field (string)')
  } finally { instance.unmount(); await instance.waitUntilExit(); io.destroy() }
})
