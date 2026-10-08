import { open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { HostCliIo } from '../host/cli.js'
import { createJsonLineWriter } from '../host/cli-io.js'
import { unlockHostStorage } from '../host/storage-lock.js'
import { AUTOMATION_CONFIG_LIMITS, parseAutomationConfig, resolveAutomationConfig } from './config.js'
import { openAutomationJournal } from './journal.js'
import { openHarnessAutomation } from './runtime.js'
import { AutomationError } from './validation.js'

const help = 'atomic-harness automate --config <automation.json> [--acknowledge-run-unknown <triggerKey> | --unlock --predecessor-stopped --expected-token <token>]\n'
async function readConfig(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    const bytes = Buffer.alloc(AUTOMATION_CONFIG_LIMITS.maxBytes + 1); let count = 0
    while (count < bytes.length) { const part = await file.read(bytes, count, bytes.length - count, null); if (part.bytesRead === 0) break; count += part.bytesRead }
    if (count > AUTOMATION_CONFIG_LIMITS.maxBytes) throw new AutomationError('AUTOMATION_CONFIG_INVALID')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))
  } finally { await file.close() }
}
/** CLI loads local configuration and secrets; acknowledgement never invokes the remote Host. */
export async function runAutomationCli(args: readonly string[], io: HostCliIo): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h') { io.stdout.write(help); return 0 }
  const flags = new Map<string, string | true>()
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!
    if (flags.has(flag) || !['--config', '--acknowledge-run-unknown', '--unlock', '--predecessor-stopped', '--expected-token'].includes(flag)) throw new AutomationError('AUTOMATION_CONFIG_INVALID')
    if (flag === '--unlock' || flag === '--predecessor-stopped') flags.set(flag, true)
    else { const value = args[++index]; if (value === undefined || value.startsWith('--')) throw new AutomationError('AUTOMATION_CONFIG_INVALID'); flags.set(flag, value) }
  }
  if (typeof flags.get('--config') !== 'string' || flags.has('--unlock') && flags.has('--acknowledge-run-unknown')
    || flags.has('--predecessor-stopped') !== flags.has('--unlock') || flags.has('--expected-token') !== flags.has('--unlock')) throw new AutomationError('AUTOMATION_CONFIG_INVALID')
  const path = resolve(flags.get('--config') as string), config = resolveAutomationConfig(parseAutomationConfig(await readConfig(path)), dirname(path))
  const writer = createJsonLineWriter(io.stdout, config.limits.maxResponseBytes, config.limits.responseWriteTimeoutMs)
  try {
    if (flags.has('--unlock')) {
      await unlockHostStorage(config.journal.root, { predecessorStopped: true, expectedToken: flags.get('--expected-token') as string })
      await writer({ kind: 'automation-unlocked', automationKey: config.automationKey }); return 0
    }
    if (flags.has('--acknowledge-run-unknown')) {
      const store = await openAutomationJournal(config)
      try {
        const triggerKey = flags.get('--acknowledge-run-unknown') as string, trigger = store.journal.get(triggerKey)
        if (trigger?.runIntent === null || trigger === undefined) throw new AutomationError('AUTOMATION_CONFLICT')
        const eventId = await store.journal.append({ kind: 'run-unknown-acknowledged', triggerKey, runIntent: trigger.runIntent })
        await writer({ kind: 'automation-run-unknown-acknowledged', triggerKey, journalEventId: eventId, runAcceptance: 'unknown' }); return 0
      } finally { await store.dispose() }
    }
    const token = process.env[config.webhook.bearerTokenEnv]
    if (token === undefined) throw new AutomationError('AUTOMATION_CONFIG_INVALID')
    const service = await openHarnessAutomation({ config, bearerToken: token, onNotice: notice => writer(notice) })
    let exitCode = 0
    const interrupt = (): void => { exitCode = 130; void service.dispose().catch(() => undefined) }
    const terminate = (): void => { exitCode = 143; void service.dispose().catch(() => undefined) }
    process.on('SIGINT', interrupt); process.on('SIGTERM', terminate)
    try { await writer(service.ready); await service.closed }
    finally { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); await service.dispose() }
    return exitCode
  } finally { await writer.dispose() }
}
