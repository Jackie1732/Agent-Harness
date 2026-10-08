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
import { initializeHost } from '../src/host/initialization.js'
import { decodeHostConfig, resolveHostConfig } from '../src/host/config.js'
import { hostConfig } from './host/fixtures.js'
import { deferred, sendTui, tuiStreams } from './step15-tui-streams.js'

it.each([['Escape', '\u001b'], ['page navigation', '2']])('joins a retiring event follower before restarting after %s and before final closing', async (_label, stopKey) => {
  const directory = await mkdtemp(join(tmpdir(), 'step15-tui-events-')), profilePath = join(directory, 'operator.json')
  const config = hostConfig(join(directory, 'store')), io = tuiStreams(), signals = new EventEmitter()
  await initializeHost(resolveHostConfig(decodeHostConfig(config, directory)))
  await writeFile(join(directory, 'host.json'), JSON.stringify(config))
  const profile = buildOperatorProfile({ kind: 'local', hostConfig: './host.json', shutdownMode: 'drain' })
  await writeFile(profilePath, JSON.stringify({ ...profile, observation: { ...profile.observation, pollIntervalMs: 25 } }))
  const rendered = deferred<Instance>(), stopped = deferred<void>(), entered = [deferred<void>(), deferred<void>()], release = [deferred<void>(), deferred<void>()]
  let eventReads = 0, checkpointCalls = 0, activeCheckpoints = 0, maximumCheckpoints = 0, settledCheckpoints = 0, ended = false
  const running = runTui(profilePath, io, {}, { signals, render: (node, options) => {
    const instance = render(node, { ...options, interactive: true }); rendered.resolve(instance); return instance
  }, openSession: async (path, options) => {
    const session = await openOperatorSession(path, options), execute = session.execute.bind(session), checkpoint = session.checkpoint.bind(session)
    session.execute = (method, params, call) => {
      if (method === 'session.events' && ++eventReads === 1) call?.signal?.addEventListener('abort', () => stopped.resolve(), { once: true })
      return execute(method, params, call)
    }
    session.checkpoint = async (sessionId, sequence) => {
      const index = checkpointCalls++
      activeCheckpoints++; maximumCheckpoints = Math.max(maximumCheckpoints, activeCheckpoints)
      try {
        await checkpoint(sessionId, sequence)
        entered[index]?.resolve(); await release[index]?.promise
      } finally { activeCheckpoints--; settledCheckpoints++ }
    }
    return session
  } }).then(code => { ended = true; return code })
  const instance = await rendered.promise, send = (data: string) => sendTui(io.stdin, instance, data)
  const follow = async () => { for (const data of ['e', '\u001b[B', '\r', '\u0013', '\r']) await send(data) }
  try {
    await expect.poll(() => io.stdout.frames).toContain('test-host')
    await follow(); await entered[0]!.promise
    io.stdout.frames = ''; await send(stopKey!); await stopped.promise; await instance.waitUntilRenderFlush()
    if (stopKey === '\u001b') expect(io.stdout.frames).toContain('STALE · 保留上次核验事实')
    await follow()
    expect(eventReads).toBe(1); expect(checkpointCalls).toBe(1); expect(activeCheckpoints).toBe(1)
    io.stdout.frames = ''; release[0]!.resolve()
    await entered[1]!.promise; await instance.waitUntilRenderFlush()
    expect(maximumCheckpoints).toBe(1); expect(settledCheckpoints).toBe(1)
    expect(io.stdout.frames).toContain('观察中')
    expect(io.stdout.frames).not.toContain('跟随停止 · signal')
    await send('q'); await send('\r')
    await expect.poll(() => io.stdin.raw.at(-1)).toBe(false)
    expect(ended).toBe(false); expect(activeCheckpoints).toBe(1)
    release[1]!.resolve(); expect(await running).toBe(0)
    expect(settledCheckpoints).toBe(2); expect(activeCheckpoints).toBe(0)
    expect(signals.listenerCount('SIGINT')).toBe(0)
  } finally {
    release.forEach(gate => gate.resolve()); signals.emit('SIGTERM'); await running
    io.destroy(); await rm(directory, { recursive: true, force: true })
  }
})
