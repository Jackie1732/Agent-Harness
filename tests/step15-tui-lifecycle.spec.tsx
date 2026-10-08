import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink'
import type { Instance } from 'ink'
import { expect, it } from 'vitest'
import { runTui } from '../src/tui/lifecycle.js'
import { buildOperatorProfile, readOperatorProfile } from '../src/operator/profile.js'
import { buildHostPreset } from '../src/operator/config-presets.js'
import type { OperatorSession } from '../src/operator/types.js'
import { tuiStreams, deferred, sendTui } from './step15-tui-streams.js'

async function fixture(http = false) {
  const directory = await mkdtemp(join(tmpdir(), 'step15-tui-lifetime-')), profilePath = join(directory, 'operator.json')
  await writeFile(join(directory, 'host.json'), JSON.stringify(buildHostPreset(http ? 'solo-http' : 'solo-scripted', {
    hostKey: 'terminal-test', storageRoot: join(directory, 'store'), ...(http ? { http: { kind: 'deepseek', endpoint: 'https://example.test/chat', credentialRef: 'TUI_CREDENTIAL', model: 'model' } } : { text: 'fixed' }),
  }, directory)))
  await writeFile(profilePath, JSON.stringify(buildOperatorProfile({ kind: 'local', hostConfig: './host.json', shutdownMode: 'drain' })))
  return { directory, profilePath }
}

it('restores and flushes the terminal before joining Host closure, with a second SIGINT upgrading the same close', async () => {
  const f = await fixture(), io = tuiStreams(), signals = new EventEmitter()
  const flushed = deferred<void>(), backendClosed = deferred<void>(), active = deferred<void>(), unmounted = deferred<void>()
  const trace: string[] = [], modes: (string | undefined)[] = []
  const profile = (await readOperatorProfile(f.profilePath)).profile
  const session: OperatorSession = { profile, execute: async () => { throw new Error('No render in this constructor test') },
    submit: async () => { throw new Error('No submit') }, resume: async () => { throw new Error('No resume') }, intents: () => [],
    checkpoint: async () => undefined, eventCheckpoint: () => undefined,
    close: mode => { modes.push(mode); trace.push(`backend:${mode}`); return backendClosed.promise } }
  const instance: Instance = { rerender: () => { active.resolve(); return undefined }, unmount: () => { trace.push('unmount'); unmounted.resolve() },
    waitUntilExit: () => flushed.promise, waitUntilRenderFlush: async () => undefined, cleanup: () => undefined, clear: () => undefined }
  const running = runTui(f.profilePath, io, {}, { signals, render: (_node, options) => {
    expect(options.exitOnCtrlC).toBe(false); expect(options.patchConsole).toBe(false); return instance
  }, openSession: async () => session })
  try {
    await active.promise; signals.emit('SIGINT'); await unmounted.promise
    expect(modes).toEqual([])
    flushed.resolve(); await expect.poll(() => modes).toEqual(['drain'])
    expect(signals.listenerCount('SIGINT')).toBe(1)
    signals.emit('SIGINT'); await expect.poll(() => ({ modes, listeners: signals.listenerCount('SIGINT'), trace })).toEqual({ modes: ['drain', 'cancel'], listeners: 1, trace: ['unmount', 'backend:drain', 'backend:cancel'] })
    expect(signals.listenerCount('SIGINT')).toBe(1)
    backendClosed.resolve(); expect(await running).toBe(130)
    expect(trace[0]).toBe('unmount'); expect(signals.listenerCount('SIGINT')).toBe(0); expect(signals.listenerCount('SIGTERM')).toBe(0)
    expect(io.stdout.listenerCount('error')).toBe(0); expect(io.stderr.listenerCount('error')).toBe(0)
  } finally { flushed.resolve(); backendClosed.resolve(); await running; io.destroy(); await rm(f.directory, { recursive: true, force: true }) }
})

it('cancels a real hidden credential prompt before Host acquisition and restores raw mode', async () => {
  const f = await fixture(true), io = tuiStreams(), signals = new EventEmitter(), ready = deferred<Instance>()
  const secret = 'credential-SENTINEL-中', environment: Record<string, string | undefined> = {}, opened: unknown[] = []
  const running = runTui(f.profilePath, io, environment, { signals, render: (node, options) => {
    const instance = render(node, { ...options, interactive: true }); ready.resolve(instance); return instance
  }, openSession: async (...args) => { opened.push(args); throw new Error('must not acquire Host') } })
  try {
    const instance = await ready.promise; await instance.waitUntilRenderFlush()
    await sendTui(io.stdin, instance, `\u001b[200~${secret}\u001b[201~`)
    await sendTui(io.stdin, instance, '\u001b')
    expect(await running).toBe(0); expect(opened).toEqual([]); expect(environment).toEqual({})
    expect(io.stdout.frames).not.toContain(secret); expect(io.stderr.frames).not.toContain(secret)
    expect(io.stdin.raw.at(-1)).toBe(false); expect(io.stdin.listenerCount('readable')).toBe(0); expect(signals.listenerCount('SIGINT')).toBe(0)
  } finally { signals.emit('SIGTERM'); await running; io.destroy(); await rm(f.directory, { recursive: true, force: true }) }
})

it('prints only safe startup failure evidence after real Ink terminal restoration', async () => {
  const f = await fixture(), io = tuiStreams(), signals = new EventEmitter(), secret = 'private-SENTINEL'
  const running = runTui(f.profilePath, io, {}, { signals, render: (node, options) => render(node, { ...options, interactive: true }),
    openSession: async () => { throw new Error(secret) } })
  try {
    expect(await running).toBe(1); expect(io.stderr.frames).toContain('OPERATOR_FAILED')
    expect(io.stdout.frames + io.stderr.frames).not.toContain(secret); expect(io.stdin.raw.at(-1)).toBe(false)
  } finally { signals.emit('SIGTERM'); await running; io.destroy(); await rm(f.directory, { recursive: true, force: true }) }
})
