import { discoverHostDelegations } from './delegation-discovery.js'
import { WorkspaceAuthority } from '../subagent/workspace.js'
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
import type { HostSlot, HostProtocolSlot } from './runtime-types.js'
import { HostWakeup } from './wakeup.js'
import { HostSlotOwner } from './slot-owner.js'
import { HostSubagents } from './subagents.js'
import { subagentMessageDefinitions } from '../subagent/messages.js'

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
      const discovered = await discoverHostDelegations(spec, repository)
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
      const childAddresses = new Set<string>()
      const routes = new Map(spec.routes.map(route => [formatSessionAddress(parseSessionId(route.sessionId)), route]))
      const transport = await effect.apply('router', () => createRoutedMessageTransport(directory, recipient => {
        if (childAddresses.has(recipient)) return { kind: 'local' }
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
      const workspaces = spec.schemaVersion === 2 && spec.subagents.kind === 'enabled' ? await effect.apply('workspace authority',
        () => WorkspaceAuthority.create(spec.subagents.kind === 'enabled' ? spec.subagents.workspaceResources : [], local.flatMap(({ member }) => member.tools.kind === 'none' ? [] : [member.tools.rootPath]), protectedRoots, clock), value => release(value)) : undefined
      const catalog = compileHostMessageCatalog(spec.messages, spec.schemaVersion === 2 && spec.subagents.kind === 'enabled' ? subagentMessageDefinitions : [])
      const slots: HostSlot[] = []
      const protocolSlots: HostProtocolSlot[] = []
      const subagents = spec.schemaVersion === 2 && spec.subagents.kind === 'enabled' ? new HostSubagents({
        config: spec.subagents, repository, communication: service, catalog, clock, credentials, protectedRoots, bindings, slots, localMembers: local, protocolSlots, childAddresses, workspaces: workspaces!,
      }) : undefined
      const slotOwners = new Map<string, HostSlotOwner>()
      for (const { member, session } of local) {
        const lifetime = await effect.apply('member lifetime', () => new HostSlotOwner(member.agentKey, async () => {
          validateHostMemberSession(session, spec.hostKey, member)
          return await createHostSlot(session, member, service, catalog, clock, credentials, protectedRoots, bindings, { ...(subagents === undefined ? {} : { subagentActions: subagents.actions(member.agentKey, session) }),
            ...(member.tools.kind === 'none' || workspaces === undefined ? {} : { workspaceAccess: workspaces.staticAccess(member.tools.rootPath) }) })
        }), value => release(value))
        slotOwners.set(member.agentKey, lifetime)
      }
      if (subagents !== undefined) await effect.apply('subagents', () => subagents, value => release(value))
      if (subagents !== undefined) await subagents.restore(discovered, local)
      for (const { member } of local) if (member.enabled) slots.push(await slotOwners.get(member.agentKey)!.open())
      const server = https !== undefined && tls !== undefined ? await effect.apply('HTTPS listener',
        () => createHttpsMessageServer({ directory, host: https.listen.host,
          port: https.listen.port,
          tls: { ca: tls.ca, cert: tls.serverCert, key: tls.serverKey }, limits: https.limits, onAccepted: () => wakeup.notify(),
          peers: https.peers.map(peer => ({ hostKey: peer.hostKey,
            fingerprint256: peer.fingerprint256, senders: new Set(peer.sessionIds.map(id => formatSessionAddress(parseSessionId(id)))) })),
        }), value => release(value)) : undefined
      return { lock, directory, server, slots, protocolSlots, wakeup, local, catalog, subagents,
        reopen: async (agentKey: string) => {
          const lifetime = slotOwners.get(agentKey)
          if (lifetime === undefined) throw new HostError('HOST_NOT_READY', 'slot-unavailable')
          return await lifetime.open()
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
