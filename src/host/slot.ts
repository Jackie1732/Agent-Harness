import { SessionAgent } from '../agent/session-agent.js'
import type { CommunicationService } from '../communication/service.js'
import type { MessageCatalog } from '../communication/message-catalog.js'
import { SessionContext } from '../context/session-context.js'
import type { Clock } from '../foundation/clock.js'
import { SessionModelRunner } from '../model/runner.js'
import type { ModelProvider } from '../model/contract.js'
import type { SessionHandle } from '../session/session-handle.js'
import type { ResolvedHostLocalMember } from './config.js'
import { HostError } from './errors.js'
import { createHostModelProvider } from './model-factory.js'
import type { HostSlot } from './runtime-types.js'
import { createHostTools } from './tool-factory.js'
import type { HostToolResources } from './tool-factory.js'
import { createHostCommunicationPolicy } from './communication-policy.js'

/** Assemble one isolated Agent slot after all local addresses are declared. */
export async function createHostSlot(
  session: SessionHandle,
  member: ResolvedHostLocalMember,
  service: CommunicationService,
  messageCatalog: MessageCatalog,
  clock: Clock,
  credentials: Readonly<Record<string, string>>,
  storageRoot: string,
): Promise<HostSlot> {
  let provider: ModelProvider | undefined
  let tools: HostToolResources | undefined
  let context: SessionContext | undefined
  let model: SessionModelRunner | undefined
  let mailbox: Awaited<ReturnType<CommunicationService['attach']>> | undefined
  try {
    provider = createHostModelProvider(member.model, credentials)
    tools = await createHostTools(session, member, storageRoot)
    context = new SessionContext({ session, messageCatalog,
      ...(tools === undefined ? {} : { toolRegistry: tools.registry }) })
    model = new SessionModelRunner({ session, provider, limits: member.model.runnerLimits })
    mailbox = await service.attach(session, { catalog: messageCatalog, policy: createHostCommunicationPolicy(member) })
    const dispatcher = service.createDispatcher(mailbox)
    const agent = new SessionAgent({ session, model, context, mailbox, messageCatalog, clock,
      ...(tools === undefined ? {} : { tools: tools.runner, scope: tools.scope }) })
    return Object.freeze({ member, session, mailbox, dispatcher, provider, agent,
      ...(tools === undefined ? {} : { tools }) })
  } catch (cause) {
    const cleanups = [mailbox?.dispose(), context?.dispose(), model?.dispose(), tools?.runner.dispose(),
      tools?.dispose(), provider?.dispose()].filter((task): task is Promise<void> => task !== undefined)
    const results = await Promise.allSettled(cleanups)
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason)
    if (failures.length > 0) throw new HostError('HOST_CLEANUP_FAILED', 'slot-acquisition-cleanup-failed', { agentKey: member.agentKey }, { cause: new AggregateError([cause, ...failures]) })
    throw cause
  }
}
