import type { ResolvedHostSpec } from './config.js'
import { isLocalHostMember } from './config.js'
import type { HostCliIo } from './cli.js'
import { boundedJsonLines, createJsonLineWriter } from './cli-io.js'
import { commandEnvelope, executeCommand } from './cli-protocol.js'
import { hostDiagnostic, isHostUsageError } from './diagnostic.js'
import { HostError } from './errors.js'
import { openHost } from './runtime.js'
import type { HostRunReport } from './runtime-types.js'

/** Exit classification uses complete counts, never only the visible member prefix. */
export function hostExitCode(report: HostRunReport): number {
  const counts = report.counts
  if (report.blockedRoutes.length > 0 || counts.blockedMembers > 0 || counts.reviewRequiredInputs > 0 || counts.unsupportedInputs > 0 || counts.failedRoots > 0) return 11
  if (counts.exhaustedRoots > 0 || report.stoppedBy === 'batch-budget' && (counts.runnableInputs > 0 || counts.pendingMaintenance > 0 || counts.pendingOutbox > 0)) return 12
  if (counts.pendingInputs > 0 || counts.pendingWaits > 0 || counts.pendingOutbox > 0 || counts.pendingMaintenance > 0) return 10
  return 0
}

/** Own CLI streams, bounded command admission and signal subscriptions around one Host. */
export async function interactive(spec: ResolvedHostSpec, mode: 'run' | 'serve', io: HostCliIo, protectedRoots: readonly string[]): Promise<number> {
  const refs = new Set(spec.members.filter(isLocalHostMember).flatMap(member => member.model.kind === 'scripted-fixed' ? [] : [member.model.credentialRef]))
  const credentials = Object.fromEntries([...refs].flatMap(reference => process.env[reference] === undefined ? [] : [[reference, process.env[reference]!]]))
  const host = await openHost(spec, { credentials, bindings: { protectedRoots } })
  const write = createJsonLineWriter(io.stdout, spec.cli.maxOutputBytes, spec.cli.outputDrainTimeoutMs)
  let signalCode = 0
  let usageError = false
  let infrastructureError = false
  let driver: Promise<HostRunReport | undefined> | undefined
  const pending = new Set<Promise<void>>()
  const controls = new Set<Promise<void>>()
  const recent = new Set<string>()
  const inFlight = new Set<string>()
  let inputTail: Promise<unknown> = Promise.resolve()
  const shutdown = (mode: 'drain' | 'cancel'): void => {
    void host.shutdown({ mode }).then(() => io.stdin.destroy(), () => { infrastructureError = true; io.stdin.destroy() })
  }
  const interrupt = (): void => { signalCode = 130; io.stdin.destroy(); shutdown('cancel') }
  const terminate = (): void => { signalCode = 143; io.stdin.destroy(); shutdown('cancel') }
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate)
  try {
    await write({ protocolVersion: 1, kind: 'ready', hostKey: spec.hostKey, instanceId: host.instanceId, mode })
    if (mode === 'serve') driver = host.serve().catch(() => { infrastructureError = true; shutdown('cancel'); return undefined })
    try {
      for await (const command of boundedJsonLines(io.stdin, spec.cli.maxLineBytes, { recover: true })) {
        let requestId: string | undefined
        try {
          if (command instanceof HostError) throw command
          const envelope = commandEnvelope(command)
          requestId = envelope.requestId
          if (inFlight.has(requestId) || recent.has(requestId)) {
            usageError = true
            await write({ protocolVersion: 1, kind: 'error', error: hostDiagnostic(new HostError('HOST_PROTOCOL_INVALID', 'duplicate-request-id')) })
            continue
          }
          const control = ['cancel', 'shutdown', 'pause', 'resume', 'report'].includes(envelope.kind)
          const lane = control ? controls : pending
          const maximum = control ? spec.cli.maxPendingControls : spec.cli.maxQueuedCommands
          while (lane.size >= maximum) await Promise.race(lane)
          inFlight.add(requestId)
          const id = requestId
          const execute = () => executeCommand(host, command)
          const response = control ? Promise.resolve().then(execute) : inputTail.then(execute)
          if (!control) inputTail = response.catch(() => undefined)
          const task = response.then(value => write(value), error => {
            if (isHostUsageError(error)) usageError = true
            else { infrastructureError = true; shutdown(spec.shutdown.mode) }
            return write({ protocolVersion: 1, requestId: id, kind: 'error', error: hostDiagnostic(error) })
          }).catch(() => { infrastructureError = true; shutdown(spec.shutdown.mode) }).finally(() => {
            lane.delete(task); inFlight.delete(id); recent.add(id)
            // Request IDs are correlations, not durable or lifetime submission deduplication.
            if (recent.size > spec.cli.maxQueuedCommands + spec.cli.maxPendingControls) recent.delete(recent.values().next().value!)
            if (host.status === 'stopped' || host.status === 'failed') io.stdin.destroy()
          })
          lane.add(task)
        } catch (error) {
          usageError = true
          await write({ protocolVersion: 1, kind: 'error', ...(requestId === undefined ? {} : { requestId }), error: hostDiagnostic(error) })
        }
      }
    } catch (error) {
      if (host.status === 'ready' && signalCode === 0) throw error
    }
    await Promise.all([...pending, ...controls])
    let result = 0
    if (mode === 'run' && host.status === 'ready') {
      const report = await host.run()
      await write({ protocolVersion: 1, kind: 'complete', report })
      result = hostExitCode(report)
      await host.shutdown({ mode: 'drain' })
    } else if (driver !== undefined) await driver
    if (infrastructureError || host.status === 'failed') return 1
    if (signalCode !== 0) return signalCode
    return usageError ? 2 : result
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate)
    try { await host.shutdown() }
    finally { await write.dispose() }
  }
}
