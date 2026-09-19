import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { EffectOwner } from '../effect/owner.js'
import type { Clock } from '../foundation/clock.js'
import { createSessionDirectory } from '../communication/directory.js'
import { CommunicationService } from '../communication/service.js'
import type { MessageTransport } from '../communication/transport.js'
import { createHttpsMessageClientTransport, createHttpsMessageServer } from '../communication/https-transport.js'
import { createRoutedMessageTransport } from '../communication/routed-transport.js'
import { FileSessionBackend } from '../session/file-backend.js'
import { SessionRepository } from '../session/repository.js'
import type { SessionHandle } from '../session/session-handle.js'
import { formatSessionAddress, parseSessionId } from '../session/ids.js'
import { isLocalHostMember } from './config.js'
import type { ResolvedHostSpec, ResolvedHostLocalMember } from './config.js'
import { HostError } from './errors.js'
import { validateHostMemberSession } from './binding.js'
import { hostRuntimeEventCatalog } from './initialization.js'
import { acquireHostStorageLock } from './storage-lock.js'
import { compileHostMessageCatalog } from './message-catalog.js'
import { createHostSlot } from './slot.js'
import type { HostRuntimeBindings } from './slot.js'
import type { HostSlot } from './runtime-types.js'
import { HostWakeup } from './wakeup.js'

/** Acquire dependencies in order; failed releases retain storage ownership. */
export async function assembleHost(spec: ResolvedHostSpec, clock: Clock,
  credentials: Readonly<Record<string, string>>, bindings: HostRuntimeBindings) {
  const owner = new EffectOwner(`host:${spec.hostKey}`)
  const wakeup = new HostWakeup()
  let unsafe = false
  const release = async (resource: { dispose(): Promise<void> }, dependent = false): Promise<void> => {
    if (dependent && unsafe) throw new HostError('HOST_CLEANUP_FAILED', 'dependency-retained')
    try { await resource.dispose() } catch (cause) { unsafe = true; throw cause }
  }
  try {
    const lease = await owner.run('Host assembly', async effect => {
      const https = spec.https.kind === 'mutual-tls' ? spec.https : undefined
      const tls = https !== undefined ? {
        ca: await readFile(https.caFile), serverCert: await readFile(https.serverCertFile),
        serverKey: await readFile(https.serverKeyFile), clientCert: await readFile(https.clientCertFile),
        clientKey: await readFile(https.clientKeyFile),
      } : undefined
      const lock = await effect.apply('storage ownership', () => acquireHostStorageLock(spec.storage.root, spec.hostKey), value => release(value, true))
      const repository = await effect.apply('repository', () => new SessionRepository({
        backend: new FileSessionBackend({ root: lock.root, maxRecordBytes: spec.storage.maxRecordBytes }),
        catalog: hostRuntimeEventCatalog, maxLineageDepth: spec.storage.maxLineageDepth, clock,
      }), value => release(value, true))
      const local: { member: ResolvedHostLocalMember; session: SessionHandle }[] = []
      for (const member of spec.members.filter(isLocalHostMember)) {
        const session = await repository.open(parseSessionId(member.sessionId))
        validateHostMemberSession(session, spec.hostKey, member, { allowEnded: !member.enabled })
        local.push({ member, session })
      }
      const directory = await effect.apply('directory', () => createSessionDirectory(), value => release(value, true))
      const remote = new Map<string, MessageTransport>()
      for (const route of spec.routes.filter(item => item.origin !== null)) {
        if (https === undefined || tls === undefined) throw new HostError('HOST_ROUTE_BLOCKED', 'https-required')
        const key = `${route.ownerHost}\u0000${route.origin}\u0000${route.serverName}`
        if (!remote.has(key)) remote.set(key, await effect.apply('HTTPS client', () => createHttpsMessageClientTransport({
          directory, origin: route.origin!, serverName: route.serverName!, hostKey: spec.hostKey,
          tls: { ca: tls.ca, cert: tls.clientCert, key: tls.clientKey }, limits: https!.limits,
        }), value => release(value)))
      }
      const routes = new Map(spec.routes.map(route => [formatSessionAddress(parseSessionId(route.sessionId)), route]))
      const transport = await effect.apply('router', () => createRoutedMessageTransport(directory, recipient => {
        const route = routes.get(recipient)
        if (route === undefined) return { kind: 'unavailable' }
        if (route.ownerHost === spec.hostKey && route.origin === null) return { kind: 'local' }
        const client = remote.get(`${route.ownerHost}\u0000${route.origin}\u0000${route.serverName}`)
        return client === undefined ? { kind: 'unavailable' } : { kind: 'remote', transport: client }
      }), value => release(value))
      const service = await effect.apply('communication', () => new CommunicationService({ directory, transport, limits: spec.communication, clock }), value => release(value, true))
      for (const { member, session } of local) await effect.apply('local declaration',
        () => directory.declare(formatSessionAddress(parseSessionId(member.sessionId)), session.snapshot().lifecycle), value => release(value, true))
      const protectedRoots = [lock.root, ...(bindings.protectedRoots ?? []), ...(https !== undefined
        ? [dirname(https.serverKeyFile), dirname(https.clientKeyFile)] : [])]
      const catalog = compileHostMessageCatalog(spec.messages)
      const slots: HostSlot[] = []
      const acquireSlot = async (member: typeof local[number]['member'], session: typeof local[number]['session']) => {
        const acquired = await owner.run('slot lifetime', context => context.apply('Agent slot', async () => {
          try { return await createHostSlot(session, member, service, catalog, clock, credentials, protectedRoots, bindings) }
          catch (cause) { if (cause instanceof HostError && cause.code === 'HOST_CLEANUP_FAILED') unsafe = true; throw cause }
        }, value => release(value)))
        return Object.freeze({ ...acquired.value, dispose: () => acquired.dispose() })
      }
      for (const { member, session } of local.filter(item => item.member.enabled)) {
        slots.push(await effect.apply('Agent slot', async () => {
          try { return await createHostSlot(session, member, service, catalog, clock, credentials, protectedRoots, bindings) }
          catch (cause) { if (cause instanceof HostError && cause.code === 'HOST_CLEANUP_FAILED') unsafe = true; throw cause }
        }, value => release(value)))
      }
      const server = https !== undefined && tls !== undefined ? await effect.apply('HTTPS listener',
        () => createHttpsMessageServer({ directory, host: https.listen.host,
          port: https.listen.port,
          tls: { ca: tls.ca, cert: tls.serverCert, key: tls.serverKey }, limits: https.limits, onAccepted: () => wakeup.notify(),
          peers: https.peers.map(peer => ({ hostKey: peer.hostKey,
            fingerprint256: peer.fingerprint256, senders: new Set(peer.sessionIds.map(id => formatSessionAddress(parseSessionId(id)))) })),
        }), value => release(value)) : undefined
      return { lock, directory, server, slots, wakeup, local, catalog,
        reopen: async (agentKey: string) => {
          const entry = local.find(item => item.member.agentKey === agentKey)
          if (entry === undefined) throw new HostError('HOST_NOT_READY', 'slot-unavailable')
          validateHostMemberSession(entry.session, spec.hostKey, entry.member)
          return await acquireSlot(entry.member, entry.session)
        },
        remoteRecipients: new Set(spec.routes.filter(route => route.origin !== null).map(route => formatSessionAddress(parseSessionId(route.sessionId)))) }
    })
    return Object.freeze({ ...lease.value, dispose: () => owner.dispose() })
  } catch (cause) {
    try { await owner.dispose() }
    catch (cleanup) { throw new HostError('HOST_CLEANUP_FAILED', 'host-assembly-rollback-incomplete', {}, { cause: new AggregateError([cause, cleanup]) }) }
    throw cause
  }
}

export type HostAssembly = Awaited<ReturnType<typeof assembleHost>>
