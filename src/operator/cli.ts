import { createInterface } from 'node:readline/promises'
import type { HostCliIo } from '../host/cli.js'
import type { JsonValue } from '../foundation/json.js'
import { unlockHostStorage } from '../host/storage-lock.js'
import { readOperatorProfile } from './profile.js'
import type { ResolvedOperatorProfile } from './profile.js'
import type { ConfigKind } from './config-types.js'
import { CONFIG_KINDS } from './config-check.js'
import { configReadiness } from './config-readiness.js'
import { inspectOperatorJournal } from './intents.js'
import { openOperatorSession } from './session.js'
import type { OperatorResult, OperatorSession, OperatorScope } from './types.js'
import { OperatorError, operatorFailure } from './errors.js'
import { operatorResult, operatorExitCode } from './result.js'
import { parseOperatorArguments, requiredOption, configWrites } from './cli-arguments.js'
import { parseOperatorInput, readOperatorInput } from './cli-input.js'
import { executeOperatorCommand, operatorParams } from './commands.js'
import { operatorJson, operatorOutput } from './cli-output.js'
import { followOperatorEvents } from './observations.js'
import { executeConfigCommand } from './config-cli.js'
import { plainText } from '../tui/text.js'
import type { ControlMethod } from '../protocol/index.js'

const emptyScope: OperatorScope = { connection: null, connectionLifetime: null, hostKey: null, instanceId: null, sessionId: null }
const tty = (io: HostCliIo) => (io.stdin as { isTTY?: boolean }).isTTY === true && (io.stdout as { isTTY?: boolean }).isTTY === true

/** Own parsing, stdout and signal settlement for one explicit human command. */
export async function runOperatorCli(argv: readonly string[], io: HostCliIo,
  environment: Readonly<Record<string, string | undefined>> = process.env): Promise<number> {
  let profile: ResolvedOperatorProfile | null = null, session: OperatorSession | undefined, received: OperatorResult | undefined
  let code = 0, signalCode = 0, interactive = false
  let closeMode: 'drain' | 'cancel' | undefined
  const abort = new AbortController()
  const onInt = () => { if (signalCode !== 0) closeMode = 'cancel'; signalCode = 130; abort.abort(); void session?.close(closeMode).catch(() => undefined) }
  const onTerm = () => { signalCode = 143; abort.abort(); void session?.close().catch(() => undefined) }
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm)
  try {
    const args = parseOperatorArguments(argv), { command, options } = args
    const path = requiredOption(options, '--profile'), isTty = tty(io), json = options.has('--json')
    const kind = options.get('--kind') as ConfigKind | undefined
    if (kind !== undefined && !CONFIG_KINDS.includes(kind)) throw new OperatorError('OPERATOR_USAGE_KIND', 2)
    if (command === 'config.create' && kind === 'operator') throw new OperatorError('OPERATOR_USAGE_OPERATOR_SETUP', 2)
    interactive = command === 'tui' || command === 'config.edit'
      || command === 'setup' && !options.has('--params-stdin') || command === 'config.create' && !options.has('--params-stdin')
      || command === 'config.workflow-bindings' && isTty && !options.has('--ops-stdin') && !options.has('--yes')
    if (interactive && (!isTty || json)) throw new OperatorError('OPERATOR_USAGE_TTY_JSON', 2)
    if (!isTty && configWrites(command, options) && !options.has('--yes')) throw new OperatorError('OPERATOR_USAGE_CONFIRMATION', 2)
    if (interactive) {
      process.off('SIGINT', onInt); process.off('SIGTERM', onTerm)
      const terminal = await import('../tui/index.js')
      return command === 'tui' ? await terminal.runTui(path, io, environment)
        : command === 'setup' ? await terminal.runSetupWizard(path, requiredOption(options, '--mode') as 'local' | 'remote', io, environment)
        : command === 'config.create' ? await terminal.runConfigCreate(path, kind as Exclude<ConfigKind, 'operator'>, requiredOption(options, '--output'), io, environment,
          { ...(options.has('--replace') ? { replace: true } : {}), ...(options.has('--expected-revision') ? { expectedRevision: requiredOption(options, '--expected-revision') } : {}) })
        : command === 'config.workflow-bindings' ? await terminal.runWorkflowBindingsEditor(path, io)
        : await terminal.runConfigEditor(path, kind!, io, environment)
    }
    if (command !== 'setup') profile = (await readOperatorProfile(path)).profile
    closeMode = profile?.connection.kind === 'local' ? profile.connection.shutdownMode : undefined
    if (profile?.connection.kind === 'local' && ['agent.pause', 'agent.resume', 'host.stop'].includes(command)) throw new OperatorError('OPERATOR_LOCAL_INSTANCE_COMMAND', 2)
    const stdin = [...options.keys()].some(key => key.endsWith('-stdin')) ? await readOperatorInput(io.stdin, abort.signal) : null
    const value = stdin === null || options.has('--text-stdin') ? null : parseOperatorInput(stdin)
    const method = (command === 'events' ? 'session.events' : command.replace(/^child\./, 'delegation.')) as ControlMethod
    if (options.has('--params-stdin') && command !== 'setup' && command !== 'config.create') operatorParams(command === 'task.answer' ? 'input.answer' : method, value!)
    if (abort.signal.aborted) throw new OperatorError('OPERATOR_ABORTED', 1)
    if (configWrites(command, options) && isTty && !options.has('--yes')) {
      io.stdout.write(`${plainText(operatorJson(value ?? { command, options: Object.fromEntries(options) }))}\n`)
      const line = createInterface({ input: io.stdin, output: io.stdout })
      try { if ((await line.question('确认保存配置？输入 yes：', { signal: abort.signal })).trim() !== 'yes') throw new OperatorError('OPERATOR_USAGE_CANCELLED', 2) }
      finally { line.close() }
    }
    if (command === 'setup' || command.startsWith('config.')) {
      const completed = await executeConfigCommand(args.words, options, async (): Promise<JsonValue> => value!)
      profile = completed.profile
      if (completed.rawConfig !== null) {
        const write = operatorOutput(io.stdout, true, profile)
        try { await write(completed.rawConfig) } finally { await write.dispose() }
        return 0
      }
      received = operatorResult(command, profile, emptyScope, completed.result)
      const result = completed.result as { readonly failure?: unknown; readonly status?: string }
      const checks = Array.isArray(completed.result) ? completed.result as readonly { readonly status?: string; readonly check?: { readonly status: string } }[] : null
      if (checks?.some(item => item.status === 'invalid')) received = { ...received, status: 'rejected', error: { code: 'OPERATOR_CONFIG_INVALID', domainCode: 'HOST_CONFIG_INVALID', message: 'Declared configuration is invalid' } }
      else if (checks?.some(item => item.check?.status === 'needs-plan' || item.check?.status === 'dependency-needs-plan')) received = { ...received, status: 'pending' }
      else if (result.failure !== undefined && result.failure !== null) received = { ...received, status: 'failed', error: { code: 'OPERATOR_CONFIG_PARTIAL', domainCode: null, message: 'Published files are retained; configuration linking failed' } }
      else if (result.status === 'needs-plan' || result.status === 'dependency-needs-plan' || result.status === 'not-ready') received = { ...received, status: 'pending' }
      received = { ...received, closing: { status: 'not-owned', mode: null } }
    } else if (command === 'intent.get' || command === 'journal.inspect' || command === 'journal.unlock') {
      let result: unknown
      if (command === 'journal.unlock') { await unlockHostStorage(profile!.journal.root, { predecessorStopped: true, expectedToken: requiredOption(options, '--expected-token') }); result = { status: 'unlocked' } }
      else {
        const facts = await inspectOperatorJournal(profile!), id = options.get('--id')
        result = id === undefined ? facts : facts.filter(fact => (fact.kind === 'prepared' && (fact.intent as { id: string }).id === id) || fact.intentId === id)
        if (id !== undefined && (result as readonly unknown[]).length === 0) throw new OperatorError('OPERATOR_INTENT_INVALID', 2)
      }
      received = { ...operatorResult(command, profile, emptyScope, result), closing: { status: 'not-owned', mode: null } }
    } else if (command === 'connection.probe' && profile!.connection.kind === 'local') {
      const result = await configReadiness(path, 'host')
      received = { ...operatorResult(command, profile, emptyScope, result), status: result.status === 'ready' ? 'ok' : 'pending', closing: { status: 'not-owned', mode: null } }
    } else {
      session = await openOperatorSession(path, { lifetime: command === 'events' && options.has('--follow') ? 'session' : 'command', environment })
      if (abort.signal.aborted) throw new OperatorError('OPERATOR_ABORTED', 1)
      if (command === 'events' && options.has('--follow')) {
        const write = operatorOutput(io.stdout, json, profile)
        try {
          const summary = await followOperatorEvents(session, operatorParams('session.events', value!), page => write({ ...page, command }), { signal: abort.signal })
          received = operatorResult(command, profile, { ...emptyScope, connection: profile!.connection.kind, connectionLifetime: 'session', sessionId: summary.lastSessionId }, summary)
          if (summary.stoppedBy === 'output-failure' || summary.stoppedBy === 'read-failure') received = { ...received, status: 'failed', error: { code: 'OPERATOR_FOLLOW_FAILED', domainCode: null, message: summary.stoppedBy } }
        } finally { await write.dispose() }
      } else received = await executeOperatorCommand(session, args, stdin, abort.signal)
    }
  } catch (error) {
    const failure = operatorFailure(error)
    code = failure.exitCode
    received = operatorResult(argv.slice(0, 2).filter(arg => !arg.startsWith('--')).join('.'), profile, emptyScope, null, null, error)
    if (interactive) io.stderr.write(`${operatorJson(received.error)}\n`)
  } finally {
    if (session !== undefined) {
      try { await session.close(closeMode); if (received !== undefined && profile?.connection.kind === 'local') received = { ...received, closing: { status: 'released', mode: closeMode ?? profile.connection.shutdownMode } } }
      catch {
        code = code === 4 ? 4 : 1
        if (received !== undefined) received = { ...received, status: 'failed', closing: { status: profile?.connection.kind === 'local' ? 'failed' : 'not-owned', mode: profile?.connection.kind === 'local' ? profile.connection.shutdownMode : null }, error: received.error ?? { code: 'OPERATOR_CLOSE_FAILED', domainCode: null, message: 'Owned resources did not release successfully' } }
      }
    } else if (received !== undefined) received = { ...received, closing: { status: 'not-owned', mode: null } }
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm)
  }
  if (received !== undefined) {
    const write = operatorOutput(io.stdout, argv.includes('--json'), profile)
    try { await write(received) } catch { code = code === 4 ? 4 : 1 }
    finally { try { await write.dispose() } catch { code = code === 4 ? 4 : 1 } }
    const resultCode = operatorExitCode(received)
    code = resultCode === 4 ? 4 : code === 0 ? resultCode : code
  }
  return signalCode || code
}

export const operatorHelp = `
Human commands (each requires --profile <operator.json>):
  setup --mode local|remote, tui, status, connection probe
  config create|link|show|check|readiness|set|apply|edit|import|export|diff|plan|clone|workflow-bindings
  task submit|answer|get, run-once, agent pause|resume, host stop
  root get|wait|cancel, message send|reply|get|wait, child spawn|get|wait|cancel
  workflow get|wait|pause|resume|cancel|retry|output|artifact, events [--follow]
  intent get|resume --id <intent>, journal inspect|unlock
  Structured operations take --params-stdin; task submit takes --text or --text-stdin.
  Use --json for operator-result@1. Noninteractive configuration writes require --yes.
`
