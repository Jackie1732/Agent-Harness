import { open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { HostCliIo } from '../host/cli.js'
import { HOST_CONFIG_LIMITS, parseHostConfig, resolveHostConfig, isLocalHostMember } from '../host/config.js'
import { HostError } from '../host/errors.js'
import { createJsonLineWriter } from '../host/cli-io.js'
import { parseApiConfig, resolveApiConfig } from './config.js'
import { openHarnessApiServer } from './server.js'

async function readConfig(path: string): Promise<string> {
  const file = await open(path, 'r')
  try {
    const bytes = Buffer.alloc(HOST_CONFIG_LIMITS.maxBytes + 1); let count = 0
    while (count < bytes.length) { const part = await file.read(bytes, count, bytes.length - count, null); if (part.bytesRead === 0) break; count += part.bytesRead }
    if (count > HOST_CONFIG_LIMITS.maxBytes) throw new HostError('HOST_CONFIG_INVALID', 'api-config-file-limit')
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)) }
    catch { throw new HostError('HOST_CONFIG_INVALID', 'api-config-utf8') }
  } finally { await file.close() }
}
/** Dedicated API CLI dispatch keeps the existing versioned JSONL command grammar unchanged. */
export async function runApiCli(args: readonly string[], io: HostCliIo): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h') { io.stdout.write('atomic-harness api --config <host.json> --api-config <api.json>\n'); return 0 }
  const flags = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1]
    if ((flag !== '--config' && flag !== '--api-config') || flags.has(flag) || value === undefined || value.startsWith('--')) throw new HostError('HOST_CONFIG_INVALID', 'api-options')
    flags.set(flag, value)
  }
  if (flags.size !== 2) throw new HostError('HOST_CONFIG_INVALID', 'api-config-required')
  const hostPath = resolve(flags.get('--config')!), apiPath = resolve(flags.get('--api-config')!)
  const [hostText, apiText] = await Promise.all([readConfig(hostPath), readConfig(apiPath)])
  const host = resolveHostConfig(parseHostConfig(hostText, dirname(hostPath)))
  const api = resolveApiConfig(parseApiConfig(apiText), host, dirname(apiPath))
  const refs = new Set(host.members.filter(isLocalHostMember).flatMap(member => member.model.kind === 'scripted-fixed' ? [] : [member.model.credentialRef]))
  if (host.schemaVersion !== 1 && host.subagents.kind === 'enabled') for (const template of host.subagents.templates) if (template.model.kind !== 'scripted-fixed') refs.add(template.model.credentialRef)
  const credentials = Object.fromEntries([...refs].flatMap(reference => process.env[reference] === undefined ? [] : [[reference, process.env[reference]!]]))
  const service = await openHarnessApiServer({ host, api: { ...api, protectedRoots: [...new Set([...api.protectedRoots, dirname(hostPath)])] }, credentials })
  let exitCode = 0
  const interrupt = (): void => { exitCode = 130; void service.dispose().catch(() => undefined) }
  const terminate = (): void => { exitCode = 143; void service.dispose().catch(() => undefined) }
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate)
  const writer = createJsonLineWriter(io.stdout, host.cli.maxOutputBytes, host.cli.outputDrainTimeoutMs)
  let failed = false, failure: unknown
  try {
    await writer(service.ready)
    await service.closed
  } catch (error) { failed = true; failure = error }
  finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate)
    const results = await Promise.allSettled([writer.dispose(), service.dispose()])
    if (!failed) for (const result of results) if (result.status === 'rejected') { failed = true; failure = result.reason; break }
  }
  if (failed) throw failure
  return exitCode
}
