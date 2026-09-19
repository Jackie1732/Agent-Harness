import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { HARNESS_VERSION } from '../version.js'
import type { JsonValue } from '../foundation/json.js'
import { HarnessError } from '../foundation/error.js'
import { parseSessionEventId } from '../session/ids.js'
import type { SessionEventId } from '../session/ids.js'
import { boundedJsonLines, createJsonLineWriter } from './cli-io.js'
import { isLocalHostMember, parseHostConfig, planHostConfig, resolveHostConfig } from './config.js'
import type { HostConfig, ResolvedHostSpec } from './config.js'
import { HostError } from './errors.js'
import { initializeHost } from './initialization.js'
import { inspectHost } from './inspection.js'
import { openHost } from './runtime.js'
import type { AtomicHost } from './runtime.js'
import { unlockHostStorage } from './storage-lock.js'
import { recoverHost } from './recovery.js'

export interface HostCliIo {
  readonly stdin: Readable
  readonly stdout: Writable
  readonly stderr: Writable
}

const help = `atomic-harness <command> --config <path>

Commands:
  check      validate and resolve a saved configuration
  plan       allocate null local Session and Channel identities
  init       initialize configured Sessions; add --resume for an interrupted prefix
  inspect    read persisted Host and Agent facts without loading Providers
  recover    reconcile interrupted facts after explicit predecessor-stop confirmation
  run        accept JSONL commands from stdin and perform a finite drain at EOF
  serve      accept JSONL commands and continue until shutdown or a process signal
  unlock     remove a residual root marker with --predecessor-stopped --expected-token <token>
  version    print the package version
  help       print this help
`

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new HostError('HOST_CONFIG_INVALID', `missing-${name.slice(2)}`)
  return value
}

function flag(args: readonly string[], name: string): boolean { return args.includes(name) }

function integerOption(args: readonly string[], name: string): number {
  const value = Number(option(args, name))
  if (!Number.isSafeInteger(value) || value < 0) throw new HostError('HOST_CONFIG_INVALID', `invalid-${name.slice(2)}`)
  return value
}

async function loadConfig(pathInput: string): Promise<HostConfig> {
  const path = resolve(pathInput)
  const bytes = await readFile(path)
  if (bytes.byteLength > 2 * 1024 * 1024) throw new HostError('HOST_CONFIG_INVALID', 'config-file-too-large')
  return parseHostConfig(bytes.toString('utf8'), dirname(path))
}

function object(value: unknown): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new HostError('HOST_PROTOCOL_INVALID', 'cli-command-object')
  return value as Record<string, JsonValue>
}

function exact(input: Record<string, JsonValue>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(input, key)) || Object.keys(input).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new HostError('HOST_PROTOCOL_INVALID', 'cli-command-fields')
  }
}

function text(input: JsonValue | undefined, label: string, maximum = 65536): string {
  if (typeof input !== 'string' || input.length === 0 || Buffer.byteLength(input) > maximum) throw new HostError('HOST_PROTOCOL_INVALID', label)
  return input
}

function eventId(input: JsonValue | undefined, label: string): SessionEventId {
  const value = text(input, label)
  parseSessionEventId(value)
  return value as SessionEventId
}

interface CliCommandEnvelope {
  readonly input: Record<string, JsonValue>
  readonly requestId: string
  readonly kind: string
}

function commandEnvelope(value: unknown): CliCommandEnvelope {
  const input = object(value)
  if (input.protocolVersion !== 1) throw new HostError('HOST_PROTOCOL_INVALID', 'cli-protocol-version')
  return { input, requestId: text(input.requestId, 'cli-request-id', 128), kind: text(input.kind, 'cli-command-kind', 64) }
}

async function executeCommand(host: AtomicHost, value: unknown): Promise<unknown> {
  const { input, requestId, kind } = commandEnvelope(value)
  const response = (value: Record<string, unknown>) => ({ protocolVersion: 1, requestId, ...value })
  switch (kind) {
    case 'task': {
      exact(input, ['protocolVersion', 'requestId', 'kind', 'agentKey', 'text'])
      const receipt = await host.submitTask(text(input.agentKey, 'cli-agent-key', 128), text(input.text, 'cli-task-text'),
        `cli:${requestId}`)
      return response({ kind: 'accepted', command: 'task', ...receipt })
    }
    case 'answer': {
      exact(input, ['protocolVersion', 'requestId', 'kind', 'agentKey', 'wait', 'text'])
      const wait = object(input.wait)
      exact(wait, ['eventId', 'index'])
      const waitEventId = eventId(wait.eventId, 'cli-wait-event')
      if (!Number.isSafeInteger(wait.index) || (wait.index as number) < 0) throw new HostError('HOST_PROTOCOL_INVALID', 'cli-wait-index')
      const receipt = await host.submitAnswer(text(input.agentKey, 'cli-agent-key', 128), { eventId: waitEventId, index: wait.index as number },
        text(input.text, 'cli-answer-text'), `cli:${requestId}`)
      return response({ kind: 'accepted', command: 'answer', ...receipt })
    }
    case 'pause':
    case 'resume': {
      exact(input, ['protocolVersion', 'requestId', 'kind', 'agentKey'])
      const agentKey = text(input.agentKey, 'cli-agent-key', 128)
      if (kind === 'pause') host.pause(agentKey); else host.resume(agentKey)
      return response({ kind: 'control', command: kind, agentKey })
    }
    case 'cancel': {
      exact(input, ['protocolVersion', 'requestId', 'kind', 'agentKey', 'rootTurnId'], ['reason'])
      const agentKey = text(input.agentKey, 'cli-agent-key', 128)
      await host.cancel(agentKey, eventId(input.rootTurnId, 'cli-root-event'),
        input.reason === undefined ? 'cli-cancelled' : text(input.reason, 'cli-cancel-reason', 128))
      return response({ kind: 'control', command: 'cancel', agentKey })
    }
    case 'report':
      exact(input, ['protocolVersion', 'requestId', 'kind'])
      return response({ kind: 'report', report: host.report() })
    case 'shutdown': {
      exact(input, ['protocolVersion', 'requestId', 'kind', 'mode'])
      if (input.mode !== 'drain' && input.mode !== 'cancel') throw new HostError('HOST_PROTOCOL_INVALID', 'cli-shutdown-mode')
      await host.shutdown({ mode: input.mode })
      return response({ kind: 'control', command: 'shutdown', mode: input.mode })
    }
    default:
      throw new HostError('HOST_PROTOCOL_INVALID', 'cli-command-kind')
  }
}

function diagnostic(error: unknown): unknown {
  if (error instanceof HarnessError) return error.toJSON()
  return { name: 'Error', code: 'HOST_INTERNAL_ERROR', message: 'host-command-failed' }
}

async function interactive(spec: ResolvedHostSpec, mode: 'run' | 'serve', io: HostCliIo): Promise<number> {
  const credentialRefs = new Set(spec.members.filter(isLocalHostMember).flatMap(member => member.model.kind === 'scripted-fixed' ? [] : [member.model.credentialRef]))
  const credentials = Object.fromEntries([...credentialRefs].flatMap(reference => {
    const value = process.env[reference]
    return value === undefined ? [] : [[reference, value]]
  }))
  const host = await openHost(spec, { credentials })
  const write = createJsonLineWriter(io.stdout, spec.cli.maxOutputBytes, spec.cli.outputDrainTimeoutMs)
  const controller = new AbortController()
  const acceptedRequestIds = new Set<string>()
  const stop = (): void => controller.abort()
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const driver = host.serve({ signal: controller.signal })
  try {
    await write({ protocolVersion: 1, kind: 'ready', hostKey: spec.hostKey, instanceId: host.instanceId, mode })
    for await (const command of boundedJsonLines(io.stdin, spec.cli.maxLineBytes)) {
      let requestId: string | undefined
      try {
        requestId = commandEnvelope(command).requestId
        if (acceptedRequestIds.has(requestId)) throw new HostError('HOST_PROTOCOL_INVALID', 'cli-request-id-duplicate')
        acceptedRequestIds.add(requestId)
        await write(await executeCommand(host, command))
      }
      catch (error) {
        if (requestId === undefined) try { requestId = commandEnvelope(command).requestId } catch { /* Invalid envelopes were never accepted. */ }
        await write({ protocolVersion: 1, kind: 'error', ...(requestId === undefined ? {} : { requestId }), error: diagnostic(error) })
      }
      if (host.status !== 'ready') break
    }
    if (mode === 'run' && host.status === 'ready') {
      controller.abort()
      await driver
      const report = await host.run()
      await write({ protocolVersion: 1, kind: 'complete', report })
      await host.shutdown({ mode: 'drain' })
      return report.members.some(member => member.readiness.counts.reviewRequiredInputs > 0 || member.readiness.counts.unsupportedInputs > 0) ? 10 : 0
    }
    if (mode === 'serve' && host.status === 'ready') {
      await driver
      if (host.status === 'ready') await host.shutdown({ mode: 'drain' })
    } else {
      controller.abort()
      await driver
    }
    return host.status === 'stopped' ? 0 : 1
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    if (host.status === 'ready') await host.shutdown({ mode: 'cancel' })
  }
}

/** Execute the side-effectful CLI adapter; importing Host modules remains inert. */
export async function runHostCli(args: readonly string[], io: HostCliIo): Promise<number> {
  const command = args[0] ?? 'help'
  if (command === 'help' || command === '--help' || command === '-h') { io.stdout.write(help); return 0 }
  if (command === 'version' || command === '--version' || command === '-v') { io.stdout.write(`${HARNESS_VERSION}\n`); return 0 }
  const configPath = option(args, '--config')
  if (configPath === undefined) throw new HostError('HOST_CONFIG_INVALID', 'config-path-required')
  if (command === 'unlock') {
    if (!flag(args, '--predecessor-stopped')) throw new HostError('HOST_CONFIG_INVALID', 'unlock-confirmation-required')
    const expectedToken = option(args, '--expected-token')
    if (expectedToken === undefined) throw new HostError('HOST_CONFIG_INVALID', 'unlock-token-required')
    const config = await loadConfig(configPath)
    await unlockHostStorage(config.storage.root, { predecessorStopped: true, expectedToken })
    io.stdout.write(`${JSON.stringify({ kind: 'unlocked', hostKey: config.hostKey })}\n`)
    return 0
  }
  const config = await loadConfig(configPath)
  if (command === 'plan') {
    io.stdout.write(`${JSON.stringify(planHostConfig(config))}\n`)
    return 0
  }
  const spec = resolveHostConfig(config)
  switch (command) {
    case 'check':
      io.stdout.write(`${JSON.stringify({ kind: 'checked', hostKey: spec.hostKey,
        members: spec.members.map(member => ({ agentKey: member.agentKey, sessionId: member.sessionId })) })}\n`)
      return 0
    case 'init':
      io.stdout.write(`${JSON.stringify({ kind: 'initialized', results: await initializeHost(spec, { resume: flag(args, '--resume') }) })}\n`)
      return 0
    case 'inspect':
      io.stdout.write(`${JSON.stringify({ kind: 'inspection', members: await inspectHost(spec) })}\n`)
      return 0
    case 'recover':
      if (!flag(args, '--predecessor-stopped')) throw new HostError('HOST_CONFIG_INVALID', 'recovery-confirmation-required')
      io.stdout.write(`${JSON.stringify({ kind: 'recovery', members: await recoverHost(spec, { predecessorStopped: true,
        maxRecoveryWrites: integerOption(args, '--max-recovery-writes'),
        maxJournalConflicts: integerOption(args, '--max-journal-conflicts') }) })}\n`)
      return 0
    case 'run':
    case 'serve':
      return await interactive(spec, command, io)
    default:
      throw new HostError('HOST_CONFIG_INVALID', 'unknown-command')
  }
}
