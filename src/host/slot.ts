import { CapabilityRegistry } from '../capability/registry.js'
import { createCapabilityKey } from '../capability/key.js'
import { SessionAgent } from '../agent/session-agent.js'
import type { SessionAgentOptions } from '../agent/runtime-contract.js'
import type { CommunicationService } from '../communication/service.js'
import type { MessageCatalog } from '../communication/message-catalog.js'
import { SessionContext } from '../context/session-context.js'
import type { Clock } from '../foundation/clock.js'
import { canonicalJsonBytes } from '../foundation/canonical-json.js'
import { SessionModelRunner } from '../model/runner.js'
import type { ModelProvider } from '../model/contract.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { ResolvedHostLocalMember } from './config.js'
import { HostError } from './errors.js'
import { createHostModelProvider } from './model-factory.js'
import type { HostSlot } from './runtime-types.js'
import { createHostTools } from './tool-factory.js'
import { createHostCommunicationPolicy } from './communication-policy.js'

/** Explicit programmatic bindings stay outside saved configuration and durable recipes. */
export interface HostRuntimeBindings {
  readonly createModelProvider?: (member: ResolvedHostLocalMember) => ModelProvider | Promise<ModelProvider>
  readonly protectedRoots?: readonly string[]
}

/** Publish a slot only after its Provider and Agent activation Scopes are accepting. */
export async function createHostSlot(
  session: SessionHandle, member: ResolvedHostLocalMember, service: CommunicationService,
  messageCatalog: MessageCatalog, clock: Clock, credentials: Readonly<Record<string, string>>,
  protectedRoots: readonly string[], bindings: HostRuntimeBindings = {},
): Promise<HostSlot> {
  const registry = new CapabilityRegistry()
  const resourcesKey = createCapabilityKey<SessionAgentOptions>('host.slot.resources')
  const agentKey = createCapabilityKey<SessionAgent>('host.slot.agent')
  let transferred = false
  let modelReleaseFailed = false
  let assembled: HostSlot | undefined
  let resources: Omit<HostSlot, 'agent' | 'dispose'> | undefined
  try {
    const providers = registry.mount({ label: `providers:${member.agentKey}`, requires: [], provides: [resourcesKey], setup: async effect => {
      const provider = await effect.apply('model provider', () => bindings.createModelProvider?.(member)
        ?? createHostModelProvider(member.model, credentials), value => {
        if (modelReleaseFailed) throw new HostError('HOST_CLEANUP_FAILED', 'model-provider-retained')
        return value.dispose()
      })
      if (!Buffer.from(canonicalJsonBytes(provider.descriptor)).equals(Buffer.from(canonicalJsonBytes(member.spec.target.provider)))) {
        throw new HostError('HOST_BINDING_CONFLICT', 'provider-descriptor-mismatch', { agentKey: member.agentKey })
      }
      const tools = await effect.apply('tool providers', () => createHostTools(session, member, protectedRoots, effect.scope), async value => {
        if (value === undefined) return
        if (!transferred) await value.runner.dispose()
        await value.dispose()
      })
      const context = await effect.apply('context', () => new SessionContext({ session, messageCatalog,
        ...(tools === undefined ? {} : { toolRegistry: tools.registry }) }), value => transferred ? undefined : value.dispose())
      const model = await effect.apply('model runner', () => new SessionModelRunner({ session, provider, limits: member.model.runnerLimits }),
        async value => {
          if (transferred) return
          try { await value.dispose() } catch (cause) { modelReleaseFailed = true; throw cause }
        })
      const mailbox = await effect.apply('mailbox', () => service.attach(session, { catalog: messageCatalog,
        policy: createHostCommunicationPolicy(member) }), value => value.dispose())
      const dispatcher = service.createDispatcher(mailbox)
      resources = { member, session, mailbox, dispatcher, provider, ...(tools === undefined ? {} : { tools }) }
      effect.provide(resourcesKey, { session, model, context, mailbox, messageCatalog, clock,
        ...(tools === undefined ? {} : { tools: tools.runner }) })
    } })
    const consumer = registry.mount({ label: `agent:${member.agentKey}`, requires: [resourcesKey], provides: [agentKey], setup: async effect => {
      const configured = effect.require(resourcesKey)
      const agent = await effect.apply('Agent', () => {
        const value = new SessionAgent({ ...configured, scope: effect.scope })
        // Construction and handoff contain no await or external callback.
        transferred = true
        return value
      }, value => value.dispose())
      effect.provide(agentKey, agent)
      assembled = Object.freeze({ ...resources!, agent, dispose: () => registry.dispose() })
    } })
    await registry.whenQuiescent()
    if (providers.status !== 'active' || consumer.status !== 'active' || assembled === undefined) {
      throw providers.error ?? consumer.error ?? new HostError('HOST_NOT_READY', 'slot-not-published')
    }
    return assembled
  } catch (cause) {
    try { await registry.dispose() }
    catch (cleanup) { throw new HostError('HOST_CLEANUP_FAILED', 'slot-acquisition-cleanup-failed', { agentKey: member.agentKey }, { cause: new AggregateError([cause, cleanup]) }) }
    throw cause
  }
}
