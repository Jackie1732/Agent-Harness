import { HostWorkflows } from './workflows.js'
import { validateWorkflowCausality } from '../workflow/causality.js'
import { SessionWorkActions } from '../workflow/actions.js'
import { workflowMessageDefinitions } from '../workflow/messages.js'
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
import { projectHostWorkflowSession } from './workflow-binding.js'
import { scanHostInventory } from './inventory.js'
import { discoverHostWorkflows } from './workflow-discovery.js'
import type { CommunicationPolicy } from '../communication/types.js'

const workflowProtocolPolicy: CommunicationPolicy = Object.freeze({
  canSend: () => ({ kind: 'deny' as const, reasonCode: 'workflow-protocol-authority-required' }),
  canReceive: () => ({ kind: 'deny' as const, reasonCode: 'workflow-protocol-not-installed' }),
})

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
        validateHostMemberSession(session, spec.hostKey, member,
          { allowEnded: !member.enabled, bindingVersion: spec.schemaVersion === 3 ? 2 : 1 })
        local.push({ member, session })
      }
      const inventory = await scanHostInventory(spec, repository)
      discoverHostWorkflows(spec, inventory)
      if (spec.schemaVersion === 3) validateWorkflowCausality(inventory)
      const discovered = await discoverHostDelegations(spec, repository, inventory)
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
      const workflows = spec.schemaVersion === 3 && spec.workflows.kind === 'enabled' ? spec.workflows.definitions : []
      for (const entry of workflows) childAddresses.add(formatSessionAddress(parseSessionId(entry.sessionId)))
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
      const workspaceResources = spec.schemaVersion === 3 ? spec.workspaceResources
        : spec.schemaVersion === 2 && spec.subagents.kind === 'enabled' ? spec.subagents.workspaceResources : []
      const workspaces = spec.schemaVersion === 3 || spec.schemaVersion === 2 && spec.subagents.kind === 'enabled'
        ? await effect.apply('workspace authority',
          () => WorkspaceAuthority.create(workspaceResources, local.flatMap(({ member }) => member.tools.kind === 'none' ? [] : [member.tools.rootPath]), protectedRoots, clock), value => release(value)) : undefined
      const catalog = compileHostMessageCatalog(spec.messages, [...(spec.schemaVersion !== 1 && spec.subagents.kind === 'enabled' ? subagentMessageDefinitions : []), ...(workflows.length > 0 ? workflowMessageDefinitions : [])])
      const slots: HostSlot[] = []
      const protocolSlots: HostProtocolSlot[] = []
      const subagents = spec.schemaVersion !== 1 && spec.subagents.kind === 'enabled' ? new HostSubagents({
        config: spec.schemaVersion === 3 ? { ...spec.subagents, workspaceResources: spec.workspaceResources } : spec.subagents,
        repository, communication: service, catalog, clock, credentials, protectedRoots, bindings, slots, localMembers: local, protocolSlots, childAddresses, workspaces: workspaces!,
      }) : undefined
      for (const entry of workflows) {
        const session = await effect.apply('workflow session',
          () => repository.open(parseSessionId(entry.sessionId)), value => release(value, true))
        const binding = projectHostWorkflowSession(session.snapshot())
        if (binding.ready === null || binding.definition === null
          || binding.planned?.payload.hostKey !== spec.hostKey) throw new HostError('HOST_NOT_READY', 'workflow-binding-missing')
        await effect.apply('workflow declaration', () => directory.declare(session.header.address, session.snapshot().lifecycle), value => release(value, true))
        const mailbox = await effect.apply('workflow mailbox',
          () => service.attach(session, { catalog, policy: workflowProtocolPolicy }), value => release(value, true))
        protocolSlots.push({ member: { agentKey: `workflow:${binding.definition.payload.workflowKey}` }, session, mailbox,
          dispatcher: service.createDispatcher(mailbox) })
      }
      const slotOwners = new Map<string, HostSlotOwner>()
      for (const { member, session } of local) {
        const lifetime = await effect.apply('member lifetime', () => new HostSlotOwner(member.agentKey, async () => {
          validateHostMemberSession(session, spec.hostKey, member,
            { bindingVersion: spec.schemaVersion === 3 ? 2 : 1 })
          return await createHostSlot(session, member, service, catalog, clock, credentials, protectedRoots, bindings, { ...(subagents === undefined ? {} : { subagentActions: subagents.actions(member.agentKey, session) }),
            ...(workflows.length === 0 ? {} : { workActions: new SessionWorkActions(session, clock) }),
            ...(member.tools.kind === 'none' || workspaces === undefined ? {} : { workspaceAccess: workspaces.staticAccess(member.tools.rootPath) }) })
        }), value => release(value))
        slotOwners.set(member.agentKey, lifetime)
      }
      if (subagents !== undefined) await effect.apply('subagents', () => subagents, value => release(value))
      if (subagents !== undefined) await subagents.restore(discovered, local)
      for (const { member } of local) if (member.enabled) slots.push(await slotOwners.get(member.agentKey)!.open())
      const workflowDomain = workflows.length === 0 ? undefined : await effect.apply('workflows',
        () => new HostWorkflows(slots, protocolSlots.filter(slot => slot.member.agentKey.startsWith('workflow:')), service, clock, lock.record.instanceId, workspaces!, {
          notify: (memberKey, root) => subagents?.notifyParentStop(memberKey, root),
          cancel: async (memberKey, root) => { await subagents?.cancelParentWork(memberKey, root) },
          resume: (memberKey, root) => {
            if (subagents?.resume(memberKey, root).some(item => item.status === 'blocked')) throw new HostError('HOST_RECOVERY_REQUIRED', 'workflow-child-resume-blocked')
          },
        }, { maxBusinessConcurrency: spec.schemaVersion === 3 && spec.workflows.kind === 'enabled' ? spec.workflows.maxBusinessConcurrency : 1,
          customModelProvider: bindings.createModelProvider !== undefined }), value => release(value))
      await workflowDomain?.restore()
      const server = https !== undefined && tls !== undefined ? await effect.apply('HTTPS listener',
        () => createHttpsMessageServer({ directory, host: https.listen.host,
          port: https.listen.port,
          tls: { ca: tls.ca, cert: tls.serverCert, key: tls.serverKey }, limits: https.limits, onAccepted: () => wakeup.notify(),
          peers: https.peers.map(peer => ({ hostKey: peer.hostKey,
            fingerprint256: peer.fingerprint256, senders: new Set(peer.sessionIds.map(id => formatSessionAddress(parseSessionId(id)))) })),
        }), value => release(value)) : undefined
      return { lock, directory, server, slots, protocolSlots, wakeup, local, catalog, subagents, workflows: workflowDomain,
        release: (agentKey: string) => slotOwners.get(agentKey)!.release(),
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
