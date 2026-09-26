import { open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { HARNESS_VERSION } from '../version.js'
import { isLocalHostMember, parseHostConfig, planHostConfig, resolveHostConfig } from './config.js'
import { exportHostConfig } from './config-export.js'
import type { HostConfig } from './config.js'
import { HostError } from './errors.js'
import { initializeHost, adoptEmptyHostMember, adoptEmptyHostWorkflow } from './initialization.js'
import { decodeSessionHeader } from '../session/codec.js'
import { parseSessionEventId } from '../session/ids.js'
import type { SessionEventId } from '../session/ids.js'
import { parseBoundedJson } from '../schema/bounded-json.js'
import { createJsonLineWriter } from './cli-io.js'
import { inspectHost } from './inspection.js'
import { interactive } from './cli-interactive.js'
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
  adopt      explicitly bind existing Sessions configured with mode=adopt
  adopt-empty claim an exact empty Header with --agent-key or --workflow-key, --expected-header and --predecessor-stopped
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
  const handle = await open(path, 'r')
  try {
    const maximum = 2 * 1024 * 1024
    const bytes = Buffer.alloc(maximum + 1)
    let size = 0
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, null)
      if (result.bytesRead === 0) break
      size += result.bytesRead
    }
    if (size > maximum) throw new HostError('HOST_CONFIG_INVALID', 'config-file-too-large')
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)) }
    catch { throw new HostError('HOST_CONFIG_INVALID', 'config-utf8-invalid') }
    return parseHostConfig(text, dirname(path))
  } finally { await handle.close() }
}

/** Execute the side-effectful CLI adapter; importing Host modules remains inert. */
export async function runHostCli(args: readonly string[], io: HostCliIo): Promise<number> {
  const command = args[0] ?? 'help'
  if (command === 'help' || command === '--help' || command === '-h') { io.stdout.write(help); return 0 }
  if (command === 'version' || command === '--version' || command === '-v') { io.stdout.write(`${HARNESS_VERSION}\n`); return 0 }
  const booleanFlags = new Set(['--resume', '--predecessor-stopped'])
  const valueFlags = new Set(['--config', '--expected-token', '--max-recovery-writes', '--max-journal-conflicts', '--supersedes', '--agent-key', '--expected-header', '--protocol-version', '--workflow-key'])
  const seen = new Set<string>()
  for (let index = 1; index < args.length; index++) {
    const key = args[index]!
    if (seen.has(key) || !booleanFlags.has(key) && !valueFlags.has(key)) throw new HostError('HOST_CONFIG_INVALID', 'unknown-or-duplicate-option')
    seen.add(key)
    if (valueFlags.has(key)) { option(args, key); index++ }
  }
  const version = option(args, '--protocol-version') ?? '1'
  if (version !== '1' && version !== '2' && version !== '3') throw new HostError('HOST_CONFIG_INVALID', 'protocol-version')
  const protocolVersion = Number(version) as 1 | 2 | 3
  const write = async (value: unknown) => {
    const writer = createJsonLineWriter(io.stdout, 3 * 1024 * 1024)
    try { await writer(value) } finally { await writer.dispose() }
  }
  const configPath = option(args, '--config')
  if (configPath === undefined) throw new HostError('HOST_CONFIG_INVALID', 'config-path-required')
  if (command === 'unlock') {
    if (!flag(args, '--predecessor-stopped')) throw new HostError('HOST_CONFIG_INVALID', 'unlock-confirmation-required')
    const expectedToken = option(args, '--expected-token')
    if (expectedToken === undefined) throw new HostError('HOST_CONFIG_INVALID', 'unlock-token-required')
    const config = await loadConfig(configPath)
    await unlockHostStorage(config.storage.root, { predecessorStopped: true, expectedToken })
    await write({ protocolVersion, kind: 'unlocked', hostKey: config.hostKey })
    return 0
  }
  const config = await loadConfig(configPath)
  if (command === 'plan') {
    await write(planHostConfig(config))
    return 0
  }
  if (config.schemaVersion === 3 && protocolVersion !== 3) throw new HostError('HOST_PROTOCOL_INVALID', 'host-v3-requires-protocol-v3')
  const spec = resolveHostConfig(config)
  switch (command) {
    case 'check':
      await write({ protocolVersion, kind: 'checked', hostKey: spec.hostKey, ...exportHostConfig(spec) })
      return 0
    case 'init':
      await write({ protocolVersion, kind: 'initialized', results: await initializeHost(spec, { resume: flag(args, '--resume') }) })
      return 0
    case 'adopt':
      if (spec.members.filter(isLocalHostMember).some(member => member.mode !== 'adopt')) throw new HostError('HOST_CONFIG_INVALID', 'adopt-mode-required')
      await write({ protocolVersion, kind: 'adopted', results: await initializeHost(spec) })
      return 0
    case 'adopt-empty': {
      const agentKey = option(args, '--agent-key'), workflowKey = option(args, '--workflow-key'); const header = option(args, '--expected-header')
      if (!flag(args, '--predecessor-stopped') || (agentKey === undefined) === (workflowKey === undefined) || header === undefined || Buffer.byteLength(header) > 16384) throw new HostError('HOST_CONFIG_INVALID', 'adopt-empty-arguments')
      await write({ protocolVersion, kind: 'adopted-empty', result: workflowKey === undefined ? await adoptEmptyHostMember(spec, agentKey!,
        { predecessorStopped: true, expectedHeader: decodeSessionHeader(Buffer.from(header)) }) : await adoptEmptyHostWorkflow(spec, workflowKey,
        { predecessorStopped: true, expectedHeader: decodeSessionHeader(Buffer.from(header)) }) })
      return 0
    }
    case 'inspect':
      await write({ protocolVersion, kind: 'inspection', ...(protocolVersion === 1 ? { members: await inspectHost(spec) } : protocolVersion === 2 ? await inspectHost(spec, { protocolVersion: 2 }) : await inspectHost(spec, { protocolVersion: 3 })) })
      return 0
    case 'recover': {
      if (!flag(args, '--predecessor-stopped')) throw new HostError('HOST_CONFIG_INVALID', 'recovery-confirmation-required')
      const supersedes: Record<string, SessionEventId | null> = {}
      const raw = option(args, '--supersedes')
      if (raw !== undefined) {
        const parsed = parseBoundedJson(raw, { maxBytes: 65536, maxDepth: 2, maxNodes: 1024 })
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HostError('HOST_CONFIG_INVALID', 'supersedes-object')
        for (const [key, value] of Object.entries(parsed)) {
          if ((protocolVersion === 1 ? !spec.members.some(member => member.kind === 'local' && member.agentKey === key) : protocolVersion === 3 ? key.length > 256 : !/^[0-9a-f-]{36}:(agent|subagent:ah-event:[0-9a-f-]{36}:\d+)$/.test(key))
            || value !== null && typeof value !== 'string') throw new HostError('HOST_CONFIG_INVALID', 'supersedes-entry')
          if (value !== null) parseSessionEventId(value as string)
          supersedes[key] = value as SessionEventId | null
        }
      }
      const members = await recoverHost(spec, { predecessorStopped: true,
        ...(protocolVersion === 1 ? { supersedes } : { domainSupersedes: supersedes }),
        maxRecoveryWrites: integerOption(args, '--max-recovery-writes'),
        maxJournalConflicts: integerOption(args, '--max-journal-conflicts') })
      await write({ protocolVersion, kind: 'recovery', members })
      return protocolVersion === 3 && members.some(item => 'pending' in item.result && item.result.pending.length > 0) ? 10 : 0
    }
    case 'run':
    case 'serve':
      return await interactive(spec, command, io, [dirname(resolve(configPath))], protocolVersion)
    default:
      throw new HostError('HOST_CONFIG_INVALID', 'unknown-command')
  }
}
