import { open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { HOST_CONFIG_LIMITS } from '../host/config.js'
import { HostError } from '../host/errors.js'
import type { HostCliIo } from '../host/cli.js'
import { createJsonLineWriter } from '../host/cli-io.js'
import { parseUiConfig, resolveUiConfig } from './config.js'
import { openHarnessUiServer } from './server.js'

/** Local browser gateway command; it never initializes or shuts down the remote Host. */
export async function runUiCli(args: readonly string[], io: HostCliIo): Promise<number> {
  if (args[0] === '--help' || args[0] === '-h') { io.stdout.write('atomic-harness ui --config <ui.json>\n'); return 0 }
  if (args.length !== 2 || args[0] !== '--config' || args[1] === undefined || args[1].startsWith('--')) throw new HostError('HOST_CONFIG_INVALID', 'ui-options')
  const path = resolve(args[1]), file = await open(path, 'r')
  let text: string
  try {
    const buffer = Buffer.alloc(HOST_CONFIG_LIMITS.maxBytes + 1); let count = 0
    while (count < buffer.length) { const part = await file.read(buffer, count, buffer.length - count, null); if (part.bytesRead === 0) break; count += part.bytesRead }
    if (count > HOST_CONFIG_LIMITS.maxBytes) throw new HostError('HOST_CONFIG_INVALID', 'ui-config-bytes')
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count)) }
    catch { throw new HostError('HOST_CONFIG_INVALID', 'ui-config-utf8') }
  } finally { await file.close() }
  const config = resolveUiConfig(parseUiConfig(text), dirname(path)), password = process.env[config.passwordEnv]
  if (password === undefined || password.length === 0) throw new HostError('HOST_CONFIG_INVALID', 'ui-password-required')
  const service = await openHarnessUiServer({ config, password })
  const writer = createJsonLineWriter(io.stdout, config.remote.limits.maxResponseBytes, config.limits.responseWriteTimeoutMs)
  let exitCode = 0
  // The shared service.closed observation below retains cleanup failures from signal requests.
  const interrupt = (): void => { exitCode = 130; void service.dispose().catch(() => undefined) }
  const terminate = (): void => { exitCode = 143; void service.dispose().catch(() => undefined) }
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate)
  let failed = false, failure: unknown
  try { await writer(service.ready); await service.closed }
  catch (error) { failed = true; failure = error }
  finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate)
    for (const result of await Promise.allSettled([writer.dispose(), service.dispose()])) if (!failed && result.status === 'rejected') { failed = true; failure = result.reason }
  }
  if (failed) throw failure
  return exitCode
}
