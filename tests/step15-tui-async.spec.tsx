import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { Box, render } from 'ink'
import type { Instance } from 'ink'
import { expect, it, vi } from 'vitest'
import { EffectOwner } from '../src/effect/owner.js'
import { openOperatorSession } from '../src/operator/session.js'
import { readOperatorProfile } from '../src/operator/profile.js'
import type { AgentObservation } from '../src/protocol/index.js'
import { TuiApp } from '../src/tui/app.js'
import { ConfigurationPage } from '../src/tui/configuration.js'
import { runConfigEditor } from '../src/tui/wizards.js'
import { localFixture } from './step15-operator-fixture.js'
import { deferred, sendTui, tuiStreams } from './step15-tui-streams.js'

interface ReadDelivery {
  readonly kind: 'read' | 'diff'
  readonly fail: boolean
  readonly entered: ReturnType<typeof deferred<void>>
  readonly release: ReturnType<typeof deferred<void>>
  readonly done: ReturnType<typeof deferred<void>>
}
const delivery = vi.hoisted(() => ({ current: null as ReadDelivery | null }))
vi.mock('../src/operator/config-operations.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/operator/config-operations.js')>()
  const deliver = async <T,>(kind: ReadDelivery['kind'], value: T): Promise<T> => {
    const pending = delivery.current
    if (pending?.kind !== kind) return value
    delivery.current = null; pending.entered.resolve()
    try { await pending.release.promise; if (pending.fail) throw new Error('delayed-read-failed'); return value }
    finally { pending.done.resolve() }
  }
  return { ...actual,
    readEditableConfigDocument: async (...args: Parameters<typeof actual.readEditableConfigDocument>) => deliver('read', await actual.readEditableConfigDocument(...args)),
    diffConfigCandidate: async (...args: Parameters<typeof actual.diffConfigCandidate>) => deliver('diff', await actual.diffConfigCandidate(...args)),
  }
})

function delayRead(kind: ReadDelivery['kind'], fail = false): ReadDelivery {
  const pending = { kind, fail, entered: deferred<void>(), release: deferred<void>(), done: deferred<void>() }
  delivery.current = pending; return pending
}
async function delivered(pending: ReadDelivery, instance: Instance) {
  pending.release.resolve(); await pending.done.promise; await setImmediate(); await instance.waitUntilRenderFlush()
}

it.each(['ok', 'rejected', 'throw'] as const)('keeps a replacement task draft when a cancelled answer read finishes with %s', async outcome => {
  const f = await localFixture(), session = await openOperatorSession(f.profilePath, { lifetime: 'session' })
  const io = tuiStreams(), owner = new EffectOwner('async-desk'), abort = new AbortController()
  await session.submit({ agentKey: 'writer', text: 'Create a real Root', drive: true })
  const agent = (await session.execute('agent.get', { agentKey: 'writer' })).result as AgentObservation
  const execute = session.execute.bind(session), entered = deferred<void>(), release = deferred<void>(), done = deferred<void>()
  let hold = false
  session.execute = async (method, params, options) => {
    const actual = await execute(method, params, options)
    if (method !== 'root.get' || !hold || options?.signal !== undefined) return actual
    hold = false; entered.resolve()
    try {
      await release.promise
      if (outcome === 'throw') throw new Error('delayed-answer-read-failed')
      return outcome === 'ok' ? actual : { ...actual, status: 'failed', error: { code: 'OPERATOR_FAILED', domainCode: null, message: 'Read failed' } }
    } finally { done.resolve() }
  }
  const instance = render(<TuiApp session={session} owner={owner} signal={abort.signal} secrets={[]} environment={{}}
    onClose={() => undefined} onConfigurationWork={() => undefined} />,
  { ...io, interactive: true, debug: true, exitOnCtrlC: false, patchConsole: false })
  const send = (data: string) => sendTui(io.stdin, instance, data), frame = () => io.stdout.frames.split('Atomic Harness').at(-1)
  try {
    await expect.poll(() => io.stdout.frames).toContain('test-host')
    for (const data of ['2', 'r', '\r']) await send(data)
    await expect.poll(frame).toContain('精确 Root · completed')
    hold = true; await send('a'); await entered.promise
    await expect.poll(frame).toContain('正在核验精确 Root')
    await send('\u001b'); await expect.poll(frame).toContain('任务与对话')
    await send('n'); await expect.poll(frame).toContain('新任务')
    await send('replacement-draft-SENTINEL'); await expect.poll(frame).toContain('replacement-draft-SENTINEL')
    release.resolve(); await done.promise; await setImmediate(); await instance.waitUntilRenderFlush()
    expect(frame()).toContain('replacement-draft-SENTINEL')
    expect(frame()).not.toContain('仅回答新核验')
    expect(session.intents().some(intent => intent.method === 'input.answer')).toBe(false)
    expect(agent.report.roots).toHaveLength(1)
  } finally {
    release.resolve(); abort.abort(); instance.unmount(); await instance.waitUntilExit(); await owner.dispose()
    io.destroy(); await session.close(); await rm(f.directory, { recursive: true, force: true })
  }
})

async function configuration() {
  const f = await localFixture(), profile = (await readOperatorProfile(f.profilePath)).profile, io = tuiStreams()
  const work: Promise<unknown>[] = [], results: unknown[] = []
  const instance = render(<Box width={96} height={32} flexDirection="column"><ConfigurationPage profile={profile} secrets={[]} environment={{}}
    onResult={value => results.push(value)} onEditing={() => undefined} onWork={task => work.push(task)} /></Box>,
  { ...io, interactive: true, debug: true, exitOnCtrlC: false, patchConsole: false })
  await instance.waitUntilRenderFlush()
  return { ...f, hostPath: join(f.directory, 'host.json'), profile, io, instance, work, results, send: (data: string) => sendTui(io.stdin, instance, data), dispose: async () => {
    delivery.current?.release.resolve(); delivery.current = null
    instance.unmount(); await instance.waitUntilExit(); await Promise.allSettled(work); io.destroy(); await rm(f.directory, { recursive: true, force: true })
  } }
}
async function createDraft(f: Awaited<ReturnType<typeof configuration>>) {
  f.io.stdout.frames = ''; await f.send('c')
  await expect.poll(() => f.io.stdout.frames).toContain('完整配置的目标路径')
  await f.send('newdraftXYZ'); await expect.poll(() => f.io.stdout.frames).toContain('newdraftXYZ')
}

it.each([['edit', '\r'], ['plan', 'p'], ['workflow', 'w']])('keeps a new configuration draft when a cancelled %s read completes', async (_label, key) => {
  const f = await configuration(), original = await readFile(f.profilePath), pending = delayRead('read')
  try {
    await f.send(key!); await pending.entered.promise
    f.io.stdout.frames = ''; await f.send('\u001b')
    await expect.poll(() => f.io.stdout.frames).toContain('配置 · 文件保存')
    await createDraft(f); f.io.stdout.frames = ''; await delivered(pending, f.instance)
    expect(f.io.stdout.frames).not.toContain('完整检查并重算 Workflow')
    await f.send('KEEP'); expect(f.io.stdout.frames).toContain('newdraftXYZKEEP')
    expect(await readFile(f.profilePath)).toEqual(original); expect(f.results).toEqual([])
  } finally { pending.release.resolve(); await f.dispose() }
})

it.each([false, true])('keeps a replacement path draft when a cancelled candidate diff completes (failure=%s)', async fail => {
  const f = await configuration(), original = await readFile(f.hostPath), pending = delayRead('diff', fail)
  try {
    await f.send('\r'); await expect.poll(() => f.io.stdout.frames).toContain('revision')
    await f.send('\u0013'); await f.send('\r'); await pending.entered.promise
    f.io.stdout.frames = ''; await f.send('\u001b'); await expect.poll(() => f.io.stdout.frames).toContain('i 新增')
    f.io.stdout.frames = ''; await f.send('\u001b'); await expect.poll(() => f.io.stdout.frames).toContain('配置 · 文件保存')
    await createDraft(f); f.io.stdout.frames = ''; await delivered(pending, f.instance)
    await f.send('KEEP'); expect(f.io.stdout.frames).toContain('newdraftXYZKEEP')
    expect(f.io.stdout.frames).not.toContain('保存此候选')
    expect(await readFile(f.hostPath)).toEqual(original)
    expect(f.results).toEqual([])
  } finally { pending.release.resolve(); await f.dispose() }
})

it('retains all candidate edits when diff is cancelled, another field is changed, and the complete candidate is published', async () => {
  const f = await configuration(), pending = delayRead('diff')
  try {
    await f.send('\r'); await expect.poll(() => f.io.stdout.frames).toContain('revision')
    for (const data of ['\u001b[B', '\u001b[B', '\u001b[B', '\u001b[C', '\u001b[B', '\u001b[B', '\r']) await f.send(data)
    await expect.poll(() => f.io.stdout.frames).toContain('/storage/maxRecordBytes (number)')
    for (const data of ['\u007f'.repeat(7), '1048575', '\r', '\u0013', '\r']) await f.send(data)
    await pending.entered.promise; f.io.stdout.frames = ''; await f.send('\u001b')
    await expect.poll(() => f.io.stdout.frames).toContain('i 新增')
    await delivered(pending, f.instance)
    for (const data of ['\u001b[B', '\u001b[B', '\u001b[B', '\u001b[C', '\u001b[B', '\u001b[B', '\u001b[B', '\r']) await f.send(data)
    await expect.poll(() => f.io.stdout.frames).toContain('/storage/maxLineageDepth (number)')
    for (const data of ['\u007f', '5', '\r', '\u0013', '\r']) await f.send(data)
    await expect.poll(() => f.io.stdout.frames).toContain('保存此候选')
    await f.send('\r'); await expect.poll(() => f.results.length).toBe(1)
    const written = JSON.parse(await readFile(f.hostPath, 'utf8'))
    expect(written.storage).toMatchObject({ maxRecordBytes: 1048575, maxLineageDepth: 5 })
  } finally { pending.release.resolve(); await f.dispose() }
})

it.each([false, true])('keeps an edited finite-wizard scalar when its cancelled diff completes (failure=%s)', async fail => {
  const f = await localFixture(), io = tuiStreams(), running = runConfigEditor(f.profilePath, 'host', io, {}), pending = delayRead('diff', fail)
  const send = (data: string) => { io.stdin.write(data); io.stdin.emit('readable') }
  try {
    await expect.poll(() => io.stdout.frames).toContain('revision')
    send('\u0013'); await expect.poll(() => io.stdout.frames).toContain('候选预览')
    send('\r'); await pending.entered.promise
    io.stdout.frames = ''; send('\u001b'); await expect.poll(() => io.stdout.frames).toContain('i 新增')
    send('\u001b[B'); await expect.poll(() => io.stdout.frames).toContain('/schemaVersion ·')
    send('\u001b[B'); await expect.poll(() => io.stdout.frames).toContain('/hostKey ·')
    send('\r'); await expect.poll(() => io.stdout.frames).toContain('/hostKey (string)')
    send('-SENTINEL'); await expect.poll(() => io.stdout.frames).toContain('test-host-SENTINEL')
    io.stdout.frames = ''; pending.release.resolve(); await pending.done.promise; await setImmediate()
    send('-KEEP'); await expect.poll(() => io.stdout.frames).toContain('test-host-SENTINEL-KEEP')
    expect(io.stdout.frames).not.toContain('候选差异'); expect(io.stdout.frames).not.toContain('CONFIG_IO')
  } finally { pending.release.resolve(); io.stdout.emit('close'); await running; delivery.current = null; io.destroy(); await rm(f.directory, { recursive: true, force: true }) }
})

it('publishes a newer finite-wizard candidate after its replaced check settles', async () => {
  const f = await localFixture(), io = tuiStreams(), running = runConfigEditor(f.profilePath, 'host', io, {}), pending = delayRead('diff')
  const send = (data: string) => { io.stdin.write(data); io.stdin.emit('readable') }
  try {
    await expect.poll(() => io.stdout.frames).toContain('revision')
    send('\u0013'); await expect.poll(() => io.stdout.frames).toContain('候选预览')
    send('\r'); await pending.entered.promise
    io.stdout.frames = ''; send('\u001b'); await expect.poll(() => io.stdout.frames).toContain('i 新增')
    send('\u001b[B'); await expect.poll(() => io.stdout.frames).toContain('/schemaVersion ·')
    send('\u001b[B'); await expect.poll(() => io.stdout.frames).toContain('/hostKey ·')
    send('\u001b[B'); await expect.poll(() => io.stdout.frames).toContain('/storage ·')
    send('\u001b[C'); await expect.poll(() => io.stdout.frames).toContain('maxRecordBytes:')
    send('\u001b[B'); await expect.poll(() => io.stdout.frames).toContain('/storage/root ·')
    send('\u001b[B'); await expect.poll(() => io.stdout.frames).toContain('/storage/maxRecordBytes ·')
    send('\r'); await expect.poll(() => io.stdout.frames).toContain('/storage/maxRecordBytes (number)')
    send('\u007f'.repeat(7)); send('1048575'); send('\r')
    io.stdout.frames = ''; await expect.poll(() => io.stdout.frames).toContain('maxRecordBytes: 1048575')
    send('\u0013'); await expect.poll(() => io.stdout.frames).toContain('候选预览')
    send('\r'); await expect.poll(() => io.stdout.frames).toContain('候选差异')
    pending.release.resolve(); await pending.done.promise; await setImmediate()
    send('\r'); await expect.poll(() => io.stdout.frames).toContain('配置操作结果')
    expect(JSON.parse(await readFile(join(f.directory, 'host.json'), 'utf8')).storage.maxRecordBytes).toBe(1048575)
    send('\r'); expect(await running).toBe(0)
  } finally { pending.release.resolve(); io.stdout.emit('close'); await running; delivery.current = null; io.destroy(); await rm(f.directory, { recursive: true, force: true }) }
})
