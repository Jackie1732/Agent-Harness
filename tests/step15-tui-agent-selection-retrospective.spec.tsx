import { rm } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { render } from 'ink'
import { expect, it } from 'vitest'
import { EffectOwner } from '../src/effect/owner.js'
import type { JsonObject } from '../src/foundation/json.js'
import { openOperatorSession } from '../src/operator/session.js'
import { TuiApp } from '../src/tui/app.js'
import { hostConfig } from './host/fixtures.js'
import { localFixture } from './step15-operator-fixture.js'
import { deferred, sendTui, tuiStreams } from './step15-tui-streams.js'

function threeMembers(root: string): JsonObject {
  const config = hostConfig(root), member = (config.members as readonly JsonObject[])[0]!
  const keys = ['writer', 'reviewer', 'observer']
  return { ...config, members: keys.map((agentKey, index) => ({ ...member, agentKey,
    sessionId: `70000000-0000-4000-8000-${String(index + 101).padStart(12, '0')}`,
    profile: { ...(member.profile as JsonObject), profileKey: `${agentKey}-generation` },
    model: { ...(member.model as JsonObject), providerId: `${agentKey}-provider` },
  })), routes: keys.map(memberKey => ({ memberKey, ownerHost: config.hostKey!, origin: null, serverName: null })) }
}

async function desk(withRoot = false) {
  const f = await localFixture(threeMembers), session = await openOperatorSession(f.profilePath, { lifetime: 'session' })
  const io = tuiStreams(), owner = new EffectOwner('agent-selection-desk'), abort = new AbortController()
  if (withRoot) await session.submit({ agentKey: 'writer', text: '固定已完成 Root', drive: true })
  const originalExecute = session.execute.bind(session), checkpoint = session.checkpoint.bind(session)
  const rootSignals = new Set<AbortSignal>(), eventSignals = new Set<AbortSignal>()
  const pageEntered = deferred<void>(), pageRelease = deferred<void>(), oldReadEntered = deferred<void>(), oldReadRelease = deferred<void>(), oldReadDone = deferred<void>()
  let rootReads = 0, holdRoot = false
  session.execute = async (method, params, options) => {
    if (method === 'root.get' && options?.signal !== undefined) { rootSignals.add(options.signal); rootReads++ }
    if (method === 'session.events' && options?.signal !== undefined) eventSignals.add(options.signal)
    const result = await originalExecute(method, params, options)
    if (method === 'root.get' && options?.signal === undefined && holdRoot) {
      holdRoot = false; oldReadEntered.resolve(); await oldReadRelease.promise; oldReadDone.resolve()
    }
    return result
  }
  session.checkpoint = async (sessionId, sequence) => { await checkpoint(sessionId, sequence); pageEntered.resolve(); await pageRelease.promise }
  const instance = render(<TuiApp session={session} owner={owner} signal={abort.signal} secrets={[]} environment={{}}
    onClose={() => undefined} onConfigurationWork={() => undefined} />,
  { ...io, interactive: true, debug: true, exitOnCtrlC: false, patchConsole: false })
  const send = (data: string) => sendTui(io.stdin, instance, data), frame = () => io.stdout.frames.split('Atomic Harness').at(-1)!
  await expect.poll(frame).toContain('选中成员 writer')
  return { ...f, io, instance, send, frame, rootSignals, eventSignals, rootReads: () => rootReads,
    selectRoot: async () => { for (const data of ['2', 'r', '\r']) await send(data); await expect.poll(frame).toContain('精确 Root · completed') },
    follow: async () => { for (const data of ['e', '\u001b[B', '\r', '\u0013', '\r']) await send(data); await pageEntered.promise },
    holdRoot: () => { holdRoot = true }, oldReadEntered, oldReadRelease, oldReadDone, pageRelease,
    dispose: async () => {
      pageRelease.resolve(); oldReadRelease.resolve(); abort.abort(); instance.unmount(); await instance.waitUntilExit(); await owner.dispose()
      io.destroy(); await session.close(); await rm(f.directory, { recursive: true, force: true })
    } }
}

it.each(['overview', 'tasks'] as const)('accumulates member direction keys from one input chunk on %s', async page => {
  const f = await desk()
  try {
    if (page === 'tasks') await f.send('2')
    await f.send('\u001b[B\u001b[B'); await f.send('n')
    expect(f.frame()).toContain('新任务 · observer')
    await f.send('\u001b'); await expect.poll(f.frame).not.toContain('新任务')
    await f.send('\u001b[A\u001b[A'); await f.send('n')
    expect(f.frame()).toContain('新任务 · writer')
  } finally { await f.dispose() }
})

it('preserves the exact Root and active event observer when an arrow stays at the member boundary', async () => {
  const f = await desk(true)
  try {
    await f.selectRoot(); await f.follow()
    expect(f.rootSignals.size).toBeGreaterThan(0); expect(f.eventSignals.size).toBe(1)
    await f.send('\u001b[A\u001b[A')
    expect([...f.rootSignals, ...f.eventSignals].every(signal => !signal.aborted)).toBe(true)
    expect(f.frame()).toContain('观察中')
    await f.send('\u001b'); f.pageRelease.resolve(); await f.send('2')
    await expect.poll(f.frame).toContain('精确 Root · completed')
  } finally { await f.dispose() }
})

it('retires the old member observers and keeps a delayed old Root receipt from restoring their target', async () => {
  const f = await desk(true)
  try {
    await f.selectRoot(); await f.follow()
    f.holdRoot(); await f.send('r'); await f.send('\r'); await f.oldReadEntered.promise
    await f.send('\u001b[B')
    await expect.poll(() => [...f.rootSignals, ...f.eventSignals].every(signal => signal.aborted)).toBe(true)
    const priorReads = f.rootReads()
    f.oldReadRelease.resolve(); f.pageRelease.resolve(); await f.oldReadDone.promise; await setImmediate(); await f.instance.waitUntilRenderFlush()
    await f.send('2'); await expect.poll(f.frame).toContain('任务与对话 · reviewer')
    expect(f.frame()).not.toContain('精确 Root · completed')
    expect(f.rootReads()).toBe(priorReads)
    await f.send('n'); expect(f.frame()).toContain('新任务 · reviewer')
  } finally { await f.dispose() }
})
