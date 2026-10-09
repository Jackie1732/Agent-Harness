import { X509Certificate } from 'node:crypto'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHarnessClient } from '../client/client.js'
import { ApiError } from '../client/errors.js'
import { decodeHostConfig, HOST_CONFIG_LIMITS, isLocalHostMember, resolveHostConfig } from '../host/config.js'
import type { ResolvedHostSpec } from '../host/config.js'
import { openHost } from '../host/runtime.js'
import type { AtomicHost, HostShutdownMode } from '../host/runtime.js'
import { authorizeControl, localControlCaller } from '../control/authorization.js'
import { ControlAdmission, assertControlActivity } from '../control/admission.js'
import { dispatchControl } from '../control/dispatch.js'
import { controlFailure, ControlRejection } from '../control/errors.js'
import type { AnyControlOperation, ApplicationResult } from '../control/types.js'
import type { ControlMethod, Params } from '../protocol/index.js'
import { readConfigFile } from './config-files.js'
import type { ResolvedOperatorProfile } from './profile.js'
import type { Result } from '../protocol/index.js'

/** A connection owns transport or Host resources, not business state or operation receipts. */
export interface OperatorConnection {
  readonly certificateFingerprint: string | null
  readonly spec: ResolvedHostSpec | null
  readonly callerNamespace: string | null
  request<M extends ControlMethod>(method: M, params: Params<M>, signal?: AbortSignal): Promise<ApplicationResult<M>>
  close(mode?: HostShutdownMode): Promise<void>
}

/** Open exactly one owner. Creation of a remote client never accesses server storage. */
export async function openOperatorConnection(profile: ResolvedOperatorProfile,
  environment: Readonly<Record<string, string | undefined>>): Promise<OperatorConnection> {
  if (profile.connection.kind === 'remote') {
    const connection = profile.connection
    const [ca, cert, key] = await Promise.all([readFile(connection.tlsFiles.ca), readFile(connection.tlsFiles.cert), readFile(connection.tlsFiles.key)])
    const client = createHarnessClient({ origin: connection.origin, ...(connection.serverName === null ? {} : { serverName: connection.serverName }),
      tls: { ca, cert, key }, limits: connection.limits })
    return { certificateFingerprint: new X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase(), spec: null, callerNamespace: null,
      request: async <M extends ControlMethod>(method: M, params: Params<M>, signal?: AbortSignal) =>
        await client.request(method, params, signal === undefined ? {} : { signal }) as Result<M> & ApplicationResult<M>,
      close: () => client.close() }
  }
  const config = await readConfigFile(profile.connection.hostConfig, HOST_CONFIG_LIMITS)
  const spec = resolveHostConfig(decodeHostConfig(config.value, dirname(config.path)))
  const credentials = Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== undefined))
  await mkdir(profile.journal.root, { recursive: true })
  const host = await openHost(spec, { credentials, bindings: { protectedRoots: [...new Set([dirname(profile.profilePath), dirname(profile.connection.hostConfig),
    profile.journal.root, ...Object.values(profile.files).filter((path): path is string => path !== null).map(path => dirname(path))])] } })
  return localConnection(host, spec, profile)
}

function localConnection(host: AtomicHost, spec: ResolvedHostSpec, profile: ResolvedOperatorProfile): OperatorConnection {
  const caller = localControlCaller(spec, profile.profileKey), pending = new Set<Promise<unknown>>()
  const lifetime = new AbortController()
  const admission = new ControlAdmission({ maxPendingInputs: spec.cli.maxQueuedCommands, maxPendingControls: spec.cli.maxPendingControls,
    maxObservers: profile.observation.maxObservers, maxPendingShutdowns: 1 })
  const limits = { maxWaitMs: profile.observation.maxWaitMs, observerScanIntervalMs: profile.observation.scanIntervalMs,
    maxPageEvents: profile.observation.maxPageEvents, pageBytes: Math.min(profile.observation.maxPageBytes, profile.output.maxBytes) }
  let closing: Promise<void> | undefined
  const mode = profile.connection.kind === 'local' ? profile.connection.shutdownMode : 'drain'
  const close = (requested: HostShutdownMode = mode): Promise<void> => {
    if (closing !== undefined) { if (requested === 'cancel') void host.shutdown({ mode: 'cancel' }); return closing }
    lifetime.abort()
    closing = (async () => { try { await host.shutdown({ mode: requested }) } finally { await Promise.allSettled(pending) } })()
    return closing
  }
  const request = <M extends ControlMethod>(method: M, params: Params<M>, signal?: AbortSignal): Promise<ApplicationResult<M>> => {
    const operation = { method, params } as AnyControlOperation
    let invoked = false
    const progress = { domainReturned: false }
    const task = (async () => {
      try {
        if (closing !== undefined && method !== 'host.shutdown') throw new ControlRejection('API_INACTIVE')
        await authorizeControl(host, spec, caller, operation)
        if (closing !== undefined && method !== 'host.shutdown') throw new ControlRejection('API_INACTIVE')
        assertControlActivity(host, method)
        const execute = async () => { invoked = true
          return await dispatchControl(host, spec, caller, { method, params }, limits,
            signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal]), value => host.shutdown({ mode: value }), progress)
        }
        // The Host shares shutdown settlement; a second cancel can upgrade its existing drain.
        return method === 'host.shutdown' ? await execute() : await admission.run(method, execute)
      } catch (error) {
        const failure = controlFailure(error, method, invoked, progress.domainReturned)
        throw new ApiError(failure.code, failure.message, failure.acceptance, failure.domainCode)
      }
    })()
    pending.add(task); void task.then(() => pending.delete(task), () => pending.delete(task))
    return task
  }
  return { spec, callerNamespace: caller.namespace, certificateFingerprint: null, request, close }
}

/** Configured local targets are actual members; remote profile targets are navigation candidates only. */
export function connectionTargets(connection: OperatorConnection, profile: ResolvedOperatorProfile) {
  return connection.spec === null && profile.connection.kind === 'remote' ? profile.connection.targets
    : { agentKeys: connection.spec!.members.filter(isLocalHostMember).map(member => member.agentKey),
      workflowKeys: connection.spec!.schemaVersion === 3 && connection.spec!.workflows.kind === 'enabled'
        ? connection.spec!.workflows.definitions.map(entry => entry.definition.workflowKey) : [] }
}
