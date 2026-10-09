/** One terminal Effect owner restores Ink before joining the existing operation-session owner. */
import type { ReactNode } from 'react'
import { Box, Text, render, useInput, useWindowSize } from 'ink'
import type { Instance, RenderOptions } from 'ink'
import { EffectOwner } from '../effect/owner.js'
import type { EffectLease } from '../effect/types.js'
import type { HostCliIo } from '../host/cli.js'
import { readOperatorProfile } from '../operator/profile.js'
import { readConfigDocument } from '../operator/config-operations.js'
import { openOperatorSession } from '../operator/session.js'
import { operatorFailure } from '../operator/errors.js'
import type { OperatorSession } from '../operator/types.js'
import { TuiApp } from './app.js'
import { CredentialsPrompt, modelCredentialReferences } from './credentials.js'
import { displayValue } from './text.js'

export interface SignalSource {
  on(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}
export interface TerminalLaunchOptions {
  readonly signals?: SignalSource
  readonly render?: (node: ReactNode, options: RenderOptions) => Instance
  readonly openSession?: typeof openOperatorSession
}

function Connecting(props: { readonly onInterrupt: () => void }) {
  useInput((input, key) => { if (key.ctrl && input === 'c') props.onInterrupt() })
  return <Box flexDirection="column"><Text>正在接入所选 profile…</Text><Text dimColor>Ctrl+C 统一关闭</Text></Box>
}

/**
 * Run a long-lived desk with terminal-first teardown and one shared closing settlement.
 * @param profilePath Explicit profile path.
 * @param io Borrowed terminal streams, never closed by this function.
 * @param environment Invocation credential references; process.env is never mutated.
 * @param options Injectable resource constructors for deterministic lifecycle verification.
 * @returns Exit code after Ink, observations, existing session work and signal subscriptions settle.
 */
export async function runTui(profilePath: string, io: HostCliIo, environment: Readonly<Record<string, string | undefined>> = process.env,
  options: TerminalLaunchOptions = {}): Promise<number> {
  if (!(io.stdin as NodeJS.ReadStream).isTTY || !(io.stdout as NodeJS.WriteStream).isTTY) {
    io.stderr.write('tui requires interactive stdin/stdout; use status/task/config commands\n'); return 2
  }
  const loaded = await readOperatorProfile(profilePath), profile = loaded.profile
  const owner = new EffectOwner('tui-terminal'), observing = new AbortController(), signals = options.signals ?? process
  const createRenderer = options.render ?? render, createSession = options.openSession ?? openOperatorSession
  let renderer: Promise<EffectLease<Instance>> | undefined, backend: Promise<EffectLease<OperatorSession>> | undefined, session: OperatorSession | undefined, closing: Promise<void> | undefined, restored = false
  let exitCode = 0, failure: ReturnType<typeof operatorFailure> | undefined, mode: 'drain' | 'cancel' = profile.connection.kind === 'local' ? profile.connection.shutdownMode : 'drain'
  let settle!: () => void
  const ended = new Promise<void>(resolve => { settle = resolve })
  const requestClose = (requestedMode?: 'drain' | 'cancel', code = 0): void => {
    if (requestedMode === 'cancel' || closing !== undefined && code === 130) mode = 'cancel'
    else if (requestedMode !== undefined && closing === undefined) mode = requestedMode
    if (code !== 0 && (exitCode === 0 || code === 130 || code === 143)) exitCode = code
    observing.abort()
    if (closing !== undefined) {
      if (restored && mode === 'cancel' && session !== undefined) void session.close('cancel').catch(() => { if (exitCode === 0) exitCode = 1 })
      return
    }
    closing = (async () => {
      try { if (renderer !== undefined) await renderer.then(value => value.dispose()) }
      catch { if (exitCode === 0) exitCode = 1 }
      restored = true
      try { if (backend !== undefined) await backend.then(value => value.dispose()) }
      catch { if (exitCode === 0) exitCode = 1 }
      try { await owner.dispose() }
      catch { if (exitCode === 0) exitCode = 1 }
      finally { settle() }
    })()
  }
  try {
    await owner.run('terminal-subscriptions', async effect => {
      await effect.apply('signals', () => {
        const interrupt = () => requestClose(undefined, 130), terminate = () => requestClose(undefined, 143)
        signals.on('SIGINT', interrupt); signals.on('SIGTERM', terminate)
        return { interrupt, terminate }
      }, listeners => { signals.off('SIGINT', listeners.interrupt); signals.off('SIGTERM', listeners.terminate) })
      await effect.apply('output-lifetime', () => {
        const fail = () => requestClose(undefined, 1)
        io.stdout.on('error', fail); io.stdout.on('close', fail); io.stderr.on('error', fail); io.stderr.on('close', fail)
        return fail
      }, fail => { io.stdout.off('error', fail); io.stdout.off('close', fail); io.stderr.off('error', fail); io.stderr.off('close', fail) })
    })
    const references = profile.connection.kind === 'local' ? modelCredentialReferences((await readConfigDocument(profilePath, 'host')).value) : []
    const secrets = references.flatMap(reference => environment[reference] === undefined ? [] : [environment[reference]!])
    const missing = references.filter(reference => environment[reference] === undefined)
    let ready!: (values: Readonly<Record<string, string>> | null) => void
    const credentials = new Promise<Readonly<Record<string, string>> | null>(resolve => { ready = resolve })
    const initial = missing.length === 0 ? <Connecting onInterrupt={() => requestClose(undefined, 130)} />
      : <CredentialsPrompt references={missing} onReady={ready} onCancel={() => { ready(null); requestClose() }} onInterrupt={() => { ready(null); requestClose(undefined, 130) }} />
    renderer = owner.run('ink-instance', effect => effect.apply('renderer', () => createRenderer(initial, {
      stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, exitOnCtrlC: false, patchConsole: false, alternateScreen: true,
    }), async instance => { instance.unmount(); await instance.waitUntilExit() }))
    const ink = (await renderer).value
    void ink.waitUntilExit().then(() => requestClose(), () => requestClose(undefined, 1))
    const provided = missing.length === 0 ? {} : await Promise.race([credentials, ended.then(() => null)])
    if (provided !== null && !observing.signal.aborted) {
      const currentEnvironment = { ...environment, ...provided }
      secrets.push(...Object.values(provided))
      backend = owner.run('operator-session', effect => effect.apply('session', () => createSession(profilePath, { lifetime: 'session', environment: currentEnvironment }),
        value => value.close(mode)))
      session = (await backend).value
      if (!observing.signal.aborted) ink.rerender(<TuiApp session={session} owner={owner} signal={observing.signal} secrets={secrets}
        environment={currentEnvironment} onClose={requestClose} onConfigurationWork={task => {
          void owner.run('configuration-call', effect => effect.apply('settlement', () => ({ task: task.then(() => undefined, () => undefined) }), async value => { await value.task }))
            .catch(() => { if (!observing.signal.aborted) requestClose(undefined, 1) })
        }} />)
    }
  } catch (cause) {
    failure = operatorFailure(cause)
    if (!observing.signal.aborted) exitCode = failure.exitCode
    requestClose()
  }
  await ended
  if (failure !== undefined && !io.stderr.destroyed) io.stderr.write(displayValue(failure, profile.output.maxBytes) + '\n')
  return exitCode
}

/**
 * Own a finite configuration dialog without opening a Host or operation journal.
 * @param io Borrowed interactive streams.
 * @param view Builds the dialog from its unified exit callback.
 * @returns Exit code after the renderer and signal subscriptions settle.
 */
export async function runTerminalDialog(io: HostCliIo, view: (finish: (code?: number) => void, track: (task: Promise<unknown>) => void) => ReactNode): Promise<number> {
  if (!(io.stdin as NodeJS.ReadStream).isTTY || !(io.stdout as NodeJS.WriteStream).isTTY) { io.stderr.write('interactive configuration requires a TTY\n'); return 2 }
  const owner = new EffectOwner('tui-configuration'), signals = process
  let exitCode = 0, closing: Promise<void> | undefined, settle!: () => void, renderer: EffectLease<Instance> | undefined
  const ended = new Promise<void>(resolve => { settle = resolve })
  const finish = (code = 0) => {
    if (code !== 0) exitCode = code
    closing ??= (async () => {
      try { await renderer?.dispose() } catch { if (exitCode === 0) exitCode = 1 }
      try { await owner.dispose() } catch { if (exitCode === 0) exitCode = 1 }
    })().finally(settle)
  }
  const track = (task: Promise<unknown>) => { void owner.run('configuration-call', effect => effect.apply('settlement', () => ({ task: task.then(() => undefined, () => undefined) }), async value => { await value.task }))
    .catch(() => finish(1)) }
  try {
    await owner.run('dialog', async effect => {
      await effect.apply('signals', () => {
        const interrupt = () => finish(130), terminate = () => finish(143)
        signals.on('SIGINT', interrupt); signals.on('SIGTERM', terminate); return { interrupt, terminate }
      }, listeners => { signals.off('SIGINT', listeners.interrupt); signals.off('SIGTERM', listeners.terminate) })
      await effect.apply('output-lifetime', () => {
        const fail = () => finish(1); io.stdout.on('error', fail); io.stdout.on('close', fail); io.stderr.on('error', fail); io.stderr.on('close', fail); return fail
      }, fail => { io.stdout.off('error', fail); io.stdout.off('close', fail); io.stderr.off('error', fail); io.stderr.off('close', fail) })
    })
    renderer = await owner.run('ink-instance', async effect => {
      const instance = await effect.apply('renderer', () => render(<DialogControl finish={finish}>{view(finish, track)}</DialogControl>, {
        stdin: io.stdin, stdout: io.stdout, stderr: io.stderr, exitOnCtrlC: false, patchConsole: false, alternateScreen: true,
      }), async value => { value.unmount(); await value.waitUntilExit() })
      void instance.waitUntilExit().then(() => finish(), () => finish(1))
      return instance
    })
  } catch { finish(1) }
  await ended; return exitCode
}

function DialogControl(props: { readonly finish: (code?: number) => void; readonly children: ReactNode }) {
  const { columns, rows } = useWindowSize()
  useInput((input, key) => { if (key.ctrl && input === 'c') props.finish(130) })
  return <Box flexDirection="column" height={Math.max(8, rows)} width={columns}>{props.children}</Box>
}
