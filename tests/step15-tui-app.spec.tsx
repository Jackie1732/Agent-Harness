import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink'
import type { Instance } from 'ink'
import { expect, it } from 'vitest'
import { runTui } from '../src/tui/lifecycle.js'
import { buildOperatorProfile } from '../src/operator/profile.js'
import { openOperatorSession } from '../src/operator/session.js'
import type { OperatorSession } from '../src/operator/types.js'
import { initializeHost } from '../src/host/initialization.js'
import { decodeHostConfig, resolveHostConfig } from '../src/host/config.js'
import type { AgentObservation, RootObservation } from '../src/protocol/index.js'
import { hostConfig } from './host/fixtures.js'
import { deferred, sendTui, tuiStreams } from './step15-tui-streams.js'

it('renders all real local pages, submits Chinese multiline text without driving, then runs one explicit batch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'step15-tui-app-')), io = tuiStreams(), signals = new EventEmitter()
  const config = hostConfig(join(directory, 'store')), profilePath = join(directory, 'operator.json')
  await initializeHost(resolveHostConfig(decodeHostConfig(config, directory)))
  await writeFile(join(directory, 'host.json'), JSON.stringify(config))
  const profile = buildOperatorProfile({ kind: 'local', hostConfig: './host.json', shutdownMode: 'drain' })
  await writeFile(profilePath, JSON.stringify({ ...profile, observation: { ...profile.observation, pollIntervalMs: 25 } }))
  const rendered = deferred<Instance>(), opened = deferred<OperatorSession>()
  const running = runTui(profilePath, io, {}, { signals, render: (node, options) => {
    const instance = render(node, { ...options, interactive: true }); rendered.resolve(instance); return instance
  }, openSession: async (path, options) => { const session = await openOperatorSession(path, options); opened.resolve(session); return session } })
  try {
    const instance = await rendered.promise, session = await opened.promise
    await expect.poll(() => io.stdout.frames).toContain('test-host')
    await instance.waitUntilRenderFlush()
    const send = (data: string) => sendTui(io.stdin, instance, data)
    await send('2'); expect(io.stdout.frames).toContain('任务与对话')
    await send('3'); expect(io.stdout.frames).toContain('通信 / Child / Workflow')
    await send('4'); expect(io.stdout.frames).toContain('配置 · 文件保存与运行事实分别显示')
    await send('2'); expect(session.intents()).toEqual([])
    await send('n'); await send('\u001b[200~中文q\r\n👩‍🔬\u001b[201~'); await send('\r')
    expect(session.intents()).toEqual([])
    await send('\u0013')
    await expect.poll(() => session.intents().length).toBe(1)
    expect(session.intents()[0]).toMatchObject({ method: 'input.submit', params: { agentKey: 'writer', text: '中文q\n👩‍🔬\n' } })
    await expect.poll(async () => ((await session.execute('agent.get', { agentKey: 'writer' })).result as AgentObservation).report.counts.pendingInputs).toBe(1)
    expect(session.intents().some(intent => intent.method === 'host.run')).toBe(false)
    await send('b')
    await expect.poll(async () => ((await session.execute('agent.get', { agentKey: 'writer' })).result as AgentObservation).report.final?.text).toBe('fixed answer')
    expect(session.intents().filter(intent => intent.method === 'host.run')).toHaveLength(1)
    const execute = session.execute.bind(session)
    let oldWait = true, rootReads = 0
    session.execute = async (method, params, options) => {
      const result = await execute(method, params, options)
      if (method !== 'root.get' || result.status !== 'ok') return result
      rootReads++
      const root = result.result as RootObservation
      return oldWait ? { ...result, result: { ...root, outcome: null, final: null, waits: [{ reference: { eventId: root.rootId, index: 0 },
        descriptor: { kind: 'user', root: root.rootId, question: '旧cut的等待问题', deadline: '2099-01-01T00:00:00.000Z', observedAt: '2026-01-01T00:00:00.000Z', protectedTurns: [] } }] } } : result
    }
    await send('r'); await send('\r')
    await expect.poll(() => io.stdout.frames).toContain('精确 Root')
    await expect.poll(() => io.stdout.frames).toContain('旧cut的等待问题')
    const priorReads = rootReads
    oldWait = false; await send('a')
    await expect.poll(() => rootReads).toBeGreaterThan(priorReads)
    await expect.poll(() => io.stdout.frames).toContain('仅回答新核验的精确 user wait')
    expect(io.stdout.frames).toContain('没有可选目标')
    await send('\r')
    expect(session.intents().some(intent => intent.method === 'input.answer')).toBe(false)
    io.stdout.frames = ''; await send('\u001b')
    await expect.poll(() => io.stdout.frames).toContain('任务与对话')
    await send('q'); await expect.poll(() => io.stdout.frames).toContain('关闭本端拥有的 Host'); await send('\r')
    expect(await running).toBe(0); expect(io.stdin.raw.at(-1)).toBe(false)
    expect(signals.listenerCount('SIGINT')).toBe(0); expect(io.stdin.listenerCount('readable')).toBe(0)
  } finally { signals.emit('SIGTERM'); await running; io.destroy(); await rm(directory, { recursive: true, force: true }) }
})
